// Who may import inventory where (docs/modules/inventary.md, INV-BR-15 and T7).
// `inventory.import` is a warehouse-scope permission that alone authorizes a whole
// import: stock, new products, categories and warehouses, and confirmation.
import {
  type AuthContext,
  isOwner,
  warehousesWithPermission,
} from '../auth/auth-context.js';
import type { Prisma } from '../generated/prisma/tenant/client.js';

type Tx = Prisma.TransactionClient;

export const INVENTORY_IMPORT = 'inventory.import';

/** Warehouses the user may import into: `'ALL'` for the Owner, else the ids where a role grants it. */
export type ImportScope = 'ALL' | number[];

export function importScope(auth: AuthContext): ImportScope {
  return warehousesWithPermission(auth.user.roles, INVENTORY_IMPORT);
}

/**
 * Whether the user may put stock into an existing warehouse. A warehouse the same
 * import creates needs no check here: holding the permission anywhere (enforced
 * on every route) lets them create one, and they are assigned to it on
 * confirmation.
 */
export function mayImportInto(
  scope: ImportScope,
  warehouseId: number,
): boolean {
  return scope === 'ALL' || scope.includes(warehouseId);
}

/**
 * Roles to grant a non-Owner on a warehouse their import creates: every role of
 * theirs that grants the permission, once each. The Owner already reaches every
 * warehouse and gets none.
 */
export function rolesForNewWarehouse(auth: AuthContext): number[] {
  if (isOwner(auth.user.roles)) return [];
  const ids = auth.user.roles
    .filter(
      (role) => !role.isSystem && role.permissions.includes(INVENTORY_IMPORT),
    )
    .map((role) => role.id);
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Assigns the importing user to a warehouse created by their import, inside the
 * caller's transaction. Assignments that already exist are left as they are.
 * Returns how many were created.
 */
export async function assignCreatorToWarehouse(
  tx: Tx,
  auth: AuthContext,
  warehouseId: number,
): Promise<number> {
  const roleIds = rolesForNewWarehouse(auth);
  if (roleIds.length === 0) return 0;
  const { count } = await tx.roleAssignment.createMany({
    data: roleIds.map((roleId) => ({
      userId: auth.user.id,
      roleId,
      warehouseId,
    })),
    skipDuplicates: true,
  });
  return count;
}
