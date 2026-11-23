import {
  type AlertResolution,
  type AlertStatus,
  Prisma,
} from '../generated/prisma/tenant/client.js';

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const Decimal = Prisma.Decimal;

export interface StockLevel {
  onHand: Decimal;
  /** Held by stock requests in attention whose reservation has not expired. */
  reserved: Decimal;
  /** On hand − reserved: what the reorder point is compared against. */
  available: Decimal;
}

const zeroLevel = (): StockLevel => ({
  onHand: new Decimal(0),
  reserved: new Decimal(0),
  available: new Decimal(0),
});

/**
 * Severity of a below-reorder-point alert (1 = lowest): at or below the reorder
 * point, at or below the safety stock, or nothing available.
 */
export function alertSeverity(
  available: Decimal,
  safetyStock: Decimal,
): 1 | 2 | 3 {
  if (available.lte(0)) return 3;
  if (available.lte(safetyStock)) return 2;
  return 1;
}

/**
 * Quantity that brings available stock up to the max stock, or else to the
 * reorder point. A calculated reorder point may exceed the max stock; then the
 * target is the reorder point.
 */
export function suggestedQuantity(
  available: Decimal,
  reorderPoint: Decimal,
  maxStock: Decimal | null,
): Decimal {
  const target = Decimal.max(maxStock ?? reorderPoint, reorderPoint);
  return Decimal.max(target.sub(available), 0);
}

/** Stock levels per product-warehouse; product-warehouses without stock get zeros. */
export async function stockLevels(
  tx: Tx,
  productWarehouses: { id: number; productId: number; warehouseId: number }[],
  now = new Date(),
): Promise<Map<number, StockLevel>> {
  const levels = new Map(productWarehouses.map((pw) => [pw.id, zeroLevel()]));
  if (productWarehouses.length === 0) return levels;

  // Sequential: inside a transaction both queries share one connection.
  const balances = await tx.stockBalance.groupBy({
    by: ['productWarehouseId'],
    where: { productWarehouseId: { in: [...levels.keys()] } },
    _sum: { quantity: true },
  });
  const reservations = await tx.stockRequestLine.findMany({
    where: {
      productId: { in: productWarehouses.map((pw) => pw.productId) },
      reservedQuantity: { gt: 0 },
      stockRequest: {
        warehouseId: { in: productWarehouses.map((pw) => pw.warehouseId) },
        status: 'IN_PROGRESS',
        OR: [
          { reservationExpiresAt: null },
          { reservationExpiresAt: { gt: now } },
        ],
      },
    },
    select: {
      productId: true,
      reservedQuantity: true,
      stockRequest: { select: { warehouseId: true } },
    },
  });

  for (const balance of balances) {
    levels.get(balance.productWarehouseId)!.onHand =
      balance._sum.quantity ?? new Decimal(0);
  }
  const byKey = new Map(
    productWarehouses.map((pw) => [`${pw.productId}:${pw.warehouseId}`, pw.id]),
  );
  for (const line of reservations) {
    const id = byKey.get(`${line.productId}:${line.stockRequest.warehouseId}`);
    if (id === undefined) continue;
    const level = levels.get(id)!;
    level.reserved = level.reserved.add(line.reservedQuantity);
  }
  for (const level of levels.values()) {
    level.available = level.onHand.sub(level.reserved);
  }
  return levels;
}

/** Alerts still in force: pending, or attended but not resolved yet (US-045). */
export const IN_FORCE: AlertStatus[] = ['OPEN', 'ATTENDED'];

/** What marking an alert pending again clears. */
export const BACK_TO_PENDING = {
  status: 'OPEN',
  attendedAt: null,
  attendedById: null,
} as const;

/**
 * CU-12a: compares available stock with the reorder point of each
 * product-warehouse. Opens a `BELOW_ROP` alert when available ≤ reorder point and
 * none is open; while it stays below, refreshes the open one (severity, available
 * stock, suggested quantity, reorder point and message) without touching
 * `createdAt`; resolves it when available rises above the reorder point, or when
 * the product-warehouse no longer has a reorder point. A reorder point of 0 means
 * none.
 *
 * Runs inside the caller's transaction, which must hold the products' row locks
 * so two evaluations of the same product never race.
 */
export async function evaluateAlerts(
  tx: Tx,
  productWarehouseIds: number[],
  now = new Date(),
): Promise<void> {
  if (productWarehouseIds.length === 0) return;
  const productWarehouses = await tx.productWarehouse.findMany({
    where: { id: { in: productWarehouseIds } },
    select: {
      id: true,
      productId: true,
      warehouseId: true,
      isActive: true,
      safetyStock: true,
      reorderPoint: true,
      maxStock: true,
      valueSource: true,
      product: {
        select: {
          sku: true,
          isActive: true,
          stockUnit: { select: { code: true } },
        },
      },
      warehouse: { select: { isActive: true } },
    },
  });
  const levels = await stockLevels(tx, productWarehouses, now);
  const open = await tx.alert.findMany({
    where: {
      productWarehouseId: { in: productWarehouseIds },
      type: 'BELOW_ROP',
      status: { in: IN_FORCE },
    },
    select: {
      id: true,
      productWarehouseId: true,
      status: true,
      severity: true,
      suggestedQuantity: true,
      availableQuantity: true,
      reorderPoint: true,
      reorderPointSource: true,
      message: true,
    },
  });
  const openAlert = new Map(open.map((a) => [a.productWarehouseId, a]));

  const toResolve = new Map<AlertResolution, number[]>();
  for (const pw of productWarehouses) {
    const { available } = levels.get(pw.id)!;
    const active = pw.isActive && pw.product.isActive && pw.warehouse.isActive;
    const below =
      active && pw.reorderPoint.gt(0) && available.lte(pw.reorderPoint);
    const current = openAlert.get(pw.id);

    if (below) {
      const values = {
        severity: alertSeverity(available, pw.safetyStock),
        suggestedQuantity: suggestedQuantity(
          available,
          pw.reorderPoint,
          pw.maxStock,
        ),
        availableQuantity: available,
        reorderPoint: pw.reorderPoint,
        reorderPointSource: pw.valueSource,
        message:
          `${pw.product.sku}: available stock ${available.toString()} ` +
          `${pw.product.stockUnit.code} is at or below the reorder point ` +
          `${pw.reorderPoint.toString()}`,
      };
      if (current === undefined) {
        await tx.alert.create({
          data: {
            productWarehouseId: pw.id,
            type: 'BELOW_ROP',
            ...values,
            createdAt: now,
            updatedAt: now,
          },
        });
      } else if (!sameValues(current, values)) {
        // Still below with an alert in force: never a second one (RF-ALT-001),
        // but keep what it shows current. `createdAt` stays when it was raised.
        // An attended alert that gets worse needs someone to look again.
        const worse =
          current.status === 'ATTENDED' && values.severity > current.severity;
        await tx.alert.update({
          where: { id: current.id },
          data: {
            ...values,
            ...(worse && BACK_TO_PENDING),
            updatedAt: now,
          },
        });
      }
    } else if (current !== undefined) {
      const reason = resolutionOf(active, pw.reorderPoint, available, current);
      toResolve.set(reason, [...(toResolve.get(reason) ?? []), current.id]);
    }
  }
  for (const [resolution, ids] of toResolve) {
    await tx.alert.updateMany({
      where: { id: { in: ids }, status: { in: IN_FORCE } },
      data: { status: 'RESOLVED', resolution, resolvedAt: now, updatedAt: now },
    });
  }
}

/**
 * Why an open alert no longer applies. The alert keeps the values of its last
 * evaluation, so this is what explains a resolved alert that still reads "below
 * the reorder point": the point it was compared against changed, not the stock.
 */
export function resolutionOf(
  active: boolean,
  reorderPoint: Decimal,
  available: Decimal,
  alert: { reorderPoint: Decimal },
): AlertResolution {
  if (!active) return 'INACTIVE';
  if (reorderPoint.lte(0)) return 'NO_REORDER_POINT';
  // Above the point the alert last showed: the stock came back. Otherwise only
  // a lower reorder point explains it.
  return available.gt(alert.reorderPoint)
    ? 'STOCK_RECOVERED'
    : 'REORDER_POINT_CHANGED';
}

interface AlertValues {
  severity: number;
  suggestedQuantity: Decimal;
  availableQuantity: Decimal;
  reorderPoint: Decimal;
  reorderPointSource: string;
  message: string;
}

/** Whether an open alert already shows these values (no write needed). */
function sameValues(stored: AlertValues, next: AlertValues): boolean {
  return (
    stored.severity === next.severity &&
    stored.suggestedQuantity.eq(next.suggestedQuantity) &&
    stored.availableQuantity.eq(next.availableQuantity) &&
    stored.reorderPoint.eq(next.reorderPoint) &&
    stored.reorderPointSource === next.reorderPointSource &&
    stored.message === next.message
  );
}

/**
 * For changes that switch alerts on or off for many product-warehouses at once
 * (archiving a product, closing a warehouse, a forecast run): locks the rows of their products,
 * in id order like movements do, and returns the product-warehouse ids to pass
 * to `evaluateAlerts` once the change is written in the same transaction.
 */
export async function lockAlertScope(
  tx: Tx,
  schema: string,
  where:
    { productId: number } | { warehouseId: number } | { id: { in: number[] } },
): Promise<number[]> {
  const productWarehouses = await tx.productWarehouse.findMany({
    where,
    select: { id: true, productId: true },
  });
  if (productWarehouses.length === 0) return [];
  const productIds = [
    ...new Set(productWarehouses.map((pw) => pw.productId)),
  ].sort((a, b) => a - b);
  await tx.$queryRawUnsafe(
    `SELECT "id" FROM "${schema}"."products"
      WHERE "id" = ANY($1::int[]) ORDER BY "id" FOR UPDATE`,
    productIds,
  );
  return productWarehouses.map((pw) => pw.id);
}
