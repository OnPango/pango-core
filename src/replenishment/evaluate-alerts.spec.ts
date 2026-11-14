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

/** Open alert raised in medium severity with 8 available (reorder point 10). */
function openAlertRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    productWarehouseId: 9,
    severity: 1,
    suggestedQuantity: D(42),
    availableQuantity: D(8),
    reorderPoint: D(10),
    reorderPointSource: 'MANUAL',
    message:
      'TOR-001: available stock 8 EA is at or below the reorder point 10',
    ...overrides,
  };
}

function setup(options: {
  onHand: number;
  reserved?: number;
  pw?: Record<string, unknown>;
  openAlertId?: number;
  openAlert?: Record<string, unknown>;
}) {
  const open =
    options.openAlert !== undefined
      ? [openAlertRow(options.openAlert)]
      : options.openAlertId !== undefined
        ? [openAlertRow({ id: options.openAlertId })]
        : [];
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
      findMany: vi.fn().mockResolvedValue(open),
      create: vi.fn(),
      update: vi.fn(),
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

  it('raises an open medium alert to critical when nothing is available', async () => {
    const tx = setup({ onHand: 0, openAlert: {} });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
    expect(tx.alert.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: {
        severity: 3,
        availableQuantity: D(0),
        suggestedQuantity: D(50),
        reorderPoint: D(10),
        reorderPointSource: 'MANUAL',
        message:
          'TOR-001: available stock 0 EA is at or below the reorder point 10',
        updatedAt: now,
      },
    });
    // `createdAt` keeps the date the alert was raised.
    expect(tx.alert.update.mock.calls[0][0].data).not.toHaveProperty(
      'createdAt',
    );
  });

  it('lowers the severity when stock comes in but stays below the reorder point', async () => {
    const tx = setup({
      onHand: 7,
      openAlert: {
        severity: 3,
        availableQuantity: D(0),
        suggestedQuantity: D(50),
        message:
          'TOR-001: available stock 0 EA is at or below the reorder point 10',
      },
    });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(tx.alert.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        severity: 1,
        availableQuantity: D(7),
        suggestedQuantity: D(43),
      }),
    });

    const high = setup({ onHand: 4, openAlert: {} });
    await evaluateAlerts(high as unknown as Tx, [9], now);
    expect(high.alert.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({ severity: 2 }),
    });
  });

  it('follows a changed reorder point while the alert stays open', async () => {
    const tx = setup({
      onHand: 8,
      pw: { reorderPoint: D(20), valueSource: 'CALCULATED' },
      openAlert: {},
    });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        reorderPoint: D(20),
        reorderPointSource: 'CALCULATED',
        message:
          'TOR-001: available stock 8 EA is at or below the reorder point 20',
      }),
    });
  });

  it('leaves an open alert untouched when nothing changed', async () => {
    const tx = setup({ onHand: 8, openAlert: {} });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.create).not.toHaveBeenCalled();
    expect(tx.alert.update).not.toHaveBeenCalled();
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });

  it('resolves the open alert once available stock is above the reorder point', async () => {
    const tx = setup({ onHand: 11, openAlertId: 7 });
    await evaluateAlerts(tx as unknown as Tx, [9], now);
    expect(tx.alert.update).not.toHaveBeenCalled();
    expect(tx.alert.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [7] }, status: 'OPEN' },
      data: { status: 'RESOLVED', resolvedAt: now, updatedAt: now },
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
