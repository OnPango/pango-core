# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Pango core: the NestJS backend of a multi-tenant inventory SaaS for Colombian SMEs (pymes), with demand forecasting (a separate Python AI service lives outside this repo). The database design — conventions, tables, constraints, business rules, planned views, provisioning and the schema-change workflow — is in `docs/database.md`; read it before touching the data model.

## Language

Everything written or created in the repo is in English: identifiers, comments, database tables/columns/enum values, seed data (roles, permissions, movement types), log and error strings, SQL comments and documentation. Conversation with the user is in Spanish.

## Commands

Package manager is pnpm. The project is ESM (`"type": "module"`, `nodenext`), so relative imports need the `.js` extension.

```bash
pnpm start:dev                      # Nest in watch mode
pnpm build                          # prisma:generate + nest build
pnpm lint                           # oxlint (type-aware); src/generated is ignored
pnpm test                           # vitest unit tests (**/*.spec.ts)
pnpm vitest run src/app.controller.spec.ts   # single test file (-t "<name>" for a single test)
pnpm test:e2e                       # vitest with vitest.config.e2e.ts (**/*.e2e-spec.ts)

pnpm prisma:generate                # generates both clients into src/generated/prisma/{control,tenant}
pnpm db:migrate:control             # prisma migrate deploy for the public schema
pnpm tenant:create --subdomain demo --tax-id 900000000-1 --legal-name "Demo SME SAS" \
  --country CO --city Bogotá --business-sector RETAIL --team-size SIZE_1_5 \
  --product-count COUNT_1_100 --email owner@demo.pango.local --name "Demo Owner"
pnpm tenant:migrate                 # migrate deploy on every tenant + update schema_version
```

Prisma CLI calls always need `--config prisma/control.config.ts` or `--config prisma/tenant.config.ts`. Tenant CLI commands target a schema through the `TENANT_SCHEMA` env var (e.g. `TENANT_SCHEMA=tenant_demo pnpm exec prisma migrate status --config prisma/tenant.config.ts`).

`tsc --noEmit` reports a pre-existing error in `test/app.e2e-spec.ts` (`supertest/types`); it is unrelated to the build.

## Architecture

**Schema-per-tenant on Supabase PostgreSQL**, accessed directly from the backend with Prisma 7 (Supabase's REST API is not used).

- `public` = control plane (organizations, accounts, organization_members, plans). `tenant_<slug>` = one identical copy of the tenant template per organization. Tenant tables have no `organization_id`; the schema is the isolation boundary.
- Customization is always rows, never new columns/tables, so every tenant schema stays identical and one migration updates all of them.
- Two independent Prisma setups, each with its own schema, migrations folder and generated client (`src/generated/` is gitignored, regenerate after schema changes):
  - `prisma/control/` + `prisma/control.config.ts`
  - `prisma/tenant/` + `prisma/tenant.config.ts` (appends `?schema=$TENANT_SCHEMA` to `DIRECT_URL`; `SET search_path` doesn't work because Prisma qualifies tables)
- Connections: `DATABASE_URL` = Supabase transaction pooler (6543) for app queries; `DIRECT_URL` = session pooler (5432) for the CLI, migrations and `scripts/`.
- Runtime (`src/prisma/`, global `PrismaModule`): `ControlPrismaService` is the `public` client; `TenantPrismaService.client(schema)` returns a cached client per schema built with `new PrismaPg({ connectionString }, { schema })`. Callers must verify an ACTIVE membership for (account, organization) before requesting a tenant client. Always pass schema names through `assertTenantSchema` (`/^tenant_[a-z0-9_]{2,41}$/`) before interpolating them into SQL.
- `scripts/tenants.ts` (run with tsx) implements provisioning: validate subdomain → `CREATE SCHEMA` → `migrate deploy` → creator user with the `Owner` role (`warehouseId` null) → organization + ACTIVE membership in `public`; drops the schema on failure. `organizations.schema_version` = number of tenant migrations applied.

### Migrations

- Migrations are generated without a shadow DB with `prisma migrate diff --from-config-datasource --to-schema <schema.prisma> --script` (tenant: set `TENANT_SCHEMA=tenant_demo`), then saved as `<yyyymmddhhmmss>_<name>/migration.sql`. Full steps in `docs/database.md`.
- The tenant `init` migration ends with hand-written SQL (CHECK constraints, partial unique indexes, `NULLS NOT DISTINCT` indexes) that Prisma can't express. The tenant diff always emits `DROP INDEX` for the two `NULLS NOT DISTINCT` indexes — delete those lines from new migrations.
- Tenant base data (permissions, base movement types, `EA` unit, `Owner` role, settings row) lives in the `base_data` migration, not a seed, so new tenants are born with it. Any migration that adds a permission must also grant it to `Owner`.
- Don't edit migrations that are already applied; add a new one.
- Derived values are computed in views (planned, see `docs/database.md`), not stored — except `products.average_cost`. `stock_balances` is a materialized balance that only changes when movements are confirmed; nothing is deleted, mistakes are voided with a reversing movement (`movements.reversal_of_id`).
- Naming: plural `snake_case` tables, `snake_case` columns, singular `snake_case` enum types with `UPPER_CASE` values; Prisma models are singular PascalCase with `@@map`, fields camelCase with `@map`. Keys are `serial`/`integer` (no `bigint`, to avoid `BigInt` in JSON). `created_at`/`updated_at` use `@default(now())` (plus `@updatedAt`) so non-Prisma writers work. Index every foreign key unless it leads a PK/unique index.

## Git workflow (from README)

Main branches are `main` and `dev` (the README says `develop`, but the actual branch is `dev`). Work in `feature/`, `bugfix/`, `release/`, `hotfix/` branches and merge via Pull Request; never commit directly to `main` or `dev`. Commit prefixes: `feat:`, `fix:`, `docs:`, `chore:`.
