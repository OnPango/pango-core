import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { localToday } from '../demand/demand.service.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  forecastDailyDemand,
  loadSettings,
  loadStockPositions,
  round,
  type StockPosition,
  stockValue,
  type Tenant,
} from './dashboard-data.js';
import {
  inFilter,
  readableWarehouses,
  type WarehouseFilter,
} from './dashboard-scope.js';
import type { DashboardQueryDto } from './dto.js';
import type {
  DashboardInventoryDto,
  ExcessBlockDto,
  ExpiringBlockDto,
  IdleBlockDto,
  InventoryValueDto,
} from './responses.js';

/** Items of each list. */
export const INVENTORY_LIST_SIZE = 10;
/** Without a max stock, more than these weeks of forecast demand is excess. */
export const EXCESS_FORECAST_WEEKS = 12;
/** Stock that has not left its warehouse in these days is idle. */
export const IDLE_DAYS = 90;
/** Lots expiring within these days (and expired ones) are listed. */
export const EXPIRY_DAYS = 30;

const productOf = (p: StockPosition) => ({
  id: p.productId,
  sku: p.sku,
  name: p.name,
  unit: p.unit,
});
const warehouseOf = (p: StockPosition) => ({
  id: p.warehouseId,
  name: p.warehouseName,
});

/** Top-level category of each category (the "family" of the inventory value). */
export function familyRoots(
  categories: { id: number; parentId: number | null }[],
): Map<number, number> {
  const parent = new Map(categories.map((c) => [c.id, c.parentId]));
  const roots = new Map<number, number>();
  for (const { id } of categories) {
    let current = id;
    for (let depth = 0; depth < 100; depth++) {
      const up = parent.get(current);
      if (up === null || up === undefined) break;
      current = up;
    }
    roots.set(id, current);
  }
  return roots;
}

// US-047, inventory tab: what the stock is worth and where it is stuck. Needs
// `stock.read`; every figure covers the warehouses where the user holds it.
@Injectable()
export class DashboardInventoryService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async inventory(
    auth: AuthContext,
    query: DashboardQueryDto,
  ): Promise<DashboardInventoryDto> {
    const tenant = this.tenants.client(auth.organization.schemaName);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const { timeZone, currency } = await loadSettings(tenant);
    // The guard already required `stock.read`, so it is never false here.
    const readable = readableWarehouses(auth, 'stock.read', query.warehouseId);
    const warehouses = readable === false ? [] : readable;

    const [positions, categories, movementDates, expiringLots] =
      await Promise.all([
        loadStockPositions(tenant, schema, warehouses),
        tenant.category.findMany({
          select: { id: true, parentId: true, name: true },
        }),
        this.movementDates(tenant, schema, warehouses),
        this.expiringLots(tenant, schema, warehouses, localToday(timeZone)),
      ]);
    const withStock = positions.filter((p) => p.onHand > 0);
    const daily = await forecastDailyDemand(
      tenant,
      schema,
      withStock
        .filter((p) => p.maxStock === null)
        .map((p) => p.productWarehouseId),
    );

    return {
      currency,
      value: this.value(withStock, categories),
      excess: this.excess(withStock, daily),
      idle: this.idle(withStock, movementDates),
      expiringLots,
    };
  }

  private value(
    positions: StockPosition[],
    categories: { id: number; parentId: number | null; name: string }[],
  ): InventoryValueDto {
    const roots = familyRoots(categories);
    const names = new Map(categories.map((c) => [c.id, c.name]));
    const byFamily = new Map<number, { value: number; items: number }>();
    for (const p of positions) {
      const family = roots.get(p.categoryId) ?? p.categoryId;
      const entry = byFamily.get(family) ?? { value: 0, items: 0 };
      entry.value += stockValue(p);
      entry.items += 1;
      byFamily.set(family, entry);
    }
    return {
      total: round(
        positions.reduce((sum, p) => sum + stockValue(p), 0),
        2,
      ),
      byFamily: [...byFamily.entries()]
        .map(([familyId, entry]) => ({
          familyId,
          name: names.get(familyId) ?? '',
          value: round(entry.value, 2),
          items: entry.items,
        }))
        .sort((a, b) => b.value - a.value),
    };
  }

  /** Available above the max stock or, without one, above 12 weeks of forecast. */
  private excess(
    positions: StockPosition[],
    daily: Map<number, number>,
  ): ExcessBlockDto {
    const items = positions.flatMap((p) => {
      if (!p.isActive) return [];
      const forecast = daily.get(p.productWarehouseId);
      const limit =
        p.maxStock !== null
          ? { limit: p.maxStock, limitSource: 'MAX_STOCK' as const }
          : forecast !== undefined && forecast > 0
            ? {
                limit: round(forecast * EXCESS_FORECAST_WEEKS * 7),
                limitSource: 'FORECAST' as const,
              }
            : null;
      if (!limit || p.available <= limit.limit) return [];
      const excess = round(p.available - limit.limit);
      return [
        {
          product: productOf(p),
          warehouse: warehouseOf(p),
          available: p.available,
          ...limit,
          excess,
          value: round(excess * p.averageCost, 2),
        },
      ];
    });
    items.sort((a, b) => b.value - a.value);
    return {
      items: items.slice(0, INVENTORY_LIST_SIZE),
      total: items.length,
      value: round(
        items.reduce((sum, i) => sum + i.value, 0),
        2,
      ),
    };
  }

  /**
   * Stock that arrived before the window and has not left the warehouse within
   * it (sales, consumption, transfers out). Recent arrivals are not idle yet.
   */
  private idle(
    positions: StockPosition[],
    dates: Map<string, { firstAt: Date; lastOutAt: Date | null }>,
  ): IdleBlockDto {
    const since = new Date(Date.now() - IDLE_DAYS * 86_400_000);
    const items = positions.flatMap((p) => {
      const seen = dates.get(`${p.productId}:${p.warehouseId}`);
      if (!seen || seen.firstAt >= since) return [];
      if (seen.lastOutAt && seen.lastOutAt >= since) return [];
      return [
        {
          product: productOf(p),
          warehouse: warehouseOf(p),
          onHand: p.onHand,
          value: stockValue(p),
          lastOutboundAt: seen.lastOutAt,
        },
      ];
    });
    items.sort((a, b) => b.value - a.value);
    return {
      days: IDLE_DAYS,
      items: items.slice(0, INVENTORY_LIST_SIZE),
      total: items.length,
      value: round(
        items.reduce((sum, i) => sum + i.value, 0),
        2,
      ),
    };
  }

  /**
   * Per product and warehouse: the first confirmed movement, and the last time
   * stock left (an outbound movement, or a transfer from there).
   */
  private async movementDates(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
  ): Promise<Map<string, { firstAt: Date; lastOutAt: Date | null }>> {
    const rows = await tenant.$queryRawUnsafe<
      {
        productId: number;
        warehouseId: number;
        firstAt: Date;
        lastOutAt: Date | null;
      }[]
    >(
      `WITH touches AS (
         SELECT l."product_id", lo."warehouse_id", m."occurred_at",
                t."nature" IN ('OUTBOUND', 'TRANSFER') AS "isOut"
           FROM "${schema}"."movement_lines" l
           JOIN "${schema}"."movements" m ON m."id" = l."movement_id"
           JOIN "${schema}"."movement_types" t ON t."id" = m."movement_type_id"
           JOIN "${schema}"."locations" lo ON lo."id" = l."origin_location_id"
          WHERE m."status" IN ('CONFIRMED', 'IN_TRANSIT')
         UNION ALL
         SELECT l."product_id", ld."warehouse_id", m."occurred_at", false
           FROM "${schema}"."movement_lines" l
           JOIN "${schema}"."movements" m ON m."id" = l."movement_id"
           JOIN "${schema}"."locations" ld ON ld."id" = l."destination_location_id"
          WHERE m."status" = 'CONFIRMED'
       )
       SELECT "product_id" AS "productId", "warehouse_id" AS "warehouseId",
              MIN("occurred_at") AS "firstAt",
              MAX("occurred_at") FILTER (WHERE "isOut") AS "lastOutAt"
         FROM touches
        WHERE ${inFilter('"warehouse_id"', 1)}
        GROUP BY 1, 2`,
      warehouses,
    );
    return new Map(
      rows.map((r) => [
        `${r.productId}:${r.warehouseId}`,
        { firstAt: r.firstAt, lastOutAt: r.lastOutAt },
      ]),
    );
  }

  /** Lots with stock that expire within the window, or already expired. */
  private async expiringLots(
    tenant: Tenant,
    schema: string,
    warehouses: WarehouseFilter,
    today: string,
  ): Promise<ExpiringBlockDto> {
    const rows = await tenant.$queryRawUnsafe<
      {
        productId: number;
        sku: string;
        name: string;
        unit: string;
        warehouseId: number;
        warehouseName: string;
        lot: string;
        expiryDate: string;
        onHand: number;
      }[]
    >(
      `SELECT p."id" AS "productId", p."sku", p."name", u."code" AS "unit",
              w."id" AS "warehouseId", w."name" AS "warehouseName",
              lt."code" AS "lot", to_char(lt."expiry_date", 'YYYY-MM-DD') AS "expiryDate",
              SUM(sb."quantity")::float8 AS "onHand"
         FROM "${schema}"."stock_balances" sb
         JOIN "${schema}"."lots" lt ON lt."id" = sb."lot_id"
         JOIN "${schema}"."product_warehouses" pw ON pw."id" = sb."product_warehouse_id"
         JOIN "${schema}"."products" p ON p."id" = pw."product_id"
         JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
         JOIN "${schema}"."warehouses" w ON w."id" = pw."warehouse_id"
        WHERE lt."expiry_date" IS NOT NULL
          AND lt."expiry_date" <= $2::date + ${EXPIRY_DAYS}
          AND ${inFilter('pw."warehouse_id"', 1)}
        GROUP BY p."id", u."code", w."id", lt."id"
       HAVING SUM(sb."quantity") > 0
        ORDER BY lt."expiry_date", p."name", w."name"`,
      warehouses,
      today,
    );
    return {
      days: EXPIRY_DAYS,
      total: rows.length,
      items: rows.slice(0, INVENTORY_LIST_SIZE).map((r) => ({
        product: { id: r.productId, sku: r.sku, name: r.name, unit: r.unit },
        warehouse: { id: r.warehouseId, name: r.warehouseName },
        lot: r.lot,
        expiryDate: r.expiryDate,
        onHand: r.onHand,
        expired: r.expiryDate < today,
      })),
    };
  }
}
