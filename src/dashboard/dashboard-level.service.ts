import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { localToday, periodStart } from '../demand/demand.service.js';
import { GranularityValue } from '../demand/dto.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import {
  loadSettings,
  loadStockPositions,
  type NetMovement,
  netMovementsSince,
} from './dashboard-data.js';
import { inFilter, readableWarehouses } from './dashboard-scope.js';
import { type DashboardLevelQueryDto, LEVEL_DEFAULT_DAYS } from './dto.js';
import type { DashboardLevelDto, LevelPointDto } from './responses.js';

const DAY_MS = 86_400_000;
const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, days: number) =>
  toDay(new Date(toDate(day).getTime() + days * DAY_MS));

/**
 * The periods of the chart, oldest first: one per day for 7 and 30 days, one per
 * week (Monday to Sunday) for 90. The last one ends today.
 */
export function levelBuckets(
  today: string,
  days: number,
): { start: string; end: string }[] {
  if (days <= 30) {
    return Array.from({ length: days }, (_, i) => {
      const day = addDays(today, i - (days - 1));
      return { start: day, end: day };
    });
  }
  const weeks = Math.ceil(days / 7);
  const thisMonday = periodStart(today, GranularityValue.WEEKLY);
  return Array.from({ length: weeks }, (_, i) => {
    const start = addDays(thisMonday, (i - (weeks - 1)) * 7);
    const end = addDays(start, 6);
    return { start, end: end > today ? today : end };
  });
}

/**
 * At the end of each period: products with stock and products in low stock (an
 * alert in force), each product counted once across the warehouses. A product in
 * low stock in any warehouse is not counted again as "in stock". Keys are
 * `productId:warehouseId`.
 */
export function levelPoints(
  buckets: { start: string; end: string }[],
  onHand: Map<string, number>,
  net: NetMovement[],
  alerts:
    { key: string; createdDay: string; resolvedDay: string | null }[] | null,
): LevelPointDto[] {
  const productOf = (key: string) => key.split(':')[0];
  return buckets.map(({ start, end }) => {
    const after = new Map<string, number>();
    for (const row of net) {
      if (row.day <= end) continue;
      const key = `${row.productId}:${row.warehouseId}`;
      after.set(key, (after.get(key) ?? 0) + row.net);
    }
    const low = new Set(
      (alerts ?? [])
        .filter(
          (a) =>
            a.createdDay <= end &&
            (a.resolvedDay === null || a.resolvedDay > end),
        )
        .map((a) => productOf(a.key)),
    );
    const withStock = new Set<string>();
    for (const [key, now] of onHand) {
      if (now - (after.get(key) ?? 0) > 0) withStock.add(productOf(key));
    }
    let inStock = 0;
    for (const product of withStock) if (!low.has(product)) inStock += 1;
    return { start, end, inStock, lowStock: alerts ? low.size : null };
  });
}

// US-047, "Nivel de inventario": how many products had stock, and how many were
// in low stock, over the last days. Past stock is rebuilt from today's balances
// and the movements since. Needs `stock.read`; low stock also `alert.read`.
@Injectable()
export class DashboardLevelService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async level(
    auth: AuthContext,
    query: DashboardLevelQueryDto,
  ): Promise<DashboardLevelDto> {
    const tenant = this.tenants.client(auth.organization.schemaName);
    const schema = assertTenantSchema(auth.organization.schemaName);
    const { timeZone } = await loadSettings(tenant);
    const days = query.days ?? LEVEL_DEFAULT_DAYS;
    const readable = readableWarehouses(auth, 'stock.read', query.warehouseId);
    const warehouses = readable === false ? [] : readable;
    const alertScope = readableWarehouses(
      auth,
      'alert.read',
      query.warehouseId,
    );
    const buckets = levelBuckets(localToday(timeZone), days);
    // A day early: the time zone shifts the first local day's start.
    const since = new Date(toDate(buckets[0].start).getTime() - DAY_MS);

    const [positions, net, alerts] = await Promise.all([
      loadStockPositions(tenant, schema, warehouses),
      netMovementsSince(tenant, schema, warehouses, since, timeZone),
      alertScope === false
        ? null
        : tenant.$queryRawUnsafe<
            { key: string; createdDay: string; resolvedDay: string | null }[]
          >(
            `SELECT pw."product_id" || ':' || pw."warehouse_id" AS "key",
                    to_char(a."created_at" AT TIME ZONE $3, 'YYYY-MM-DD') AS "createdDay",
                    to_char(a."resolved_at" AT TIME ZONE $3, 'YYYY-MM-DD') AS "resolvedDay"
               FROM "${schema}"."alerts" a
               JOIN "${schema}"."product_warehouses" pw ON pw."id" = a."product_warehouse_id"
              WHERE a."type" = 'BELOW_ROP'
                AND (a."resolved_at" IS NULL OR a."resolved_at" >= $2)
                AND ${inFilter('pw."warehouse_id"', 1)}`,
            alertScope,
            since,
            timeZone,
          ),
    ]);
    const onHand = new Map(
      positions.map((p) => [`${p.productId}:${p.warehouseId}`, p.onHand]),
    );
    return {
      days,
      granularity: days <= 30 ? 'DAY' : 'WEEK',
      points: levelPoints(buckets, onHand, net, alerts),
    };
  }
}
