import { Prisma } from '../generated/prisma/tenant/client.js';
import {
  computeReorderPoint,
  type ReorderInput,
  refreshReorderPoints,
  reorderValues,
} from './reorder-point.js';

const D = (value: number) => new Prisma.Decimal(value);

describe('computeReorderPoint', () => {
  it('matches the worked example of the design', () => {
    // docs/cu-11-reorder-point.md: 28 days, 100 units, upper 120, 7 days of lead time.
    const result = computeReorderPoint(
      { estimate: D(100), upper: D(120), horizonDays: 28 },
      7,
    );
    expect(result.safetyStock.toNumber()).toBe(10);
    expect(result.reorderPoint.toNumber()).toBe(35);
  });

  it('rounds both values up to 4 decimals', () => {
    // 3 days of 28: expected 10 × 3/28 = 1.071428…, safety 1 × √(3/28) = 0.327326…
    const result = computeReorderPoint(
      { estimate: D(10), upper: D(11), horizonDays: 28 },
      3,
    );
    expect(result.safetyStock.toString()).toBe('0.3274');
    expect(result.reorderPoint.toString()).toBe('1.3988');
  });

  it('gives zero safety stock for a zero-width interval', () => {
    const result = computeReorderPoint(
      { estimate: D(56), upper: D(56), horizonDays: 28 },
      7,
    );
    expect(result.safetyStock.toNumber()).toBe(0);
    expect(result.reorderPoint.toNumber()).toBe(14);
  });

  it('scales the expected demand linearly and the band with the square root', () => {
    // 4 weeks: 28 days. 7 days of lead time = 1/4 of the horizon.
    const result = computeReorderPoint(
      { estimate: D(91), upper: D(107.5), horizonDays: 28 },
      7,
    );
    // expected 22.75, safety 16.5 × √0.25 = 8.25.
    expect(result.safetyStock.toNumber()).toBe(8.25);
    expect(result.reorderPoint.toNumber()).toBe(31);
  });

  it('covers lead times longer than the horizon', () => {
    const result = computeReorderPoint(
      { estimate: D(40), upper: D(60), horizonDays: 28 },
      56,
    );
    // expected 80, safety 20 × √2 = 28.2843 (rounded up).
    expect(result.safetyStock.toNumber()).toBe(28.2843);
    expect(result.reorderPoint.toNumber()).toBe(108.2843);
  });

  it('gives only the band when the expected demand is zero', () => {
    const result = computeReorderPoint(
      { estimate: D(0), upper: D(18.1), horizonDays: 28 },
      7,
    );
    expect(result.safetyStock.toNumber()).toBe(9.05);
    expect(result.reorderPoint.toNumber()).toBe(9.05);
  });
});

const base: ReorderInput = {
  replenishmentMethod: 'FORECAST_ROP',
  leadTimeDays: 7,
  manualSafetyStock: D(5),
  manualReorderPoint: D(20),
  forecast: {
    id: 12,
    totalEstimate: D(91),
    totalUpper: D(107.5),
    horizonWeeks: 4,
  },
};

describe('reorderValues', () => {
  it('computes FORECAST_ROP from the current forecast', () => {
    expect(reorderValues(base)).toMatchObject({
      valueSource: 'CALCULATED',
      baseForecastId: 12,
      calculationIssue: null,
    });
    expect(reorderValues(base).reorderPoint.toNumber()).toBe(31);
  });

  it('keeps the manual values for FIXED_ROP and MIN_MAX, even with a forecast', () => {
    for (const replenishmentMethod of ['FIXED_ROP', 'MIN_MAX'] as const) {
      const values = reorderValues({ ...base, replenishmentMethod });
      expect(values).toMatchObject({
        valueSource: 'MANUAL',
        baseForecastId: null,
        calculationIssue: null,
      });
      expect(values.safetyStock.toNumber()).toBe(5);
      expect(values.reorderPoint.toNumber()).toBe(20);
    }
  });

  it('falls back to the manual values and says why', () => {
    const issue = (input: Partial<ReorderInput>) => {
      const values = reorderValues({ ...base, ...input });
      expect(values.valueSource).toBe('MANUAL');
      expect(values.safetyStock.toNumber()).toBe(5);
      expect(values.reorderPoint.toNumber()).toBe(20);
      return values.calculationIssue;
    };
    expect(issue({ forecast: null })).toBe('NO_FORECAST');
    expect(issue({ forecast: { ...base.forecast!, totalUpper: null } })).toBe(
      'NO_INTERVAL',
    );
    expect(issue({ leadTimeDays: 0 })).toBe('NO_LEAD_TIME');
  });
});

describe('refreshReorderPoints', () => {
  const row = {
    id: 9,
    replenishmentMethod: 'FORECAST_ROP',
    leadTimeDays: 7,
    safetyStock: D(5),
    reorderPoint: D(20),
    valueSource: 'MANUAL',
    manualSafetyStock: D(5),
    manualReorderPoint: D(20),
    baseForecastId: null,
    calculationIssue: null,
    forecasts: [
      {
        id: 12,
        totalEstimate: D(91),
        totalUpper: D(107.5),
        run: { horizon: 4 },
      },
    ],
  };

  it('writes the calculated values with their date', async () => {
    const now = new Date('2026-11-18T12:00:00Z');
    const tx = {
      productWarehouse: {
        findMany: vi.fn().mockResolvedValue([row]),
        update: vi.fn(),
      },
    };
    await refreshReorderPoints(tx as never, [9], now);
    expect(
      tx.productWarehouse.findMany.mock.calls[0][0].select.forecasts,
    ).toMatchObject({ where: { isCurrent: true, status: 'OK' } });
    expect(tx.productWarehouse.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: expect.objectContaining({
        valueSource: 'CALCULATED',
        baseForecastId: 12,
        calculationIssue: null,
        calculatedAt: now,
      }),
    });
  });

  it('writes nothing when the values in force do not change', async () => {
    const tx = {
      productWarehouse: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { ...row, replenishmentMethod: 'FIXED_ROP', forecasts: [] },
          ]),
        update: vi.fn(),
      },
    };
    await refreshReorderPoints(tx as never, [9]);
    expect(tx.productWarehouse.update).not.toHaveBeenCalled();
  });
});
