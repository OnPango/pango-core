import { Prisma } from '../generated/prisma/tenant/client.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

/** Why a FORECAST_ROP product-warehouse fell back to its manual values. */
export type CalculationIssue =
  /** No current OK forecast (never forecast, declined, or only failed runs). */
  | 'NO_FORECAST'
  /** The current forecast has no horizon-total interval. */
  | 'NO_INTERVAL'
  /** No lead time to cover. */
  | 'NO_LEAD_TIME';

export interface ForecastTotal {
  estimate: Decimal;
  upper: Decimal;
  /** Days covered by the total: the run's horizon in weeks × 7. */
  horizonDays: number;
}

/**
 * CU-11 / RF-PRED-005, upper-band method: the forecast total of the horizon is
 * scaled to the lead time. Expected demand scales linearly with time and the
 * band (upper − estimate) with its square root, as the spread of a sum of
 * independent periods does:
 *
 *   expected = estimate × L / H
 *   safety   = (upper − estimate) × √(L / H)
 *   reorder  = expected + safety
 *
 * L = lead time in days, H = days of the horizon. The service level is the one
 * the service calibrated its interval to, not `product_warehouses.service_level`.
 * Both values are rounded up to 4 decimals.
 */
export function computeReorderPoint(
  total: ForecastTotal,
  leadTimeDays: number,
): { safetyStock: Decimal; reorderPoint: Decimal } {
  const ratio = new Decimal(leadTimeDays).div(total.horizonDays);
  const expected = total.estimate.mul(ratio);
  const band = Decimal.max(total.upper.sub(total.estimate), 0);
  const safetyStock = band.mul(ratio.sqrt());
  const round = (value: Decimal) => value.toDecimalPlaces(4, Decimal.ROUND_UP);
  return {
    safetyStock: round(safetyStock),
    reorderPoint: round(expected.add(safetyStock)),
  };
}

/** Safety stock and reorder point in force, and where they come from. */
export interface ReorderValues {
  safetyStock: Decimal;
  reorderPoint: Decimal;
  valueSource: 'MANUAL' | 'CALCULATED';
  baseForecastId: number | null;
  calculationIssue: CalculationIssue | null;
}

export interface ReorderInput {
  replenishmentMethod: 'MIN_MAX' | 'FIXED_ROP' | 'FORECAST_ROP';
  leadTimeDays: number;
  manualSafetyStock: Decimal;
  manualReorderPoint: Decimal;
  /** The current OK forecast, if any. */
  forecast: {
    id: number;
    totalEstimate: Decimal | null;
    totalUpper: Decimal | null;
    horizonWeeks: number;
  } | null;
}

/**
 * Values in force from the replenishment method:
 * - FIXED_ROP (and MIN_MAX): the manual values, `MANUAL`.
 * - FORECAST_ROP: computed from the current OK forecast and the lead time,
 *   `CALCULATED`; when that is not possible, the manual values with
 *   `calculationIssue` saying why.
 */
export function reorderValues(input: ReorderInput): ReorderValues {
  const manual = (
    calculationIssue: CalculationIssue | null,
  ): ReorderValues => ({
    safetyStock: input.manualSafetyStock,
    reorderPoint: input.manualReorderPoint,
    valueSource: 'MANUAL',
    baseForecastId: null,
    calculationIssue,
  });
  if (input.replenishmentMethod !== 'FORECAST_ROP') return manual(null);
  const { forecast } = input;
  if (!forecast) return manual('NO_FORECAST');
  if (!forecast.totalEstimate || !forecast.totalUpper) {
    return manual('NO_INTERVAL');
  }
  if (input.leadTimeDays <= 0) return manual('NO_LEAD_TIME');
  return {
    ...computeReorderPoint(
      {
        estimate: forecast.totalEstimate,
        upper: forecast.totalUpper,
        horizonDays: forecast.horizonWeeks * 7,
      },
      input.leadTimeDays,
    ),
    valueSource: 'CALCULATED',
    baseForecastId: forecast.id,
    calculationIssue: null,
  };
}

/**
 * Puts in force the values of `reorderValues` for each product-warehouse; a
 * calculation also stamps `calculatedAt`. Only writes rows that change. Runs in
 * the caller's transaction, which must hold the products' row locks and
 * evaluate the alerts afterwards.
 */
export async function refreshReorderPoints(
  tx: Tx,
  productWarehouseIds: number[],
  now = new Date(),
): Promise<void> {
  if (productWarehouseIds.length === 0) return;
  const productWarehouses = await tx.productWarehouse.findMany({
    where: { id: { in: productWarehouseIds } },
    select: {
      id: true,
      replenishmentMethod: true,
      leadTimeDays: true,
      safetyStock: true,
      reorderPoint: true,
      valueSource: true,
      manualSafetyStock: true,
      manualReorderPoint: true,
      baseForecastId: true,
      calculationIssue: true,
      forecasts: {
        where: { isCurrent: true, status: 'OK' },
        orderBy: { id: 'desc' },
        take: 1,
        select: {
          id: true,
          totalEstimate: true,
          totalUpper: true,
          run: { select: { horizon: true } },
        },
      },
    },
  });

  for (const pw of productWarehouses) {
    const forecast = pw.forecasts.at(0);
    const next = reorderValues({
      ...pw,
      forecast: forecast
        ? {
            id: forecast.id,
            totalEstimate: forecast.totalEstimate,
            totalUpper: forecast.totalUpper,
            horizonWeeks: forecast.run.horizon,
          }
        : null,
    });
    const unchanged =
      pw.safetyStock.eq(next.safetyStock) &&
      pw.reorderPoint.eq(next.reorderPoint) &&
      pw.valueSource === next.valueSource &&
      pw.baseForecastId === next.baseForecastId &&
      pw.calculationIssue === next.calculationIssue;
    if (unchanged) continue;
    await tx.productWarehouse.update({
      where: { id: pw.id },
      data: {
        ...next,
        ...(next.valueSource === 'CALCULATED' && { calculatedAt: now }),
      },
    });
  }
}
