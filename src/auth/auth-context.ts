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

/**
 * Permission codes granted on every warehouse (assignments with no warehouse).
 * ORGANIZATION-scope permissions only count here.
 */
export function organizationWidePermissions(roles: RoleGrant[]): Set<string> {
  return new Set(
    roles
      .filter((role) => role.warehouse === null)
      .flatMap((r) => r.permissions),
  );
}

export function toSessionProfile(auth: AuthContext): SessionProfile {
  const { schemaName: _schemaName, ...organization } = auth.organization;
  return { account: auth.account, organization, user: auth.user };
}
