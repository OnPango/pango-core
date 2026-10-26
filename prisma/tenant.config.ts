import 'dotenv/config';
import { defineConfig } from 'prisma/config';

const TENANT_SCHEMA_PATTERN = /^tenant_[a-z0-9_]{2,41}$/;

// Per-organization template. The target schema comes from TENANT_SCHEMA and is
// appended to the direct URL as `?schema=` (SET search_path does not work with Prisma).
function tenantUrl(): string {
  const baseUrl = process.env.DIRECT_URL ?? '';
  const schema = process.env.TENANT_SCHEMA;
  if (!schema) return baseUrl;
  if (!TENANT_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Invalid TENANT_SCHEMA: ${schema}`);
  }
  const url = new URL(baseUrl);
  url.searchParams.set('schema', schema);
  return url.toString();
}

export default defineConfig({
  schema: 'tenant/schema.prisma',
  migrations: { path: 'tenant/migrations' },
  datasource: { url: tenantUrl() },
});
