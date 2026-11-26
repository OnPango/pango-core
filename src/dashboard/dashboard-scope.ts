import {
  type AuthContext,
  warehousesWithPermission,
} from '../auth/auth-context.js';

/** Warehouse ids a block reads, or `null` for every warehouse. */
export type WarehouseFilter = number[] | null;

/**
 * Warehouses where `permission` applies, narrowed to `warehouseId` when given.
 * `false` when the user holds it nowhere: the block is not shown at all. A
 * `warehouseId` outside the user's warehouses gives an empty filter, so the block
 * answers zeros instead of revealing that warehouse.
 */
export function readableWarehouses(
  auth: AuthContext,
  permission: string,
  warehouseId?: number,
): WarehouseFilter | false {
  const granted = warehousesWithPermission(auth.user.roles, permission);
  if (granted !== 'ALL' && granted.length === 0) return false;
  if (warehouseId === undefined) return granted === 'ALL' ? null : granted;
  return granted === 'ALL' || granted.includes(warehouseId)
    ? [warehouseId]
    : [];
}

/** SQL condition on a warehouse id column for a `WarehouseFilter` bound to `$n`. */
export const inFilter = (column: string, param: number) =>
  `($${param}::int[] IS NULL OR ${column} = ANY($${param}::int[]))`;
