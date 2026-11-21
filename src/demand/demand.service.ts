import { Injectable } from '@nestjs/common';
import {
  type AuthContext,
  permissionsInWarehouse,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import { Prisma } from '../generated/prisma/tenant/client.js';
import { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { assertTenantSchema } from '../prisma/tenant-schema.js';
import { demandErrors } from './demand-errors.js';
import { demandCondition } from './demand-rule.js';
import { type DemandQueryDto, GranularityValue } from './dto.js';
import type { DemandSeriesDto } from './responses.js';

/** About ten years of weeks. */
export const MAX_PERIODS = 520;

const toDate = (day: string) => new Date(`${day}T00:00:00Z`);
const toDay = (date: Date) => date.toISOString().slice(0, 10);

/** First day of the period that contains `day` (weeks start on Monday). */
export function periodStart(
  day: string,
  granularity: GranularityValue,
): string {
  if (granularity === GranularityValue.MONTHLY) return `${day.slice(0, 7)}-01`;
  const date = toDate(day);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return toDay(date);
}

/** First day of the period after the one starting on `start`. */
export function nextPeriod(
  start: string,
  granularity: GranularityValue,
): string {
  const date = toDate(start);
  if (granularity === GranularityValue.MONTHLY) {
    date.setUTCMonth(date.getUTCMonth() + 1);
  } else {
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return toDay(date);
}

/** Today's date in a time zone, as `YYYY-MM-DD`. */
export function localToday(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

/**
 * Last day of the last complete week (Monday to Sunday) in a time zone: the
 * `history_end` of a forecast, so the week in progress is never sent half empty.
 */
export function lastCompleteSunday(timeZone: string, now = new Date()): string {
  const date = toDate(
    periodStart(localToday(timeZone, now), GranularityValue.WEEKLY),
  );
  date.setUTCDate(date.getUTCDate() - 1);
  return toDay(date);
}

/** Every period start from `first` to `last` (both period starts), inclusive. */
export function periodStarts(
  first: string,
  last: string,
  granularity: GranularityValue,
): string[] {
  const starts: string[] = [];
  for (let s = first; s <= last; s = nextPeriod(s, granularity)) {
    starts.push(s);
    if (starts.length > MAX_PERIODS)
      throw demandErrors.rangeTooLarge(MAX_PERIODS);
  }
  return starts;
}

// CU-10 A1 / US-37 (RF-PRED-001): demand history of a product, per period. Demand
// is the CONFIRMED outbound movements whose type counts as demand: sales and
// internal consumption, with or without a stock request (US-013). Periods without
// demand are 0, never a gap.
@Injectable()
export class DemandService {
  constructor(private readonly tenants: TenantPrismaService) {}

  async series(
    auth: AuthContext,
    productId: number,
    query: DemandQueryDto,
  ): Promise<DemandSeriesDto> {
    const tenant = this.tenants.client(auth.organization.schemaName);
    const schema = assertTenantSchema(auth.organization.schemaName);

    let warehouse: { id: number; name: string } | null = null;
    let warehouseIds: number[] | null;
    if (query.warehouseId !== undefined) {
      if (
        !permissionsInWarehouse(auth.user.roles, query.warehouseId).has(
          'forecast.read',
        )
      ) {
        throw demandErrors.warehouseNotFound();
      }
      warehouse = await tenant.warehouse.findUnique({
        where: { id: query.warehouseId },
        select: { id: true, name: true },
      });
      if (!warehouse) throw demandErrors.warehouseNotFound();
      warehouseIds = [warehouse.id];
    } else {
      const readable = warehousesWithPermission(
        auth.user.roles,
        'forecast.read',
      );
      warehouseIds = readable === 'ALL' ? null : readable;
    }

    const product = await tenant.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        name: true,
        stockUnit: { select: { code: true } },
      },
    });
    if (!product) throw demandErrors.productNotFound();
    const settings = await tenant.settings.findUnique({ where: { id: 1 } });
    const timeZone = settings?.timeZone ?? 'America/Bogota';
    const granularity =
      query.granularity ??
      (settings?.forecastGranularity as GranularityValue | undefined) ??
      GranularityValue.WEEKLY;

    const base = {
      product: {
        id: product.id,
        sku: product.sku,
        name: product.name,
        unit: product.stockUnit.code,
      },
      warehouse,
      granularity,
      timeZone,
    };
    const empty = {
      ...base,
      from: null,
      to: null,
      total: 0,
      periods: [],
      notice: 'NO_HISTORY' as const,
    };
    if (warehouseIds?.length === 0) return empty;

    // Demand lines of the product, as local dates of the organization.
    const demand = `
      FROM "${schema}"."movement_lines" l
      JOIN "${schema}"."movements" m ON m."id" = l."movement_id"
      JOIN "${schema}"."movement_types" t ON t."id" = m."movement_type_id"
      JOIN "${schema}"."locations" loc ON loc."id" = l."origin_location_id"
     WHERE l."product_id" = $1
       AND ${demandCondition()}
       AND ($2::int[] IS NULL OR loc."warehouse_id" = ANY($2::int[]))`;
    const params = [productId, warehouseIds, timeZone];

    const [{ first }] = await tenant.$queryRawUnsafe<
      { first: string | null }[]
    >(
      `SELECT to_char(MIN((m."occurred_at" AT TIME ZONE $3)::date), 'YYYY-MM-DD') AS "first"
       ${demand}`,
      ...params,
    );
    if (first === null) return empty;

    const rangeFrom = query.from ?? first;
    const rangeTo = query.to ?? localToday(timeZone);
    if (rangeFrom > rangeTo) throw demandErrors.rangeInvalid();
    const starts = periodStarts(
      periodStart(rangeFrom, granularity),
      periodStart(rangeTo, granularity),
      granularity,
    );
    const rangeEnd = nextPeriod(starts.at(-1)!, granularity); // exclusive

    const rows = await tenant.$queryRawUnsafe<
      { period: string; quantity: string }[]
    >(
      `SELECT to_char(date_trunc($4, m."occurred_at" AT TIME ZONE $3), 'YYYY-MM-DD') AS "period",
              SUM(l."quantity")::text AS "quantity"
       ${demand}
         AND (m."occurred_at" AT TIME ZONE $3)::date >= $5::date
         AND (m."occurred_at" AT TIME ZONE $3)::date < $6::date
       GROUP BY 1`,
      ...params,
      granularity === GranularityValue.MONTHLY ? 'month' : 'week',
      starts[0],
      rangeEnd,
    );
    const byPeriod = new Map(
      rows.map((r) => [r.period, new Prisma.Decimal(r.quantity)]),
    );
    const periods = starts.map((start) => ({
      periodStart: start,
      quantity: byPeriod.get(start)?.toNumber() ?? 0,
    }));
    const total = [...byPeriod.values()]
      .reduce((sum, q) => sum.add(q), new Prisma.Decimal(0))
      .toNumber();

    const lastDay = toDate(rangeEnd);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    return {
      ...base,
      from: starts[0],
      to: toDay(lastDay),
      total,
      periods,
      notice: null,
    };
  }
}
