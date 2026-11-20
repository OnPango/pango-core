const TENANT_SCHEMA_PATTERN = /^tenant_[a-z0-9_]{2,41}$/;

// `tenant_` + subdomain with `-` replaced by `_`.
export function schemaFromSubdomain(subdomain: string): string {
  return assertTenantSchema(`tenant_${subdomain.replaceAll('-', '_')}`);
}

// Always validate before interpolating the schema name into SQL.
export function assertTenantSchema(schema: string): string {
  if (!TENANT_SCHEMA_PATTERN.test(schema)) {
    throw new Error(`Invalid tenant schema name: ${schema}`);
  }
  return schema;
}
