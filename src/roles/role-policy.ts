import { HttpStatus } from '@nestjs/common';
import {
  type AuthContext,
  isOwner,
  permissionsInWarehouse,
} from '../auth/auth-context.js';
import { apiError, authErrors } from '../auth/auth-errors.js';

export const rolePolicyErrors = {
  scopeInvalid: () =>
    apiError(
      HttpStatus.BAD_REQUEST,
      'ASSIGNMENT_SCOPE_INVALID',
      'System roles (Owner) apply to every warehouse; every other role needs a warehouse',
    ),
  notBelowYours: () =>
    apiError(
      HttpStatus.FORBIDDEN,
      'ROLE_NOT_BELOW_YOURS',
      'On that warehouse you can only grant, remove or manage roles below your own',
    ),
};

/** A role with the codes of its permissions. */
export interface RoleWithPermissions {
  id: number;
  isSystem: boolean;
  permissions: string[];
}

/**
 * Whether `role` is below the actor's level on `warehouseId`: the actor does not
 * hold the role there, holds every permission of the role there, and holds at
 * least one more. So an Admin can grant Operator but not Admin (nor a copy of it).
 */
export function isBelowActor(
  auth: AuthContext,
  role: RoleWithPermissions,
  warehouseId: number,
): boolean {
  const holdsRole = auth.user.roles.some(
    (held) =>
      held.id === role.id &&
      (held.warehouse === null || held.warehouse.id === warehouseId),
  );
  if (holdsRole) return false;
  const held = permissionsInWarehouse(auth.user.roles, warehouseId);
  const codes = new Set(role.permissions);
  return [...codes].every((code) => held.has(code)) && codes.size < held.size;
}

/**
 * Who may assign (or remove) `role` on `warehouseId` (null = every warehouse):
 * - System roles (Owner) apply to every warehouse, and only the Owner grants them.
 * - The Owner grants any other role on any warehouse.
 * - Anyone else needs `user.manage` on that warehouse, and the role must be
 *   below their own there (see `isBelowActor`), so nobody grants their own level.
 */
export function assertCanAssign(
  auth: AuthContext,
  role: RoleWithPermissions,
  warehouseId: number | null,
): void {
  if (role.isSystem !== (warehouseId === null)) {
    throw rolePolicyErrors.scopeInvalid();
  }
  if (isOwner(auth.user.roles)) return;
  if (warehouseId === null) throw authErrors.forbidden();

  const held = permissionsInWarehouse(auth.user.roles, warehouseId);
  if (!held.has('user.manage')) throw authErrors.forbidden();
  if (!isBelowActor(auth, role, warehouseId)) {
    throw rolePolicyErrors.notBelowYours();
  }
}
