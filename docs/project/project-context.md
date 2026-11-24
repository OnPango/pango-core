# Project Context

Knowledge that is not visible in the code, the other guides or the Git history: decisions taken with the user, discarded work, findings and open questions. Read it after `CLAUDE.md`, `AGENTS.md`, `README.md` and [`database.md`](../architecture/database.md). Last updated 2026-11-23.

## Sources

- **Repo:** the domain guides in `docs/modules/` (each ends with a "Not done yet" list), [`database.md`](../architecture/database.md) for the data model, [`architecture-workflow.md`](architecture-workflow.md) for roles.
- **Requirements (outside the repo, Spanish):** SRS (RF-*, RNF-*, business rules RN-001..016), use cases CU-01..CU-18 and user stories US-001..047. They used to live in `~/Documents/OnPango/Backend/Context/`; ask the user for their current location. The user implements one CU at a time against them. The repo deliberately deviates in places (configurable RBAC with warehouse-scoped roles, invitations, replenishment parameters per product and warehouse); flag new deviations instead of silently following either side.
- **Forecasting service:** a separate Python service, owned by a colleague of the user, called from `src/forecasting/` (default `http://localhost:8000`). Forecast runs cannot be tested end to end without it running.

## Module status

Merged into `dev`, in order: auth, organizations and invitations (CU-01/02), warehouses (CU-04), roles with warehouse scope, catalog (CU-03), inventory movements (CU-05), replenishment parameters and alerts (CU-12/12a), departments and internal stock requests (CU-08/09), stock queries and lots, demand history (CU-10 A1), forecast runs (CU-10, PR #24).

CU-11 (US-40) is implemented on the feature branch in commit `1c07bfc`. See the [implementation task and validation record](../plans/cu-11-reorder-point.md#implementation-task-for-claude).

## Decisions taken with the user

- **Calculated reorder point (CU-11), approved design:**
  - Formula, upper-band method. H = forecast horizon in days (weeks × 7), L = lead time in days:
    - expected = total estimate × L/H
    - safety stock = (upper − estimate) × √(L/H)
    - reorder point = expected + safety stock
    - Both values are rounded up to 4 decimals.
  - Scope: only product-warehouses with `replenishment_method = FORECAST_ROP`. FIXED_ROP and MIN_MAX keep the manual values.
  - Fallback: keep the manual values in their own columns. When the calculation is not possible, use them and record why: no current OK forecast, no interval or no lead time.
  - When to recalculate: on every change of replenishment parameters, and inside the forecast run's transaction. In the transaction, lock the products in id order, then evaluate the alerts.
  - `service_level` is not used until the forecasting service exposes the interval's nominal level (see open questions).
  - The suggested quantity of an alert targets max(max stock, or the reorder point when unset; reorder point).
- **No default category.** Tenants are born without categories, and a product needs an active category. A seeded "General" category would become a catch-all, and it would be one English name for every tenant. Onboarding friction is to be solved in the frontend, for example by creating a category inline from the product form.

## Discarded work

On 2026-11-23 the user discarded an implementation of CU-11 plus a connection-pool change. It is kept in a Git stash on the user's machine ("reorder-point CU-11 + shared pg pool (discarded)"). Its migration was reverted in every tenant. Treat it as reference only; a new task must be approved before any of it returns.

## Performance findings (not yet addressed)

- `TenantPrismaService` keeps one Prisma client per tenant schema with no cap or eviction, and each client opens its own `pg` pool (10 connections by default). Connections and memory grow linearly with the number of organizations.
- A load test against Supabase from the user's machine (round-trip about 300 ms) measured the discarded alternative:
  - Change: one shared `pg.Pool`, an LRU of clients, and Prisma's `relationJoins` preview feature.
  - The per-request auth context went from 9 queries (3.4 s) to 2 (0.7 s).
  - At concurrency 20, throughput rose from 7 to 15 req/s and the median latency fell from 2.6 s to 0.9 s.
  - At concurrency 50, throughput rose from 8 to 18 req/s and the median latency fell from 6.3 s to 2.3 s.
  - No 5xx errors in either case.
- A shared pool does not weaken tenant isolation:
  - Every tenant already connects with the same role, through the same Supabase pooler.
  - Isolation comes from the membership check, `assertTenantSchema` and schema-qualified SQL.
  - The only risk is session state left on a connection: `SET` without `LOCAL`, `SET ROLE`, temporary tables. None exists in application code.
- Deploy the API in the same AWS region as the Supabase project; round-trip latency dominates request time.

## Open questions for the forecasting service owner

- The interval's nominal coverage level, or an error standard deviation, so that `service_level` can drive the safety stock.
- Whether clamping a negative closing stock to 0 in the demand sent is acceptable.
- A degenerate horizon-total interval (upper equal to estimate) was observed in one run.

## Lessons for implementation and review

- Prisma qualifies every table with the client's schema, so `SET search_path` has no effect on application queries. Raw SQL must quote and qualify `"${schema}"` after `assertTenantSchema`.
- Provisioning replays the tenant migration SQL under `SET LOCAL search_path`, so a tenant migration must not qualify tables with a schema name.
- The tenant `migrate diff` always emits `DROP INDEX` for the two `NULLS NOT DISTINCT` indexes; delete those lines.
- Run `pnpm prisma:generate` after any schema change; `src/generated/` is not committed.
- Specs can pass falsely: a service that catches errors and marks a run as failed still satisfies loose assertions. Assert exact call counts and final states, and mock the modules a transaction calls.
- Never write credentials or tokens into the repo; pass them through environment variables.
- Leftover test data: in tenant `tenant_forecast_test`, product CAS-SEG in its "Bodega" warehouse is `FORECAST_ROP` with lead time 70, reorder point 28.62 and an open alert.
