import { Prisma } from '../generated/prisma/tenant/client.js';
import {
  alertSeverity,
  evaluateAlerts,
  stockLevels,
  suggestedQuantity,
} from './evaluate-alerts.js';

const D = (value: number) => new Prisma.Decimal(value);
const now = new Date('2026-11-07T12:00:00Z');

function productWarehouse(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    productId: 5,
    warehouseId: 1,
    isActive: true,
    safetyStock: D(5),
    reorderPoint: D(10),
    maxStock: D(50),
    valueSource: 'MANUAL',
    product: { sku: 'TOR-001', isActive: true, stockUnit: { code: 'EA' } },
    ...overrides,
  };
}

function setup(options: {
  onHand: number;
  reserved?: number;
  pw?: Record<string, unknown>;
  openAlertId?: number;
}) {
  const tx = {
    productWarehouse: {
      findMany: vi.fn().mockResolvedValue([productWarehouse(options.pw)]),
    },
    stockBalance: {
      groupBy: vi
        .fn()
        .mockResolvedValue([
          { productWarehouseId: 9, _sum: { quantity: D(options.onHand) } },
        ]),
    },
    stockRequestLine: {
      findMany: vi.fn().mockResolvedValue(
        options.reserved
          ? [
              {
                productId: 5,
                reservedQuantity: D(options.reserved),
                stockRequest: { warehouseId: 1 },
              },
            ]
          : [],
      ),
    },
    alert: {
      findMany: vi
        .fn()
        .mockResolvedValue(
          options.openAlertId === undefined
            ? []
            : [{ id: options.openAlertId, productWarehouseId: 9 }],
        ),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return tx;
}

type Tx = Parameters<typeof evaluateAlerts>[0];

describe('alert helpers', () => {
  it('grades severity by the safety stock and stockouts', () => {
    expect(alertSeverity(D(8), D(5))).toBe(1);
    expect(alertSeverity(D(5), D(5))).toBe(2);
    expect(alertSeverity(D(0), D(5))).toBe(3);
    expect(alertSeverity(D(-2), D(0))).toBe(3);
  });

  it('suggests ordering up to the max stock, or else the reorder point', () => {
    expect(suggestedQuantity(D(8), D(10), D(50)).toNumber()).toBe(42);
    expect(suggestedQuantity(D(-2), D(10), null).toNumber()).toBe(12);
    expect(suggestedQuantity(D(10), D(10), null).toNumber()).toBe(0);
  });

  it('subtracts active reservations of the same warehouse', async () => {
    const tx = setup({ onHand: 20, reserved: 6 });
    const level = (
      await stockLevels(tx as unknown as Tx, [
        { id: 9, productId: 5, warehouseId: 1 },
      ])
    ).get(9)!;
    expect(level.available.toNumber()).toBe(14);
  });
});

describe('evaluateAlerts', () => {
  it('opens an alert at or below the reorder point, with the values used', async () => {
    const tx = setup({ onHand: 12, reserved: 4 });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productWarehouseId: 9,
        type: 'BELOW_ROP',
        severity: 1,
        availableQuantity: D(8),
        reorderPoint: D(10),
        reorderPointSource: 'MANUAL',
        suggestedQuantity: D(42),
        message:
          'TOR-001: available stock 8 EA is at or below the reorder point 10',
      }),
    });
  });

  it('does not duplicate an open alert', async () => {
    const tx = setup({ onHand: 3, openAlertId: 7 });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it('resolves the open alert once available stock is above the reorder point', async () => {
    const tx = setup({ onHand: 11, openAlertId: 7 });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] }, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: now },
    });
  });

  it('raises nothing without a reorder point and resolves what was open', async () => {
    const tx = setup({ onHand: 0, pw: { reorderPoint: D(0) } });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.create).not.toHaveBeenCalled();

    const open = setup({
      onHand: 0,
      pw: { reorderPoint: D(0) },
      openAlertId: 7,
    });
    await evaluateAlerts(open as unknown as Tx, [9], now);
    expect(open.alert.updateMany).toHaveBeenCalled();
  });
});
