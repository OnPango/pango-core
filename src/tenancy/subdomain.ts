// 2–41 chars, lowercase letters, digits and inner hyphens. The length keeps the derived
// schema name (`tenant_` + subdomain) within `assertTenantSchema`'s pattern.
export const SUBDOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}[a-z0-9]$/;

// Subdomains used by the platform itself; organizations cannot take them.
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'cdn',
  'dashboard',
  'docs',
  'help',
  'login',
  'mail',
  'pango',
  'onpango',
  'signup',
  'static',
  'status',
  'support',
  'www',
]);

// Header the frontend can send when the API is not served from the organization's
// subdomain (e.g. `mi-empresa.onpango.com` calling `api.onpango.com`).
export const TENANT_HEADER = 'x-tenant';

export function isValidSubdomain(subdomain: string): boolean {
  return (
    SUBDOMAIN_PATTERN.test(subdomain) && !RESERVED_SUBDOMAINS.has(subdomain)
  );
}

/**
 * Organization subdomain of a request: the `X-Tenant` header, or else the first label
 * of the host when it is a direct subdomain of `baseDomain` (`mi-empresa.onpango.com`).
 * Returns null when neither identifies an organization.
 */
export function resolveSubdomain(
  headers: Record<string, string | string[] | undefined>,
  hostname: string | undefined,
  baseDomain: string | undefined,
): string | null {
  const header = headers[TENANT_HEADER];
  if (typeof header === 'string' && header.trim()) {
    return header.trim().toLowerCase();
  }
  if (!hostname || !baseDomain) return null;
  const host = hostname.toLowerCase();
  const suffix = `.${baseDomain.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes('.') || RESERVED_SUBDOMAINS.has(label)) {
    return null;
  }
  return label;
}
