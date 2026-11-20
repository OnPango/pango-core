import type { Request } from 'express';

/** A role granted to the user, on one warehouse or on all of them (`warehouse` null). */
export interface RoleGrant {
  id: number;
  name: string;
  isSystem: boolean;
  warehouse: { id: number; name: string } | null;
  permissions: string[];
}

export interface SessionProfile {
  account: { id: number; email: string; name: string };
  organization: { id: number; subdomain: string; legalName: string };
  user: { id: number; jobTitle: string | null; roles: RoleGrant[] };
}

/** Set on the request by AuthGuard once the session is verified. */
export interface AuthContext extends SessionProfile {
  organization: SessionProfile['organization'] & { schemaName: string };
}

export type AuthenticatedRequest = Request & { auth?: AuthContext };

// Permission model:
// - ORGANIZATION-scope permissions (catalog, warehouses, roles, …) apply to the whole
//   organization once any of the user's assignments grants them.
// - WAREHOUSE-scope permissions apply only to the warehouse of the assignment that
//   grants them. An assignment with no warehouse (only the Owner, a system role,
//   has one) grants them on every warehouse.

/** The user holds a system role (Owner) on every warehouse. */
export function isOwner(roles: RoleGrant[]): boolean {
  return roles.some((role) => role.isSystem && role.warehouse === null);
}

/**
 * Every permission granted by any assignment. `@RequirePermissions` checks this;
 * handlers narrow WAREHOUSE-scope permissions to the warehouses that grant them.
 */
export function grantedPermissions(roles: RoleGrant[]): Set<string> {
  return new Set(roles.flatMap((role) => role.permissions));
}

/** Permissions that apply on one warehouse: its assignments and the ones with no warehouse. */
export function permissionsInWarehouse(
  roles: RoleGrant[],
  warehouseId: number,
): Set<string> {
  return new Set(
    roles
      .filter((r) => r.warehouse === null || r.warehouse.id === warehouseId)
      .flatMap((r) => r.permissions),
  );
}

/**
 * Warehouses where a permission is granted: `'ALL'` when an assignment with no
 * warehouse grants it, otherwise the ids of the warehouses whose assignments do.
 */
export function warehousesWithPermission(
  roles: RoleGrant[],
  code: string,
): 'ALL' | number[] {
  const granting = roles.filter((role) => role.permissions.includes(code));
  if (granting.some((role) => role.warehouse === null)) return 'ALL';
  return [...new Set(granting.map((role) => role.warehouse!.id))];
}

export function toSessionProfile(auth: AuthContext): SessionProfile {
  const { schemaName: _schemaName, ...organization } = auth.organization;
  return { account: auth.account, organization, user: auth.user };
}
