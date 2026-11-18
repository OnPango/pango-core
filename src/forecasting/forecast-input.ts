import { demandCondition } from '../demand/demand-rule.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';
import type { ForecastSeriesInput } from './contract.js';

type Tx = Prisma.TransactionClient;

export interface SeriesKey {
  id: number;
  productId: number;
  warehouseId: number;
  /** Sent as the series' free-form `metadata`. */
  metadata?: ForecastSeriesInput['metadata'];
}

/**
 * Builds the series of the forecasting request (contract sections 8-10), one per
 * product-warehouse, with local days of `timeZone` up to `historyEnd`:
 * - `demand`: gross daily demand (the shared demand rule), only days with demand.
 * - `stock`: closing stock of the days it changed, rebuilt from every movement
 *   (inbound, outbound, adjustments, and voided ones with their reversals).
 *   Negative stock (allowed by settings) is sent as 0, a stockout.
 * Series without demand and without stock changes are left out.
 */
export async function buildSeries(
  tenant: Tx,
  schema: string,
  input: {
    productWarehouses: SeriesKey[];
    historyEnd: string;
    timeZone: string;
    stockRequestTypeId: number | null;
  },
): Promise<ForecastSeriesInput[]> {
  const ids = input.productWarehouses.map((pw) => pw.id);
  if (ids.length === 0) return [];
  const lines = `
      FROM "${schema}"."movement_lines" l
      JOIN "${schema}"."movements" m ON m."id" = l."movement_id"`;

  const demand = await tenant.$queryRawUnsafe<
    { pw: number; date: string; quantity: string }[]
  >(
    `SELECT pw."id" AS "pw",
            to_char((m."occurred_at" AT TIME ZONE $2)::date, 'YYYY-MM-DD') AS "date",
            SUM(l."quantity")::text AS "quantity"
       ${lines}
       JOIN "${schema}"."movement_types" t ON t."id" = m."movement_type_id"
       JOIN "${schema}"."locations" loc ON loc."id" = l."origin_location_id"
       JOIN "${schema}"."product_warehouses" pw
         ON pw."product_id" = l."product_id" AND pw."warehouse_id" = loc."warehouse_id"
      WHERE pw."id" = ANY($1::int[])
        AND ${demandCondition('$4')}
        AND (m."occurred_at" AT TIME ZONE $2)::date <= $3::date
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    ids,
    input.timeZone,
    input.historyEnd,
    input.stockRequestTypeId,
  );

  // Net change per day (outbound lines subtract at the origin, inbound lines add
  // at the destination), running total, and only the days with a net change.
  const side = (location: string, sign: string) => `
     SELECT pw."id" AS "pw", (m."occurred_at" AT TIME ZONE $2)::date AS "day",
            ${sign}l."quantity" AS "delta"
       ${lines}
       JOIN "${schema}"."locations" loc ON loc."id" = l."${location}"
       JOIN "${schema}"."product_warehouses" pw
         ON pw."product_id" = l."product_id" AND pw."warehouse_id" = loc."warehouse_id"
      WHERE pw."id" = ANY($1::int[]) AND m."status" IN ('CONFIRMED', 'VOIDED')`;
  const stock = await tenant.$queryRawUnsafe<
    { pw: number; date: string; closing: string }[]
  >(
    `WITH daily AS (
       SELECT "pw", "day", SUM("delta") AS "net"
         FROM (${side('origin_location_id', '-')} UNION ALL ${side('destination_location_id', '')}) moves
        WHERE "day" <= $3::date
        GROUP BY 1, 2
     ), running AS (
       SELECT "pw", "day", "net",
              SUM("net") OVER (PARTITION BY "pw" ORDER BY "day") AS "closing"
         FROM daily
     )
     SELECT "pw", to_char("day", 'YYYY-MM-DD') AS "date", "closing"::text AS "closing"
       FROM running WHERE "net" <> 0
      ORDER BY 1, 2`,
    ids,
    input.timeZone,
    input.historyEnd,
  );

  const demandOf = new Map<number, ForecastSeriesInput['demand']>();
  for (const row of demand) {
    const list = demandOf.get(row.pw) ?? [];
    list.push({ date: row.date, quantity: Number(row.quantity) });
    demandOf.set(row.pw, list);
  }
  const stockOf = new Map<number, ForecastSeriesInput['stock']>();
  for (const row of stock) {
    const list = stockOf.get(row.pw) ?? [];
    list.push({
      date: row.date,
      closing_stock: Math.max(Number(row.closing), 0),
    });
    stockOf.set(row.pw, list);
  }

  return input.productWarehouses
    .map((pw) => ({
      series_id: pw.id,
      product_id: pw.productId,
      warehouse_id: pw.warehouseId,
      metadata: pw.metadata ?? {},
      demand: demandOf.get(pw.id) ?? [],
      stock: stockOf.get(pw.id) ?? [],
    }))
    .filter((series) => series.demand.length > 0 || series.stock.length > 0);
}
