# Pango — Database

Pango is a multi-tenant inventory management SaaS for SMEs, with demand forecasting. This document describes how the database is organized and the rules the application must enforce. Column-level detail lives in the Prisma schemas, which are the source of truth:

- Control plane: [`prisma/control/schema.prisma`](../prisma/control/schema.prisma)
- Tenant template: [`prisma/tenant/schema.prisma`](../prisma/tenant/schema.prisma)

Models carry `///` doc comments, which also show up in the generated clients.

## Architecture

- **PostgreSQL 15+ on Supabase**, accessed directly from the NestJS backend through Prisma 7 and `@prisma/adapter-pg`. The Supabase REST API is not used.
- **Schema per tenant**:
  - `public`: control plane (organizations, accounts, organization_members, invitations, refresh tokens, plans). One shared copy.
  - `tenant_<slug>`: an identical copy of the tenant template per organization (e.g. `tenant_acme_co`). Tenant tables have no `organization_id`; the schema is the isolation boundary.
- **Customization is always rows, never columns or tables.** Every tenant schema stays identical, so one migration updates all of them.
- **Two Prisma setups**, each with its own schema, migrations folder, config and generated client (`src/generated/prisma/{control,tenant}`).
  - At runtime the tenant schema is selected with `new PrismaPg({ connectionString }, { schema })`; `TenantPrismaService` caches one client per schema.
  - In migrations it is selected with `?schema=tenant_x` in the URL (`prisma/tenant.config.ts` reads `TENANT_SCHEMA`). `SET search_path` does not work because Prisma qualifies table names with the schema.
- **Connections**:
  - `DATABASE_URL`: Supabase transaction pooler (port 6543, `?pgbouncer=true`) for application queries.
  - `DIRECT_URL`: session pooler (5432) or direct connection, for the CLI, migrations and scripts.

## Conventions

- **Language:** every identifier, enum value, seed row and comment is in English.
- **Naming:** tables are plural `snake_case` (`stock_balances`); columns are `snake_case`; enum types are singular `snake_case` (`movement_status`) with `UPPER_CASE` values. In Prisma, models are singular PascalCase mapped with `@@map`, fields are camelCase mapped with `@map`.
- **Keys:** `serial` / `integer` primary keys, not `bigint`, to avoid `BigInt` in JSON. Join tables use composite primary keys. Foreign keys are named `<target>_id`; foreign keys to `users` that describe a role use `<role>_by_id` (`registered_by_id`).
- **Booleans** are prefixed with `is_` / `allow_` / `tracks_` / `counts_as_`.
- **Timestamps:** `timestamptz` everywhere. Mutable entities have `created_at` and `updated_at`, both with `DEFAULT now()` in the database, so writers other than Prisma (the Python forecasting service) work too. Prisma also refreshes `updated_at` on every update. Calendar dates with no time (`start_date`, `expiry_date`) are `date`.
- **Money and quantities:** `numeric(14,4)`; plan prices `numeric(12,2)`.
- **Foreign-key indexes:** PostgreSQL does not index foreign keys automatically. Every foreign key used in joins or cascades has an index, or is the leading column of a primary key or unique index.
- **Enums:** control enums live in `public`. Tenant enums are created inside each tenant schema, because Prisma does not share types between `.prisma` files.
- **Derived values are not stored.** They are computed in views (see below). The only exception is `products.average_cost`, a cache recalculated when inbound movements are confirmed.
- **Movements are the source of truth.** `stock_balances` is a materialized balance that only changes when movements are confirmed. Nothing is deleted: mistakes are voided with a reversing movement (`movements.reversal_of_id`).

## Control plane (`public`)

| Table | Purpose |
|---|---|
| `plans` | Commercial plans and the limits they grant (`max_users`, `max_warehouses`). |
| `organizations` | Customer organizations. `schema_name` points to their tenant schema; `schema_version` is the number of tenant migrations applied. Profile: optional `tax_id` (NIT, unique when present), `country` (ISO 3166-1 alpha-2), `city`, `business_sector`, `team_size` and `product_count` (range enums), optional `contact_phone`. |
| `subscriptions` | Plan history per organization. |
| `accounts` | Login identities: lowercase email, name, Argon2id `password_hash` (NULL = cannot log in yet) and `email_verified_at` (NULL = the owner has not confirmed the email; login is blocked). |
| `account_tokens` | Single-use emailed tokens per account (`EMAIL_VERIFICATION`). Stores only the SHA-256 of the token. |
| `organization_members` | Account ↔ organization (N:M), with `INVITED → ACTIVE → SUSPENDED` status and `joined_at`. |
| `organization_invitations` | Invitations of an email to an organization, with the tenant role (and optional warehouse) to grant. Stores only the SHA-256 of the token. |
| `refresh_tokens` | Refresh tokens of login sessions, bound to one organization. Stores only the SHA-256 of the token. |

Rules:

- `organizations.country` is checked against `^[A-Z]{2}$` (`organizations_country_chk`, hand-written in the migration).
- `organizations.schema_name` = `tenant_` + subdomain with `-` replaced by `_`. Validate it against `^tenant_[a-z0-9_]{2,41}$` (`assertTenantSchema`) before interpolating it into SQL.
- On every request, verify that an `ACTIVE` membership exists for (account, organization) **before** using the tenant schema.
- One pending invitation per (organization, email): partial unique index `organization_invitations_pending_key` (hand-written). Invitation emails are lowercase (`organization_invitations_email_lowercase_chk`). The control diff emits `DROP INDEX` for the partial index — remove that line from new migrations.
- `organization_invitations.role_id` / `warehouse_id` are logical references into the tenant schema (no foreign key).

Authentication and the invitation flow are described in [`auth.md`](auth.md).

## Tenant template (`tenant_<slug>`)

### Users, access and settings

| Table | Purpose |
|---|---|
| `settings` | Single row (`id = 1`) of organization-wide settings: currency, time zone, forecast granularity, costing method, negative stock, reservation expiry, movement types for replenishment drafts and for fulfilling stock requests. |
| `departments` | Internal areas that request and consume stock. |
| `users` | An account's profile inside the organization. `account_id` is a logical reference to `public.accounts.id` (no foreign key: it crosses schemas). |
| `roles`, `permissions`, `role_permissions` | RBAC. `permissions` is a fixed catalog seeded by migrations; organizations only group permissions into roles. |
| `role_assignments` | Grants a role to a user on one warehouse, or on every warehouse when `warehouse_id` is NULL. |
| `role_movement_types` | Movement types a role is allowed to register. |
| `notification_rules` | Which roles are notified of which alert types, and through which channel. |

### Catalog

| Table | Purpose |
|---|---|
| `categories` | Category (product family) tree (`parent_id`). Names are unique among siblings (case-insensitive, enforced by the application). Inactive categories keep their products but cannot receive new ones. |
| `units_of_measure` | Units products are counted in (`products.stock_unit_id`) and location capacity is expressed in (`locations.capacity_unit_id`). |
| `products` | Products (SKU, category, `stock_unit_id` = unit every quantity of the product is counted in, optional physical data `length_cm`/`width_cm`/`height_cm`/`weight_kg`/`volume_l`, lot tracking, cached average cost). Never deleted, only deactivated. |
| `suppliers`, `supplier_products` | Suppliers and the products they sell, with price, lead time and one preferred supplier per product. |
| `custom_attributes`, `attribute_options`, `attribute_values` | Organization-defined product fields (EAV), optionally scoped to a category. `LIST` attributes take their values from `attribute_options`. |

### Warehouse

| Table | Purpose |
|---|---|
| `warehouses` | Storage warehouses (`WAREHOUSE`) and stores (`STORE`). Code and name unique in the organization (the name case-insensitively, checked by the application). `default_location_id` points to the location created with the warehouse. Never deleted, only deactivated (and only without stock on hand). |
| `location_levels` | Named levels of a warehouse's location hierarchy, by `depth` (1 = top). |
| `locations` | Places where stock is kept, arranged as a tree (`parent_id`). Each belongs to one warehouse (`warehouse_id`), with a code unique within it. `level_id` is NULL only for the warehouse's default location (code `DEFAULT`). |
| `product_warehouses` | A product enabled in a warehouse, with its replenishment parameters (method, service level, lead time, min/max, safety stock, reorder point). |
| `lots` | Lots of products that track them. |
| `stock_balances` | On-hand quantity per product-warehouse, location and lot. |

### Movements

| Table | Purpose |
|---|---|
| `movement_types` | Movement types with their nature (`INBOUND`, `OUTBOUND`, `TRANSFER`, `ADJUSTMENT`) and whether they count as demand. |
| `movements` | Movement header: type, status, who registered and received it, and its link to a stock request, supplier, department or reversed movement. |
| `movement_lines` | Products, locations, lots, quantities and unit costs of a movement. |

### Stock requests

| Table | Purpose |
|---|---|
| `stock_requests` | Internal requests from a department (requesting area) to a warehouse (attending side): type, status, priority, rejection reason. |
| `stock_request_lines` | Requested and reserved quantity per product. |
| `stock_request_events` | Status history of a request: status, user, date and reason. |

### Forecasting and alerts

| Table | Purpose |
|---|---|
| `forecast_runs` | One execution of the forecasting service. |
| `forecasts` | Forecast per product-warehouse and run: model, demand class, error metric. One is current per product-warehouse. |
| `forecast_periods` | Estimated demand and bounds per period. |
| `alerts` | Stock alerts (`BELOW_ROP`, `STOCKOUT`, `OVERSTOCK`) with the available stock and reorder point they were raised with, optionally linked to a draft replenishment movement. |
| `notifications` | Delivery of an alert to a user through a channel. |

### Constraints in hand-written SQL

Prisma cannot express these, so they live at the end of the tenant `init` migration (or of the migration noted):

| Constraint | Rule |
|---|---|
| `settings_singleton_chk` | `settings.id = 1`. |
| `role_assignments_user_role_warehouse_key` | Unique `(user_id, role_id, warehouse_id)` `NULLS NOT DISTINCT`. |
| `stock_balances_product_warehouse_location_lot_key` | Unique `(product_warehouse_id, location_id, lot_id)` `NULLS NOT DISTINCT`. |
| `supplier_products_preferred_key` | At most one preferred supplier per product (partial unique index). |
| `forecasts_current_key` | At most one current forecast per product-warehouse (partial unique index). |
| `alerts_open_key` | At most one `OPEN` alert per product-warehouse and type (partial unique index, `alert_snapshot` migration). |
| `attribute_values_single_value_chk` | Exactly one value column is set. |
| `stock_request_lines_quantities_chk` | `requested > 0` and `0 ≤ reserved ≤ requested`. |
| `movement_lines_quantities_chk` | `quantity > 0` and `0 ≤ received ≤ quantity`. |
| `movement_lines_location_chk` | At least one of origin / destination location. |
| `movements_reversal_chk` | A movement cannot reverse itself. |
| `product_warehouses_parameters_chk` | `0 < service_level < 1`, `lead_time_days ≥ 0`, `max_stock ≥ min_stock`. |
| `supplier_products_values_chk` | Non-negative price and lead time. |
| `location_levels_depth_chk` | `depth ≥ 1`. |
| `forecast_runs_horizon_chk` | `horizon ≥ 1`. |
| `forecast_periods_bounds_chk` | `lower_bound ≤ estimated_demand ≤ upper_bound`. |
| `products_physical_data_chk` | Physical data is NULL or non-negative (`catalog_fields` migration). |

### Base data

The `base_data` migration seeds every new tenant (it is a migration, not a seed, so every tenant is born with it):

- **`permissions`**: 30 permissions.
  - `ORGANIZATION` scope (applies to the whole organization once any assignment grants it): `role.read`, `role.manage`, `department.manage`, `settings.manage`, `warehouse.manage`, `catalog.read`, `product.manage`, `category.manage`, `attribute.manage`, `supplier.manage`, `movement_type.manage`, `forecast.run`, `notification.manage`.
  - `WAREHOUSE` scope (applies on the assignment's warehouse): `user.read`, `user.manage` (moved here by `warehouse_scoped_roles`), `warehouse.read`, `location.manage`, `stock.read`, `replenishment.manage`, `movement.read`, `movement.create`, `movement.confirm`, `movement.receive`, `movement.void`, `stock_request.read`, `stock_request.create`, `stock_request.approve`, `forecast.read`, `alert.read`, `alert.resolve`.
- **`movement_types`** (`is_base = true`):

  | name | nature | counts_as_demand |
  |---|---|---|
  | Opening balance | INBOUND | no |
  | Purchase receipt | INBOUND | no |
  | Consumption issue | OUTBOUND | yes |
  | Sales issue | OUTBOUND | yes |
  | Transfer | TRANSFER | no |
  | Inventory adjustment | ADJUSTMENT | no |

  "Sales issue" comes from the `sales_issue_movement_type` migration, which also allows it to Owner, Admin and Operator.

- **`units_of_measure`**: `EA` (Each); `catalog_fields` adds `KGM`, `GRM`, `LTR`, `MLT`, `MTR`, `BX`, `PK`.
- **`roles`**: `Owner` (`is_system = true`) with every permission and every movement type.
- **`roles`** (`warehouse_scoped_roles` migration): `Admin` (`is_system = false`), every permission except `role.manage` and `settings.manage`, and every movement type.
- **`roles`** (`operator_role` migration): `Operator` (`is_system = false`), the MVP's second fixed role, with every base movement type and the catalog, warehouse, stock, movement, stock request, forecast and alert permissions; none of `user.*`, `role.*`, `department.manage`, `settings.manage`, `attribute.manage`, `movement_type.manage`, `notification.manage`.
- **`settings`**: row `id = 1`, with replenishment drafts using "Purchase receipt"; the `stock_request_cycle` migration sets stock requests to be fulfilled with "Consumption issue".

**Any future migration that adds a permission must also grant it to the Owner role.**

### Business rules enforced by the application

These span several tables, so a `CHECK` cannot express them:

- **Access:** a user can act on a warehouse if they have a `role_assignment` for that warehouse (or with `warehouse_id` NULL = every warehouse), and the role includes the permission. For movements, the role must also allow the type in `role_movement_types`. `ORGANIZATION`-scope permissions apply to the whole organization once any assignment grants them.
- **Role assignments:** `warehouse_id` is NULL only for system roles (Owner), and every system-role assignment has it NULL. Except the Owner, a user grants or removes a role on a warehouse only with `user.manage` there and when the role is below their level there (a strict subset of their permissions there, and not a role they hold there).
- **Owner role:** cannot be edited or deleted, keeps every permission and always has at least one active holder.
- **Movement lines by nature:** `INBOUND` → destination only; `OUTBOUND` → origin only; `TRANSFER` → origin and destination; `ADJUSTMENT` → destination (increase) or origin (decrease).
- **Movement status:** `DRAFT → CONFIRMED` (updates `stock_balances`). Voiding a confirmed movement registers a reversing movement with `reversal_of_id` and marks the original `VOIDED`.
  - Inter-warehouse transfer: `DRAFT → IN_TRANSIT` (dispatch: decreases the origin) `→ CONFIRMED` (receive: adds `received_quantity` at the destination, sets `received_by_id` and `received_at`).
  - Within a single warehouse, confirmation is one step.
- **Locations:** a location's parent belongs to the same warehouse, on the level with `depth` one lower. A location's level belongs to its warehouse. Every warehouse has exactly one default location (`warehouses.default_location_id`, created with it, no level, code `DEFAULT`); the code `DEFAULT` is reserved for it. The location of a `stock_balance` and a `default_location_id` must belong to the warehouse of their `product_warehouse`.
- **Stock balances** exist only for products enabled in that warehouse (a `product_warehouse` row exists; registering a movement creates it when stock first arrives there). They cannot go negative unless `settings.allow_negative_stock`.
- **Lots** only for products with `tracks_lots = true`.
- **Products:** the SKU is unique case-insensitively (the application checks it; the index is case-sensitive). The SKU and `tracks_lots` cannot change once the product has movement lines (`tracks_lots` also not once it has lots). New products need an active category.
- **Custom attributes:** the filled column in `attribute_values` must match `data_type` (`LIST` → `option_id`, and the option must belong to the same attribute). `is_required` attributes are enforced when creating products of their category. Block changes to `data_type` once the attribute has values.
- **Reservations:**
  - Stock request cycle: `PENDING → IN_PROGRESS → FULFILLED`, or `REJECTED` (with `rejection_reason`), or `CANCELLED` while `PENDING`; each change adds a `stock_request_events` row. Details in [`stock-requests.md`](stock-requests.md).
  - Starting the attention (`IN_PROGRESS`) reserves the full requested quantity of every line (`reserved_quantity`), only if the warehouse's available stock covers it (no partial attention, RN-016).
  - The movement that fulfils it releases the reservation; rejecting releases it too.
  - When `reservation_expires_at` is set, the reservation is released automatically after it. `settings.reservation_expiry_days` proposes the default.
- **Replenishment:** the reorder point is compared against **available** stock (on hand − reserved), not on hand. Reaching it opens a `BELOW_ROP` alert; rising above it again resolves the alert (`RESOLVED`, `resolved_at`). A reorder point of 0 means none. Planned: the alert also creates a `DRAFT` movement of type `settings.replenishment_movement_type_id`, with the preferred supplier and `suggested_quantity`, and confirming it resolves the alert. Details in [`replenishment.md`](replenishment.md).
- **Demand history** (forecast input): `CONFIRMED` outbound movements whose type has `counts_as_demand = true`: sales ("Sales issue", the demand of a point of sale) and internal consumption. Movements of the stock request type (`settings.stock_request_movement_type_id`, "Consumption issue") count only when they fulfil a stock request (`stock_request_id` set), so consumption is always traceable to a department (RN-008, extended to sales).

### Views (planned)

Derived values will be exposed as views in a later tenant migration:

- `v_product_warehouse_stock`: per `product_warehouse` → `on_hand` (sum of `stock_balances.quantity`), `reserved` (reservations of active stock requests for that product and warehouse) and `available` (the difference).
- `v_stock_ledger`: confirmed movements with a running balance per product and warehouse.
- `v_demand_history`: confirmed demand outbound movements aggregated per `product_warehouse` and period (per `settings.forecast_granularity`).
- `v_in_transit`: lines of movements in `IN_TRANSIT`.
- Fulfilled quantity per stock request line: sum of the lines of the confirmed movements that fulfil the request, per product.

## Workflows

### Changing the schema

1. Edit the `.prisma` file and run `pnpm prisma:generate`.
2. Generate the SQL without a shadow database, from the current state of a migrated database:

   ```bash
   # control plane
   pnpm exec prisma migrate diff --config prisma/control.config.ts \
     --from-config-datasource --to-schema prisma/control/schema.prisma --script
   # tenant template (diff against any up-to-date tenant)
   TENANT_SCHEMA=tenant_demo pnpm exec prisma migrate diff --config prisma/tenant.config.ts \
     --from-config-datasource --to-schema prisma/tenant/schema.prisma --script
   ```

3. Save the output as `prisma/<control|tenant>/migrations/<yyyymmddhhmmss>_<name>/migration.sql`. **Remove** any statement that drops the hand-written constraints. The tenant diff always emits `DROP INDEX` for `role_assignments_user_role_warehouse_key` and `stock_balances_product_warehouse_location_lot_key`, because Prisma does not know about them.
4. Apply it: `pnpm db:migrate:control`, or `pnpm tenant:migrate` for every tenant.

Never edit a migration that has already been applied; add a new one.

### Provisioning an organization

`POST /auth/signup` and `pnpm tenant:create` share `provisionOrganization` (`src/tenancy/provision-organization.ts`). In **one transaction** on `DIRECT_URL` it:

1. Validates the subdomain and derives `tenant_<slug>`.
2. `CREATE SCHEMA "tenant_<slug>"`.
3. Runs every `prisma/tenant/migrations/*/migration.sql` with `SET LOCAL search_path` and records them in the schema's `_prisma_migrations` table (same DDL and SHA-256 checksums as Prisma, so `pnpm tenant:migrate` keeps working).
4. Inserts the owner `account` (or reuses an existing one), the `organization` and its `ACTIVE` `organization_members` row in `public`.
5. Creates the owner's `user` with an Owner `role_assignment` (`warehouse_id` NULL).

If anything fails the transaction rolls back and nothing is left behind. At runtime the migration files are read from `TENANT_MIGRATIONS_DIR` (default `prisma/tenant/migrations`), so the image must include them.

## Changes from the original design

Besides translating every identifier and seed row of the original (Spanish) design to English, this version:

- Uses plural table names and a consistent boolean prefix (`is_active`, `is_system`, …).
- Adds `created_at` / `updated_at` (with database defaults) to mutable entities. `organizations.fecha_alta` became `created_at`; `memberships.fecha_ingreso` became a nullable `joined_at`, set when the invitation is accepted.
- Turns the free-text `settings.costing_method` into the `costing_method` enum.
- Replaces the free-text `locations.capacity_unit` with `capacity_unit_id → units_of_measure`.
- Adds `movements.reversal_of_id` so every reversing movement points to the movement it voids.
- Adds `forecast_runs.finished_at` and `alerts.resolved_at`.
- Adds `suppliers.is_active`, since suppliers referenced by movements cannot be deleted.
- Adds `channel` to the `notifications` primary key (the same alert can reach a user in-app and by email), and makes `notification_rules` unique per (role, alert type, channel).
- Adds the missing foreign-key indexes, and drops indexes that duplicated the leading column of a unique index.
- Adds the `movements_reversal_chk`, `forecast_runs_horizon_chk` and `forecast_periods_bounds_chk` checks.
