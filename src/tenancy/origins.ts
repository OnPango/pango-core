/** True when `origin` is the base domain or one of its subdomains (any scheme and port). */
export function isAllowedOrigin(origin: string, baseDomain: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === baseDomain || hostname.endsWith(`.${baseDomain}`);
  } catch {
    return false;
  }
}
