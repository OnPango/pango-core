import type { TenantPrismaService } from '../prisma/tenant-prisma.service.js';
import { inFilter, type WarehouseFilter } from './dashboard-scope.js';

export type Tenant = ReturnType<TenantPrismaService['client']>;

/** Where a product stands in a warehouse right now, with what its value needs. */
export interface StockPosition {
  productWarehouseId: number;
  productId: number;
  sku: string;
  name: string;
  unit: string;
  categoryId: number;
  averageCost: number;
  warehouseId: number;
  warehouseName: string;
  /** The product-warehouse, the product and the warehouse are all active. */
  isActive: boolean;
  onHand: number;
  reserved: number;
  available: number;
  maxStock: number | null;
}

/**
 * Every product-warehouse of the filter with its on hand (all balances), what
 * stock requests in attention hold (unexpired reservations) and the product's
 * average cost. One query: the dashboard reads the whole picture at once.
 */
export async function loadStockPositions(
  tenant: Tenant,
  schema: string,
  warehouses: WarehouseFilter,
): Promise<StockPosition[]> {
  const rows = await tenant.$queryRawUnsafe<Omit<StockPosition, 'available'>[]>(
    `WITH balances AS (
       SELECT "product_warehouse_id", SUM("quantity") AS "onHand"
         FROM "${schema}"."stock_balances"
        GROUP BY 1
     ), reservations AS (
       SELECT r."warehouse_id", l."product_id", SUM(l."reserved_quantity") AS "reserved"
         FROM "${schema}"."stock_request_lines" l
         JOIN "${schema}"."stock_requests" r ON r."id" = l."stock_request_id"
        WHERE r."status" = 'IN_PROGRESS' AND l."reserved_quantity" > 0
          AND (r."reservation_expires_at" IS NULL OR r."reservation_expires_at" > now())
        GROUP BY 1, 2
     )
     SELECT pw."id" AS "productWarehouseId", p."id" AS "productId", p."sku", p."name",
            u."code" AS "unit", p."category_id" AS "categoryId",
            p."average_cost"::float8 AS "averageCost",
            w."id" AS "warehouseId", w."name" AS "warehouseName",
            (pw."is_active" AND p."is_active" AND w."is_active") AS "isActive",
            COALESCE(b."onHand", 0)::float8 AS "onHand",
            COALESCE(r."reserved", 0)::float8 AS "reserved",
            pw."max_stock"::float8 AS "maxStock"
       FROM "${schema}"."product_warehouses" pw
       JOIN "${schema}"."products" p ON p."id" = pw."product_id"
       JOIN "${schema}"."warehouses" w ON w."id" = pw."warehouse_id"
       JOIN "${schema}"."units_of_measure" u ON u."id" = p."stock_unit_id"
       LEFT JOIN balances b ON b."product_warehouse_id" = pw."id"
       LEFT JOIN reservations r
              ON r."warehouse_id" = pw."warehouse_id" AND r."product_id" = pw."product_id"
      WHERE ${inFilter('pw."warehouse_id"', 1)}`,
    warehouses,
  );
  return rows.map((row) => ({
    ...row,
    available: round(row.onHand - row.reserved),
  }));
}

/** Value of stock: negative balances (allowed by settings) are worth nothing. */
export const stockValue = (position: StockPosition) =>
  round(Math.max(position.onHand, 0) * position.averageCost, 2);

/**
 * Average daily demand of the current OK forecast of each product-warehouse: the
 * horizon's total estimate over its days (weeks × 7, or months × 30).
 */
export async function forecastDailyDemand(
  tenant: Tenant,
  schema: string,
  productWarehouseIds: number[],
): Promise<Map<number, number>> {
  if (productWarehouseIds.length === 0) return new Map();
  const rows = await tenant.$queryRawUnsafe<
    { productWarehouseId: number; daily: number }[]
  >(
    `SELECT f."product_warehouse_id" AS "productWarehouseId",
            (f."total_estimate" / (r."horizon" *
              CASE r."granularity" WHEN 'MONTHLY' THEN 30 ELSE 7 END))::float8 AS "daily"
       FROM "${schema}"."forecasts" f
       JOIN "${schema}"."forecast_runs" r ON r."id" = f."run_id"
      WHERE f."is_current" AND f."status" = 'OK' AND f."total_estimate" IS NOT NULL
        AND r."horizon" > 0 AND f."product_warehouse_id" = ANY($1::int[])`,
    productWarehouseIds,
  );
  return new Map(rows.map((row) => [row.productWarehouseId, row.daily]));
}

/** Days the available stock lasts at the forecast's daily demand; null without one. */
export function daysOfCover(
  available: number,
  daily: number | undefined,
): number | null {
  if (daily === undefined || daily <= 0) return null;
  return Math.max(0, Math.floor(available / daily));
}

/** SQL for the start of a local day (`YYYY-MM-DD` at `$day`) in the time zone at `$tz`. */
export const localDayStart = (day: number, tz: number) =>
  `(($${day}::date)::timestamp AT TIME ZONE $${tz})`;

export const round = (value: number, digits = 4) =>
  Number(value.toFixed(digits));

/** Organization time zone and currency (`settings`, one row). */
export async function loadSettings(
  tenant: Tenant,
): Promise<{ timeZone: string; currency: string }> {
  const settings = await tenant.settings.findUnique({
    where: { id: 1 },
    select: { timeZone: true, currency: true },
  });
  return {
    timeZone: settings?.timeZone ?? 'America/Bogota',
    currency: settings?.currency ?? 'COP',
  };
}

/** What entered (+) or left (−) a product's stock in a warehouse on a local day. */
export interface NetMovement {
  productId: number;
  warehouseId: number;
  /** `YYYY-MM-DD` in the time zone asked for. */
  day: string;
  net: number;
}

/**
 * Net stock change per product, warehouse and local day after `since`, from the
 * movement lines: a destination adds (what a transfer received), an origin
 * removes (a transfer in transit already left). Subtracting it from today's on
 * hand gives the on hand of a past day.
 */
export async function netMovementsSince(
  tenant: Tenant,
  schema: string,
  warehouses: WarehouseFilter,
  since: Date,
  timeZone: string,
): Promise<NetMovement[]> {
  return tenant.$queryRawUnsafe<NetMovement[]>(
    `WITH moves AS (
       SELECT l."product_id", ld."warehouse_id", m."occurred_at",
              COALESCE(l."received_quantity", l."quantity") AS "quantity"
         FROM "${schema}"."movement_lines" l
         JOIN "${schema}"."movements" m ON m."id" = l."movement_id"
         JOIN "${schema}"."locations" ld ON ld."id" = l."destination_location_id"
        WHERE m."status" = 'CONFIRMED' AND m."occurred_at" > $2
       UNION ALL
       SELECT l."product_id", lo."warehouse_id", m."occurred_at", -l."quantity"
         FROM "${schema}"."movement_lines" l
         JOIN "${schema}"."movements" m ON m."id" = l."movement_id"
         JOIN "${schema}"."locations" lo ON lo."id" = l."origin_location_id"
        WHERE m."status" IN ('CONFIRMED', 'IN_TRANSIT') AND m."occurred_at" > $2
     )
     SELECT "product_id" AS "productId", "warehouse_id" AS "warehouseId",
            to_char("occurred_at" AT TIME ZONE $3, 'YYYY-MM-DD') AS "day",
            SUM("quantity")::float8 AS "net"
       FROM moves
      WHERE ${inFilter('"warehouse_id"', 1)}
      GROUP BY 1, 2, 3`,
    warehouses,
    since,
    timeZone,
  );
}
