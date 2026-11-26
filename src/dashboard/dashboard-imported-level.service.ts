import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { localToday } from '../demand/demand.service.js';
import { pangoStartSql } from '../movement-imports/history-sql.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import { loadSettings } from './dashboard-data.js';
import { levelBuckets } from './dashboard-level.service.js';
import { inFilter, readableWarehouses } from './dashboard-scope.js';
import { type DashboardLevelQueryDto, LEVEL_DEFAULT_DAYS } from './dto.js';
import type { ImportedLevelDto, LevelPointDto } from './responses.js';

/** The imported closing balance of a product in a warehouse at the end of a day. */
export interface ImportedClosing {
  /** `productId:warehouseId`. */
  key: string;
  day: string;
  closing: number;
}

/**
 * At the end of each period, from the imported history only: products with stock
 * and products at or below their reorder point, each product counted once across
 * the warehouses (as `levelPoints`). A product-warehouse counts with the last
 * closing on or before the period's end, and only before its first Pango movement
 * (`cutover`): from that day on the Pango level counts it, so nothing is counted
 * twice. A product-warehouse that never moved in Pango is cut over when its
 * warehouse started in Pango: from then on its Pango stock (none) and alerts are
 * the current ones. Low stock compares with today's reorder point: the history carries no
 * alerts. `closings` must be sorted by day within each key.
 */
export function importedLevelPoints(
  buckets: { start: string; end: string }[],
  closings: ImportedClosing[],
  cutover: (key: string) => string | undefined,
  reorderPoint: Map<string, number>,
  withLowStock: boolean,
): LevelPointDto[] {
  const byKey = new Map<string, ImportedClosing[]>();
  for (const row of closings) {
    const rows = byKey.get(row.key) ?? [];
    rows.push(row);
    byKey.set(row.key, rows);
  }
  const productOf = (key: string) => key.split(':')[0];

  return buckets.map(({ start, end }) => {
    const withStock = new Set<string>();
    const low = new Set<string>();
    for (const [key, rows] of byKey) {
      const firstPangoDay = cutover(key);
      if (firstPangoDay !== undefined && end >= firstPangoDay) continue;
      let last: number | undefined;
      for (const row of rows) {
        if (row.day > end) break;
        last = row.closing;
      }
      if (last === undefined) continue;
      const rop = reorderPoint.get(key) ?? 0;
      if (withLowStock && rop > 0 && last <= rop) low.add(productOf(key));
      if (last > 0) withStock.add(productOf(key));
    }
    let inStock = 0;
    for (const product of withStock) if (!low.has(product)) inStock += 1;
    return { start, end, inStock, lowStock: withLowStock ? low.size : null };
  });
}

/**
 * The day each product-warehouse started in Pango: its first Pango movement or,
 * when it never moved there, the first Pango movement of its warehouse.
 */
export function cutoverOf(
  starts: { productId: number; warehouseId: number; day: string }[],
): (key: string) => string | undefined {
  const byPair = new Map<string, string>();
  const byWarehouse = new Map<string, string>();
  for (const { productId, warehouseId, day } of starts) {
    byPair.set(`${productId}:${warehouseId}`, day);
    const first = byWarehouse.get(String(warehouseId));
    if (first === undefined || day < first) {
      byWarehouse.set(String(warehouseId), day);
    }
  }
  return (key) => byPair.get(key) ?? byWarehouse.get(key.split(':')[1]);
}

// The dashboard's "Nivel de inventario" from the imported history (CU-17): the
// same periods as the Pango level, for the product-warehouses that had not
// started moving in Pango yet. Needs `stock.read`; low stock also `alert.read`.
@Injectable()
export class DashboardImportedLevelService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async level(
    auth: AuthContext,
    query: DashboardLevelQueryDto,
  ): Promise<ImportedLevelDto> {
    const tenant = this.tenants.client(auth.organization.schemaName);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const { timeZone } = await loadSettings(tenant);
    const days = query.days ?? LEVEL_DEFAULT_DAYS;
    const readable = readableWarehouses(auth, 'stock.read', query.warehouseId);
    const warehouses = readable === false ? [] : readable;
    const withLowStock =
      readableWarehouses(auth, 'alert.read', query.warehouseId) !== false;
    const buckets = levelBuckets(localToday(timeZone), days);
    const lastDay = buckets.at(-1)!.end;

    const firstDay = buckets[0].start;
    const [closings, cutovers, reorderPoints, latest] = await Promise.all([
      // The closing of each imported day inside the window (the last line of the
      // day, latest import), plus each product-warehouse's last closing before it.
      tenant.$queryRawUnsafe<{ key: string; day: string; closing: string }[]>(
        `WITH daily AS (
           SELECT DISTINCT ON (h."product_id", h."warehouse_id", h."business_date")
                  h."product_id", h."warehouse_id", h."business_date",
                  h."running_balance"
             FROM "${schema}"."historical_movements" h
            WHERE h."running_balance" IS NOT NULL
              AND h."business_date" <= $3::date
              AND ${inFilter('h."warehouse_id"', 1)}
            ORDER BY h."product_id", h."warehouse_id", h."business_date",
                     h."import_id" DESC, h."source_row_number" DESC
         ), before AS (
           SELECT DISTINCT ON ("product_id", "warehouse_id") *
             FROM daily
            WHERE "business_date" < $2::date
            ORDER BY "product_id", "warehouse_id", "business_date" DESC
         )
         SELECT "product_id" || ':' || "warehouse_id" AS "key",
                to_char("business_date", 'YYYY-MM-DD') AS "day",
                "running_balance"::text AS "closing"
           FROM (SELECT * FROM before
                 UNION ALL
                 SELECT * FROM daily WHERE "business_date" >= $2::date) c
          ORDER BY "product_id", "warehouse_id", "business_date"`,
        warehouses,
        firstDay,
        lastDay,
      ),
      tenant.$queryRawUnsafe<
        { productId: number; warehouseId: number; day: string }[]
      >(
        `SELECT s."product_id" AS "productId", s."warehouse_id" AS "warehouseId",
                to_char(s."day", 'YYYY-MM-DD') AS "day"
           FROM (${pangoStartSql(schema, '$2')}) s
          WHERE ${inFilter('s."warehouse_id"', 1)}`,
        warehouses,
        timeZone,
      ),
      tenant.$queryRawUnsafe<{ key: string; reorderPoint: string }[]>(
        `SELECT pw."product_id" || ':' || pw."warehouse_id" AS "key",
                pw."reorder_point"::text AS "reorderPoint"
           FROM "${schema}"."product_warehouses" pw
          WHERE ${inFilter('pw."warehouse_id"', 1)}`,
        warehouses,
      ),
      tenant.$queryRawUnsafe<{ day: string | null }[]>(
        `SELECT to_char(MAX(h."business_date"), 'YYYY-MM-DD') AS "day"
           FROM "${schema}"."historical_movements" h
          WHERE ${inFilter('h."warehouse_id"', 1)}`,
        warehouses,
      ),
    ]);

    return {
      days,
      granularity: days <= 30 ? 'DAY' : 'WEEK',
      lastImportedDay: latest[0]?.day ?? null,
      points: importedLevelPoints(
        buckets,
        closings.map((r) => ({
          key: r.key,
          day: r.day,
          closing: Number(r.closing),
        })),
        cutoverOf(cutovers),
        new Map(reorderPoints.map((r) => [r.key, Number(r.reorderPoint)])),
        withLowStock,
      ),
    };
  }
}
