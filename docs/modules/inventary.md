# Pango — Inventory import

Imports a company's current stock (an opening) into Pango from one spreadsheet, so it starts with the inventory it has today. Code: `src/inventory-imports/`. This document is the source of truth for the module: approved rules, decisions, progress and, from INV-002, the frontend contract.

**Status: complete (INV-017 accepted on 2026-11-25).** Implemented: the `inventory.import` permission (INV-004), the staging tables (INV-005) and the session routes `GET /inventory-imports/fields`, `POST /inventory-imports`, `GET /inventory-imports`, `GET /inventory-imports/:id` and `POST /inventory-imports/:id/cancel` (INV-007), `POST /inventory-imports/:id/rows` (INV-008), `POST /inventory-imports/:id/validate` (INV-009), `GET /inventory-imports/:id/rows` and `GET /inventory-imports/:id/issues` (INV-010), and `POST /inventory-imports/:id/confirm` (INV-011). Failure recovery (INV-012), security (INV-013), testing (INV-014), performance (INV-015) and the verified contract (INV-016) are done. Not yet applied to Supabase, and the frontend page is not built.

## Overview

- The organization downloads Pango's standard template from the frontend, fills it and uploads it in the frontend.
- The browser reads the workbook and sends its rows to the API as JSON, in batches of one import session. The API never receives, parses or generates a spreadsheet.
- The API validates every row against the organization's current data, shows a preview, and on confirmation writes everything in one transaction, or nothing.
- Each row says what the company has and where: product, warehouse, location, lot and quantity. The import only puts stock where there was none: it never compares, subtracts or replaces existing stock.

## Handoff: read this first

For anyone (person or agent) continuing the module. Updated 2026-11-25: every stage, INV-000 to INV-017, is accepted.

### Where the work is

- Branch `feature/inventory-import`, created from `dev` at `bd52a65`. Check `git status` and `git log` before anything else: until the owner asks for commits, the work may exist only as uncommitted files, and resetting or discarding them loses it.
- This document is the source of truth: requirements (INV-FR, INV-BR, INV-API, INV-TD), decisions (ADR-INV-001..013), API contract, frontend guide, technical design, progress and traceability. Read it whole before changing code.
- Repository rules are in `CLAUDE.md`: talk to the owner in Spanish, write code and docs in English, never commit or push unless asked, never push to `dev` or `main`.

### How the owner runs the work

- One stage at a time (Progress table). "Autorizo INV-N" also approves that stage's proposal: show the proposal, implement it at once, and stop only for the owner's final acceptance. Never start the next stage, or mark one `ACCEPTED`, without the owner's explicit words; passing tests are not acceptance.
- Each stage: tests (unit and real PostgreSQL), a deliberate break of the code to prove the tests catch it (then revert), and an update of this document (status line, Progress, traceability evidence, Change log) before the report.
- Nothing is applied to Supabase until the module is finished and works with the frontend (owner, 2026-11-24). Migrations run only against the local test database.
- Scope is the inventory import only: propose nothing outside it.

### What exists

- Migrations: `20261124100000_inventory_import_permission` (the permission) and `20261124200000_inventory_imports` (staging tables and `movements.inventory_import_id`). The only change to an existing table is that nullable column.
- `src/inventory-imports/`:
  - `fields.ts`: the 21 fields, unit aliases and the mapping check; every other part reads it.
  - `inventory-import-config.ts`: the configurable limits.
  - `inventory-import-access.ts`: permission scope and the automatic role assignment for new warehouses.
  - `batch.ts`: batch shape; `parse.ts`: cell parsing; `lookups.ts`: the eight set-based reads of tenant data.
  - `validate.ts`: every row rule, pure, returning row previews, issues, summary and the **plan** (entities to create and stock lines).
  - `confirm.ts`: the confirmation's locks and the writing of the plan (entities, then stock through `MovementsService.record()`).
  - `inventory-imports.service.ts` and `.controller.ts`: fields, create, get, cancel, list, send rows, validate, preview rows, issues and confirm.
- Tests: unit in `src/inventory-imports/*.spec.ts`; real PostgreSQL in `test/integration/*.int-spec.ts`.

### What is left

- Nothing inside the module. Outside it: the frontend import page, Supabase migrations (with the owner's authorization) and the pull request to `dev`; see "Final report", item 16. Performance (INV-015) was measured locally with simulated latency; measure again against Supabase once the migrations are applied there. Security (INV-013) and testing (INV-014) are done; see their open, pre-existing findings. Failures injected in the middle of a confirmation (INV-011) and recovery (INV-012) are already covered.

### Known traps

- Identities (SKU, warehouse code and name, category name, location code) match ignoring case but **not** accents (`lower()`); lists and units also ignore accents.
- Run integration tests with `env -u DATABASE_URL -u DIRECT_URL pnpm test:int`, after `docker compose -f docker-compose.test.yml up -d`. The harness refuses any non-local database.
- `tsx` cannot boot Nest (no decorator metadata): for application-level checks, run `pnpm build` and use `dist/`.
- Do not use `pkill` on this machine: it matched a system process. Start test servers with a `timeout`.
- Prettier rewrites files; prefer the editor tool over scripted text replacements.
- Every import transaction bounds its lock waits (`boundWaits`); keep it in any new transaction, or a blocked statement holds its connection past Prisma's timeout.
- `pnpm exec tsc --noEmit` has three errors from before this module (`test/app.e2e-spec.ts:4`, `src/movement-imports/movement-imports.service.spec.ts:429` and `:432`); they are not regressions.

### Checks

```bash
pnpm lint && pnpm exec tsc --noEmit && pnpm test && pnpm build
# benchmark, several minutes: pnpm test:perf (PERF_PLAN=rows:roundTripMs,... to choose)
docker compose -f docker-compose.test.yml up -d
env -u DATABASE_URL -u DIRECT_URL pnpm test:int
```

At handoff: 390 unit and 72 integration tests passed.

## Scope

In scope: an opening of current stock for products that track quantity or lots, in one or more warehouses or stores; creating the products, categories, warehouses and lots it needs; validation, preview and atomic confirmation.

Out of scope:

- Reconciling against existing stock (raising or lowering quantities already in Pango) and physical counts. Corrections after an opening use the existing manual adjustment movements.
- Historical movements, sales, purchases or demand: that is the movement history import ([`movement-imports.md`](movement-imports.md)), which this module does not change.
- Generating or parsing workbooks in the API, and native spreadsheet validation (see ADR-INV-003).
- Suppliers, custom attributes, location hierarchies, units of measure, changes to existing products or warehouses.
- The frontend implementation (`pango-frontend`); this repository documents its contract only.

## Approved requirements

### Functional

| ID | Requirement |
|---|---|
| INV-FR-01 | One import session receives one file shaped like the standard template. The frontend sends its rows in batches; all of them belong to the same session. |
| INV-FR-02 | A file with more rows than the per-session limit (5,000 by default, configurable; ADR-INV-013) is rejected; the user splits it into several files. The limit is revised only with new measurements (INV-015). |
| INV-FR-03 | All or nothing per session: every definitive change of a session (categories, products, warehouses and their default locations, product-warehouses, lots, stock, average costs, alerts and the confirmation result) commits together or not at all. |
| INV-FR-04 | Sessions are independent: a failed session leaves earlier confirmed sessions untouched, and every session validates against the current database. |
| INV-FR-05 | A row's identity is product + warehouse + location + lot (or no lot). A row is accepted only if that identity never had stock or movements in Pango; otherwise it is a blocking error. |
| INV-FR-06 | The import never subtracts stock and never treats an absent identity as zero. |
| INV-FR-07 | Every validation is done by the server; the preview is mandatory before confirmation, and confirmation names the validated revision. |
| INV-FR-08 | The import never generates demand (see ADR-INV-006). |
| INV-FR-09 | The template is a static file served by the frontend; the API has no template endpoint and never reads a workbook. |

### Business rules (D1–D15)

| ID | Rule |
|---|---|
| INV-BR-01 (D1) | A stock row without unit cost is accepted with a `COST_MISSING` warning. The line then takes the product's current average cost (0 for a new product), as inbound movements already do. |
| INV-BR-02 (D2) | An existing product is matched by SKU, ignoring case. A different stock unit or lot tracking is an error. A different name, category, description or physical data is a warning: Pango's value is kept. The import never updates an existing product. |
| INV-BR-03 (D3) | An inactive product, warehouse or category is an error. |
| INV-BR-04 (D4) | A quantity above 0 in a warehouse that does not hold stock (`holds_stock = false`) is an error. |
| INV-BR-05 (D5) | A category is matched by name, ignoring case, anywhere in the tree: one match is reused, several are an error (`CATEGORY_AMBIGUOUS`), none creates it at the top level. |
| INV-BR-06 (D6) | A warehouse is matched by code when given, otherwise by name (both ignoring case). When both are given they must match the same warehouse. A new warehouse requires a code; its type defaults to `WAREHOUSE`. |
| INV-BR-07 (D7) | A blank location means the product's default location in the warehouse, or else the warehouse's `DEFAULT` location. A given location must exist in the warehouse and be active. No location is created. |
| INV-BR-08 (D8) | The lot code is required for lot-tracked products and refused for the others. Lots belong to the product: an existing lot is reused, and if the file gives other dates, a warning keeps Pango's. Dates in the file are used only when the lot is created. |
| INV-BR-09 | An expiry date before the manufacture date is an error, as in lot editing (`LOT_DATES_INVALID`). |
| INV-BR-10 (D9) | A row with quantity 0 creates the product, category or warehouse it names when new, but records no stock and creates no lot; its identity stays eligible for a later opening. No zero-quantity movement is created. |
| INV-BR-11 (D10) | The stock unit is required free text, matched ignoring case and accents against the units of measure: `ud`, `und`, `unidad`, `unidades`, `EA` → EA; `kg`, `kilo`, `kilogramo`, `KGM` → KGM; `g`, `gr`, `gramo`, `GRM` → GRM; `l`, `litro`, `LTR` → LTR; `ml`, `mililitro`, `MLT` → MLT; `m`, `metro`, `MTR` → MTR; `caja`, `cj`, `BX` → BX; `paquete`, `paq`, `PK` → PK. Anything else is an error; units are never created. For an existing product it must match the product's unit. |
| INV-BR-12 (D11) | Two identical rows (same identity and same values) count once, with a warning. The same identity with different values is an error on both rows. The same SKU in another warehouse or lot is allowed. ~~The same SKU with a different name, unit or lot tracking across rows is an error.~~ Superseded for names by INV-BR-18 (2026-11-24): only a different unit or lot tracking is an error. |
| INV-BR-18 (T8) | The first row of each SKU defines a new product (name, category, description, physical data); its later rows only add stock. Different product values in later rows give one `PRODUCT_VALUES_DIFFER` warning per product, never per row. A different stock unit or lot tracking across rows of the same SKU is an error (`PRODUCT_INCONSISTENT`). The same applies to a new warehouse: its first row sets its type and address. For an existing product, INV-BR-02 applies. |
| INV-BR-13 (D12) | A unit cost enters the product's weighted average cost across every warehouse (stock in transit included), as inbound movements already do; it never replaces the average. |
| INV-BR-14 (D13) | Stock is recorded with the base movement type "Opening balance", registered by the importing user, at the confirmation time, and linked to the import. The file carries no movement type. |
| INV-BR-15 (D14) | `inventory.import` alone authorizes everything in an import: stock, new products, categories and warehouses, and confirmation. It is a warehouse-scope permission and applies the same to any role that grants it, including custom roles: the Owner imports into any warehouse; anyone else into the warehouses where one of their roles grants it, plus the warehouses created by that same import. A non-Owner who creates a warehouse is assigned to it with the role that grants them `inventory.import`. |
| INV-BR-16 | `inventory.import` is granted by default to Owner and Admin, not Operator. Custom roles get it through the existing role management. |
| INV-BR-17 (D15) | Only the user who started an import sends rows, validates and confirms it. Others see it if they hold `inventory.import` in every warehouse it touches; otherwise it does not exist for them. |

## Architectural decisions

### ADR-INV-001 — Opening only, split across sessions

Status: Implemented
Context: The v0.4 template registers an opening ("no debe repetirse sobre saldos ya cargados"), while the first specification proposed reconciling to a target balance with decreases. Reconciling existing stock is a physical count, which is out of scope.
Decision: Accept a row only when its identity (product + warehouse + location + lot) never had stock or movements. Never subtract. One file per session; a file over the session limit is rejected.
Alternatives: Target-balance reconciliation (raise and lower to the file's quantity); the frontend splitting a large file into several sessions automatically.
Rationale: Re-uploading a file cannot duplicate stock; no decreases, no conflicts with reservations, no revaluation of costs, no rules for stock in transit. Splitting automatically would leave a file half loaded when a later session fails.
Consequences: An opening is corrected with manual adjustment movements. Large inventories need several files.
Approval evidence: Owner, 2026-11-24 ("sí, carga inicial repartible en varias sesiones"; one file per session, "A por ahora").
Implementation and test references: `src/inventory-imports/validate.ts` (`ALREADY_HAS_STOCK`), `lookups.ts`; `validate.spec.ts`, `test/integration/inventory-import-validation.int-spec.ts`, `inventory-import-confirm.int-spec.ts`.

### ADR-INV-002 — The frontend reads the file; the API takes JSON only

Status: Implemented
Context: The movement history import already keeps workbooks out of the API ([CU-17 decision 5](../plans/cu-17-movement-history-import.md)).
Decision: The browser reads the workbook, maps its columns and sends JSON rows in batches; the API never parses or generates spreadsheets.
Alternatives: Uploading the workbook and parsing it in the API.
Rationale: No ZIP/XML attack surface or spreadsheet library on the server; the same contract serves any source.
Consequences: The API cannot prove the rows match the workbook; it validates them as untrusted input.
Approval evidence: Specification section 6; owner, 2026-11-24.
Implementation and test references: `src/inventory-imports/inventory-imports.controller.ts`, `dto.ts`, `batch.ts`; `inventory-imports.security.spec.ts`, `test/integration/inventory-import-contract.int-spec.ts` (JSON-only routes).

### ADR-INV-003 — Static template in the frontend; validation only in the server

Status: Implemented
Context: The specification asked the API to generate a tenant-specific workbook with native validation.
Decision: The template is a static file stored and offered for download by `pango-frontend`; it carries no native data validation that Pango relies on. Every rule is enforced by the API.
Alternatives: A workbook generated by the API on each download, with dropdowns of the organization's warehouses and native validation.
Rationale: Native validation is bypassed by pasting or scripts, so the API validates everything anyway; a static file needs no spreadsheet library or endpoint in the API.
Consequences: No `GET /inventory-imports/template`. New or misspelled warehouses and categories show up in the preview before confirmation. Format reference: the v0.4 template, kept outside this repository.
Approval evidence: Owner, 2026-11-24 ("solo el servidor"; "es un excel estático que guardaré en el frontend").
Implementation and test references: No template route (`inventory-import-contract.int-spec.ts` lists the ten routes); every rule in `parse.ts` and `validate.ts`; the static template in the "Standard template" section.

### ADR-INV-004 — `inventory.import` authorizes the whole import, per warehouse

Status: Implemented
Context: Admins are always assigned to specific warehouses (`src/roles/role-policy.ts`); only the Owner holds an assignment on every warehouse.
Decision: See INV-BR-15 and INV-BR-16.
Alternatives: Also requiring `product.manage`, `category.manage` and `warehouse.manage`; an organization-scope permission; letting only the Owner create warehouses.
Rationale: The owner wants Owner and Admin to do everything an import needs with one permission, without widening an Admin to warehouses they are not assigned to.
Consequences: The import writes a role assignment when a non-Owner creates a warehouse. When several roles grant the permission, all of them are assigned (T7).
Approval evidence: Owner, 2026-11-24 ("con tener el permiso del inventario ya puede acceder… el admin a la que tiene asignada"; "es mejor que el admin también pueda"; "A, asígnalo automáticamente").
Implementation and test references: `prisma/tenant/migrations/20261124100000_inventory_import_permission`, `src/inventory-imports/inventory-import-access.ts`, `validate.ts`, `confirm.ts`; `test/integration/inventory-import-access.int-spec.ts`, `inventory-import-validation.int-spec.ts`, `inventory-import-confirm.int-spec.ts`. Several roles: every role of the creator that grants the permission is assigned (T7).

### ADR-INV-005 — Conflicts never change existing data

Status: Implemented
Decision: INV-BR-02, INV-BR-03, INV-BR-08 and INV-BR-12: identity-defining differences (unit, lot tracking, inconsistent rows) are errors; descriptive differences are warnings that keep Pango's values.
Rationale: An opening must not silently rewrite the catalog; warnings never block, errors block the whole session (INV-FR-03).
Approval evidence: Owner, 2026-11-24 (D2, D3, D8 approved; D11 revised to "identical rows count once").
Implementation and test references: `src/inventory-imports/validate.ts`; `validate.spec.ts`, `test/integration/inventory-import-confirm.int-spec.ts`.

### ADR-INV-006 — No artificial demand

Status: Implemented
Context: Demand is defined once in `src/demand/demand-rule.ts` (`demandCondition`): confirmed **outbound** movements whose type has `counts_as_demand`. It feeds the demand history and the forecast input. Of the six base movement types, only "Consumption issue" and "Sales issue" count as demand; no endpoint creates or edits movement types.
Decision: The import records only inbound "Opening balance" movements (INV-BR-14).
Consequences: The opening gives the forecast's stock series its starting point (`src/forecasting/forecast-input.ts` rebuilds stock from movements), and, as the first Pango movement of a product-warehouse, it is the cutover after which imported history stops counting ([`movement-imports.md`](movement-imports.md)).
Approval evidence: Owner, 2026-11-24 (D13 approved; scope limited to the import module).
Implementation and test references: `src/inventory-imports/confirm.ts` ("Opening balance" only); `test/integration/inventory-import-confirm.int-spec.ts` (shared demand rule finds nothing), `inventory-import-http.int-spec.ts` (`GET /products/:id/demand` total 0).

### ADR-INV-007 — Cell values travel as text

Status: Implemented
Context: The specification proposed typed JSON (numbers, booleans). The owner decided that only the server validates (ADR-INV-003).
Decision: Each value is sent as the cell's text (string) or null, as the movement history import does; the server parses numbers, dates and lists and reports bad values as row issues.
Alternatives: Typed JSON converted by the frontend.
Rationale: The frontend validates nothing; a bad cell shows up in the preview with its row and column instead of rejecting the batch; decimals keep their exact digits (no floating point); one format for both importers.
Approval evidence: Owner, 2026-11-24 (C1–C7 approved: "apruebo todas").
Implementation and test references: `src/inventory-imports/batch.ts`, `parse.ts`; `batch.spec.ts`, `parse.spec.ts`.

### ADR-INV-008 — Batches under the existing 1 MB body limit

Status: Implemented
Context: `src/main.ts` limits JSON bodies to 1 MB for the whole API. Measured estimate: 181 bytes for a minimal row, 574 for a full one (about 1,800 full rows per MB).
Decision: Keep the limit; the frontend splits rows into batches by their serialized UTF-8 size. 5,000 rows per batch is a ceiling, not a target.
Alternatives: A route-specific parser up to 10 MiB.
Rationale: No change to global settings; less memory per request.
Approval evidence: Owner, 2026-11-24 (C2).
Implementation and test references: `src/main.ts` unchanged; batches split by the frontend; `test/integration/inventory-import-rows.int-spec.ts`; HTTP check of the 413.

### ADR-INV-009 — Synchronous processing, one active import per organization, lazy expiry

Status: Implemented
Decision: Validation and confirmation answer in the same request; no background jobs. An organization has at most one open import; an open import with no activity for 24 hours expires, which is applied when it is next read or when someone starts another import (no scheduler). Errors found in validation are fixed in the workbook and sent as a new import; an open import can be validated again without resending rows.
Alternatives: Background jobs with progress; one import per user; correcting rows inside an import.
Rationale: Nothing can stay stuck "processing"; no new infrastructure; one version of the data per import. Revisited if INV-015 measurements require it.
Approval evidence: Owner, 2026-11-24 (C5, C6, C7).
Implementation and test references: `src/inventory-imports/inventory-imports.service.ts`; `test/integration/inventory-import-sessions.int-spec.ts`, `inventory-import-recovery.int-spec.ts`.

### ADR-INV-010 — Staging tables, one open import enforced by the database, staged data deleted on close

Status: Implemented
Decision: Four tenant tables (`inventory_imports`, `inventory_import_batches`, `inventory_import_rows`, `inventory_import_issues`) and a nullable `movements.inventory_import_id`. A partial unique index allows one open import per organization. Closing an import (completed, cancelled, expired) deletes its batches, rows and issues in the same transaction; the import row keeps mapping, summary and result.
Alternatives: Reusing the movement history import tables; keeping staged rows for audit.
Rationale: The database, not only the code, prevents two open imports; staged customer data is not kept once useless; the import row is enough for audit and for answering a repeated confirmation.
Approval evidence: Owner, 2026-11-24 (T1, T6: "apruebo todas").
Implementation and test references: `prisma/tenant/migrations/20261124200000_inventory_imports`; `test/integration/inventory-import-staging.int-spec.ts`.

### ADR-INV-011 — Confirmation re-validates under locks inside one transaction

Status: Implemented
Decision: Confirmation takes a per-organization lock, locks the import, locks the rows it depends on in a fixed order, runs the same validation as the preview and compares its outcome with the validated one; any difference is `IMPORT_STALE`. Then it creates entities, lots and stock through `MovementsService.record()` in the same transaction.
Alternatives: A list of specific staleness checks; validating without locks.
Rationale: One validation code path cannot miss a case; the locks are the ones movements already use, so imports and ordinary operations wait for each other instead of racing.
Approval evidence: Owner, 2026-11-24 (T2–T5).
Implementation and test references: `src/inventory-imports/confirm.ts`, `inventory-imports.service.ts` (`confirm`); `test/integration/inventory-import-confirm.int-spec.ts`.

### ADR-INV-012 — Real PostgreSQL for integration tests

Status: Approved (implemented in INV-003)
Decision: A throwaway local PostgreSQL 17 (Supabase runs 17.11) from `docker-compose.test.yml`, integration tests in `*.int-spec.ts` run by `pnpm test:int`, a guard that refuses any non-local database, and tenants provisioned with the real `provisionOrganization`. No new dependency.
Rationale: Transactions, locks, constraints and tenant isolation cannot be proven with mocks.
Approval evidence: Owner, 2026-11-24 ("aceptar todo incluye aceptar también T10 y T11").
Implementation and test references: `docker-compose.test.yml`, `vitest.config.integration.ts`, `test/integration/database.ts`, `test/integration/global-setup.ts`, `test/integration/provisioning.int-spec.ts`.

### ADR-INV-013 — 5,000 rows per import, from measurements

Status: Implemented
Context: The T11 benchmark (see Technical design) measured the existing stock engine at about 3 database queries per opening line (6 with lots); 50,000 lines took 134 s on a local database with no network latency, while every affected product stays locked.
Decision: The default limit is 5,000 rows per import (configurable). A set-based stock path for large openings is a future improvement, not part of this module.
Alternatives: 10,000 rows; rewriting the movement engine's apply step in bulk now.
Rationale: Keeps confirmations short and the engine untouched; larger inventories are split into several files (INV-FR-02).
Approval evidence: Owner, 2026-11-24 ("A por ahora, deja C como mejora futura").
Implementation and test references: `src/inventory-imports/inventory-import-config.ts`; `test/performance/inventory-import.perf-spec.ts`.

### ADR-INV-014 — Bounded waits, and retryable failures answer 503

Status: Approved (implemented in INV-012)
Context: Prisma's transaction timeout does not cancel a statement that is waiting for a lock: a measured confirmation kept its connection waiting 20 s after its 0.7 s limit. Timeouts, deadlocks and lost connections surfaced as generic 500 errors.
Decision: Every import transaction sets `SET LOCAL lock_timeout` and `statement_timeout` to its own time limit, so PostgreSQL cancels the wait and rolls back. A failure that only needs a retry (Prisma `P2028`, `P2034`; SQLSTATE `57014`, `55P03`, `40P01`, `40001`, `57P01`–`57P03`, `08000`, `08003`, `08006`) answers `503 IMPORT_BUSY`: nothing was saved, try again.
Rationale: Every import operation is safe to repeat (creation and batches by their identity, validation by revision, confirmation by its stored result), so "try again" is always correct; the connection is freed at once instead of waiting for the lock.
Approval evidence: Owner, 2026-11-25 ("acepto INV-011 y autorizo INV-012"; the proposal named the new 503).
Implementation and test references: `src/inventory-imports/inventory-import-errors.ts` (`isRetryable`), `inventory-imports.service.ts` (`boundWaits`, `retryable`); `inventory-import-errors.spec.ts`, `test/integration/inventory-import-recovery.int-spec.ts`.

## API contract (INV-002)

Implemented and verified against the running API on 2026-11-25 (INV-016): the examples below are real responses captured by `test/integration/inventory-import-contract.int-spec.ts`, which also checks every response of every route against its OpenAPI schema (no undocumented field, no missing required field) and that OpenAPI lists exactly the module's ten routes. Run it with `CONTRACT_EXAMPLES_OUT=<file>` to capture them again.

### Conventions

- No global prefix: paths start at `/inventory-imports`.
- Authentication and tenant as in every Pango route ([`auth.md`](auth.md)): session cookies sent with credentials (or Bearer for non-browser clients), and the organization from the `X-Tenant` header or the subdomain. Unsafe requests from an origin outside `APP_BASE_DOMAIN` are refused by `CsrfGuard`.
- Every route requires `inventory.import` in at least one warehouse; rows are checked per warehouse (INV-BR-15).
- Errors use Pango's envelope: `{ "statusCode": 409, "code": "IMPORT_STALE", "message": "…" }`, sometimes with extra fields. Bodies rejected by `ValidationPipe` answer 400 with `message` as an array. Bodies over 1 MB are refused with 413 before reaching the module or the session check; that answer is `{ "statusCode": 413, "message": "request entity too large" }`, without a `code` (verified 2026-11-24 with a 1.4 MB batch).
- Lists are paginated: `page` ≥ 1 (default 1), `pageSize` 1–100 (default 25), answering `{ items, total, page, pageSize }`.
- Dates in responses are ISO 8601 instants.

### Lifecycle

```text
RECEIVING ──validate──▶ READY ──confirm──▶ COMPLETED
    │                 ╲  ▲ │
    │                  ▼ │ │ validate again
    │                 INVALID
    └──── cancel (RECEIVING, READY, INVALID) ──▶ CANCELLED
          24 h without activity (same states)  ──▶ EXPIRED
```

| Status | Rows | Validate | Confirm | Cancel |
|---|---|---|---|---|
| `RECEIVING` | accepted | when every declared row arrived | 409 `IMPORT_NOT_READY` | yes |
| `READY` (no errors) | 409 `IMPORT_NOT_RECEIVING` | yes (new revision) | yes, with its revision | yes |
| `INVALID` (errors) | 409 `IMPORT_NOT_RECEIVING` | yes (new revision) | 409 `IMPORT_NOT_READY` | yes |
| `COMPLETED` | 409 `IMPORT_CLOSED` | 409 `IMPORT_CLOSED` | answers the stored result | 409 `IMPORT_CLOSED` |
| `CANCELLED`, `EXPIRED` | 409 `IMPORT_CLOSED` | 409 `IMPORT_CLOSED` | 409 `IMPORT_CLOSED` | answers the import as is |

Only the import's creator sends rows, validates, confirms and cancels (403 `IMPORT_NOT_YOURS`); an import the user may not see answers 404 `IMPORT_NOT_FOUND` (INV-BR-17).

### Endpoints

| Method | Path | Purpose | Success |
|---|---|---|---|
| GET | `/inventory-imports/fields` | Field dictionary and effective limits | 200 |
| POST | `/inventory-imports` | Start an import | 201 (200 on a replay) |
| POST | `/inventory-imports/:id/rows` | Send a batch of rows | 200 |
| POST | `/inventory-imports/:id/validate` | Validate every row; preview | 200 |
| GET | `/inventory-imports/:id` | Import, summary and result | 200 |
| GET | `/inventory-imports/:id/rows?status=&page=&pageSize=` | Preview rows | 200 |
| GET | `/inventory-imports/:id/issues?severity=&code=&page=&pageSize=` | Errors and warnings by row | 200 |
| POST | `/inventory-imports/:id/confirm` | Confirm the validated revision | 200 |
| POST | `/inventory-imports/:id/cancel` | Cancel an open import | 200 |
| GET | `/inventory-imports?status=&page=&pageSize=` | Imports the user may see, newest first | 200 |

### Field dictionary

Rows use these keys. Every value is a string or null; blank, null and an omitted key all mean "no value", never zero or false. Labels are the template's Spanish headers, without the `*` / `**` markers.

| Key | Template header | Required | Rule (checked by the server) |
|---|---|---|---|
| `sku` | Código producto | yes | Up to 40 characters; matched ignoring case; leading zeros are significant. |
| `name` | Producto | yes | Up to 150. |
| `category` | Categoría | yes | Up to 80 (INV-BR-05). |
| `stockUnit` | Unidad de medida | yes | A unit or alias of INV-BR-11. |
| `warehouse` | Bodega | yes | Warehouse name, up to 80 (INV-BR-06). |
| `tracksLots` | Seguimiento | yes | `Cantidad` or `Lote` (ignoring case and accents). |
| `stockQuantity` | Saldo inicial | yes | Decimal ≥ 0 and ≤ 9,999,999,999, up to 4 decimals. |
| `unitCost` | Costo unitario | no | Decimal ≥ 0 and ≤ 9,999,999,999, up to 4 decimals (INV-BR-01). |
| `lotCode` | Código de lote | if `Lote` | Up to 40; refused for `Cantidad` (INV-BR-08). |
| `locationCode` | Ubicación | no | Up to 40 (INV-BR-07). |
| `manufactureDate` | Fecha fabricación | no | Date (INV-BR-09). |
| `expiryDate` | Fecha vencimiento | no | Date, not before the manufacture date. |
| `warehouseType` | Tipo de almacén | no | `Bodega` or `Tienda`; default `Bodega` for a new warehouse. |
| `warehouseCode` | Código de bodega | for a new warehouse | Up to 20. |
| `warehouseAddress` | Dirección de bodega | no | Up to 200; used only for a new warehouse. |
| `description` | Descripción | no | Up to 2,000; used only for a new product. |
| `lengthCm`, `widthCm`, `heightCm` | Largo (cm), Ancho (cm), Alto (cm) | no | Decimal ≥ 0 and ≤ 99,999,999, up to 2 decimals; new products only. |
| `weightKg` | Peso (kg) | no | Decimal ≥ 0 and ≤ 99,999,999, up to 4 decimals; new products only. |
| `volumeL` | Volumen (L) | no | Decimal ≥ 0 and ≤ 9,999,999,999, up to 4 decimals; new products only. |

Formats: decimals use `.` as separator and no thousands separator (`1250.5`); dates are `YYYY-MM-DD` (`DD/MM/YYYY` is also accepted); values are trimmed. Anything else is an `INVALID_VALUE` row issue, not a rejected batch.

### `GET /inventory-imports/fields`

```json
{
  "schemaVersion": 1,
  "limits": {
    "maxRowsPerBatch": 5000,
    "maxRowsPerImport": 5000,
    "maxRequestBytes": 1048576,
    "maxValueChars": 2000,
    "maxRowChars": 4096,
    "expiryHours": 24
  },
  "fields": [
    { "key": "sku", "label": "Código producto", "required": true, "type": "text", "maxLength": 40 },
    { "key": "tracksLots", "label": "Seguimiento", "required": true, "type": "list", "values": ["Cantidad", "Lote"] },
    { "key": "stockQuantity", "label": "Saldo inicial", "required": true, "type": "decimal", "min": 0, "max": 9999999999, "maxDecimals": 4 },
    { "key": "lotCode", "label": "Código de lote", "required": false, "requiredWhen": { "tracksLots": "Lote" }, "type": "text", "maxLength": 40 },
    { "key": "stockUnit", "label": "Unidad de medida", "required": true, "type": "unit", "maxLength": 40 }
  ],
  "units": [
    { "code": "EA", "name": "Each", "aliases": ["ud", "und", "unidad", "unidades"] }
  ]
}
```

The real response lists all 21 fields and every unit of measure of the organization with its aliases (INV-BR-11). Limits are the effective configured values; the frontend reads them instead of hard-coding them. Implemented in INV-007; the field definitions live in `src/inventory-imports/fields.ts`, the same ones the mapping check and, later, row validation use.

### `POST /inventory-imports`

```json
{
  "clientRequestId": "6f1c2d4e-8a7b-4c1d-9e2f-3a4b5c6d7e8f",
  "schemaVersion": 1,
  "fileName": "inventario-noviembre.xlsx",
  "sheetName": "Inventario",
  "totalRows": 4800,
  "mapping": {
    "sku": { "column": 1, "header": "Código producto *" },
    "name": { "column": 2, "header": "Producto *" },
    "category": { "column": 3, "header": "Categoría *" },
    "stockUnit": { "column": 4, "header": "Unidad de medida *" },
    "warehouse": { "column": 5, "header": "Bodega *" },
    "tracksLots": { "column": 6, "header": "Seguimiento *" },
    "stockQuantity": { "column": 7, "header": "Saldo inicial *" },
    "unitCost": { "column": 8, "header": "Costo unitario" },
    "lotCode": null
  }
}
```

- `clientRequestId`: a UUID the frontend generates once per file. Sending the same request again answers 200 with the same import; the same id with a different body answers 409 `IDEMPOTENCY_CONFLICT`.
- `schemaVersion`: 1 (otherwise 400 `UNSUPPORTED_SCHEMA_VERSION`). `fileName` up to 255 and `sheetName` up to 100 characters, for display only.
- `totalRows`: non-empty data rows of the sheet (no header, no blank rows), 1 to `maxRowsPerImport` (above: 413 `IMPORT_LIMIT_EXCEEDED`).
- `mapping`: which column of the file (1 = A) and header feeds each field; `null` or absent = not in the file. It is stored for traceability and to show the source column of each issue; the server never maps columns itself. The seven required fields must be mapped and a column may feed only one field (400 `MAPPING_INVALID`).
- 409 `IMPORT_ACTIVE_EXISTS` when the organization already has an open import; when the requester started it, the response adds `importId` so the frontend can resume or cancel it.
- Checks run in this order: schema version, mapping, row limit, then the database (replay, open import). Simultaneous identical requests create one import (the others answer it with 200); simultaneous different requests leave one open import and answer `IMPORT_ACTIVE_EXISTS` to the others.

Response (201):

```json
{
  "id": 1,
  "status": "RECEIVING",
  "schemaVersion": 1,
  "fileName": "inventario-noviembre.xlsx",
  "sheetName": "Inventario",
  "totalRows": 3,
  "receivedRows": 0,
  "revision": 0,
  "summary": null,
  "result": null,
  "createdBy": {
    "id": 1,
    "name": "Test Owner"
  },
  "createdAt": "2026-11-25T06:26:01.946Z",
  "updatedAt": "2026-11-25T06:26:01.946Z",
  "expiresAt": "2026-11-26T06:26:01.946Z",
  "confirmedAt": null
}
```

### `POST /inventory-imports/:id/rows`

```json
{
  "batchNumber": 1,
  "rows": [
    {
      "rowNumber": 2,
      "values": {
        "sku": "TOR-001", "name": "Tornillo", "category": "Tornillería",
        "stockUnit": "Unidad", "warehouse": "Principal", "tracksLots": "Cantidad",
        "stockQuantity": "500", "unitCost": "350"
      }
    }
  ]
}
```

- `batchNumber` ≥ 1, chosen by the frontend; batches may arrive in any order.
- `rows`: 1 to `maxRowsPerBatch`, and the whole body within `maxRequestBytes`. `rowNumber` is the row of the file (the header is row 1), so it is ≥ 2 and unique in the import. `values` holds only dictionary keys, each a string up to `maxValueChars` or null, and all the values of a row add up to at most `maxRowChars` (4,096) characters (INV-013).
- A structurally wrong batch (unknown key, repeated `rowNumber`, a value that is not a string or null) is rejected whole: 400 `ROWS_INVALID` with up to 20 `problems`. Wrong cell contents are not structural: they become issues at validation.
- Retries: the same `batchNumber` with the same content answers the original result with `"replayed": true` and changes nothing. The same `batchNumber` with other content, or a `rowNumber` already received in another batch, answers 409 `BATCH_CONFLICT`. More rows than `totalRows` answers 409 `ROWS_EXCEED_TOTAL`.
- New batches only in `RECEIVING` (otherwise 409 `IMPORT_NOT_RECEIVING`, or `IMPORT_CLOSED` once closed). A retried batch is answered while the import is open (`RECEIVING`, `READY`, `INVALID`), with the import's current `status`; once closed its staged batches are gone and it answers `IMPORT_CLOSED`.
- A batch with more rows than `limits.maxRowsPerBatch` answers 413 `IMPORT_LIMIT_EXCEEDED`.
- Batches of one import are stored one at a time (the import row is locked), so simultaneous batches never lose rows or counts. Implemented in INV-008 (`src/inventory-imports/batch.ts`, `appendRows`).

Response (200):

```json
{
  "importId": 1,
  "batchNumber": 1,
  "acceptedRows": 2,
  "receivedRows": 2,
  "totalRows": 3,
  "status": "RECEIVING",
  "replayed": false
}
```

### `POST /inventory-imports/:id/validate`

No body. Allowed in `RECEIVING` once `receivedRows = totalRows` (otherwise 409 `IMPORT_INCOMPLETE` with both counts), and in `READY` / `INVALID` to refresh the preview against the current data. It never writes products, categories, warehouses, lots or stock. It answers the import with a new `revision`, status `READY` (no errors) or `INVALID`, its `summary` and the first page of issues:

```json
{
  "import": {
    "id": 1,
    "status": "READY",
    "schemaVersion": 1,
    "fileName": "inventario-noviembre.xlsx",
    "sheetName": "Inventario",
    "totalRows": 3,
    "receivedRows": 3,
    "revision": 1,
    "summary": {
      "reuse": {
        "lots": 0,
        "products": 0,
        "categories": 0,
        "warehouses": 1
      },
      "create": {
        "lots": 0,
        "products": 2,
        "categories": 1,
        "warehouses": 0
      },
      "errors": 0,
      "warnings": 2,
      "stockRows": 2,
      "totalRows": 3,
      "validRows": 2,
      "invalidRows": 0,
      "issueCounts": {
        "COST_MISSING": 1,
        "DUPLICATE_ROW": 1
      },
      "duplicateRows": 1
    },
    "result": null,
    "createdBy": {
      "id": 1,
      "name": "Test Owner"
    },
    "createdAt": "2026-11-25T06:26:01.946Z",
    "updatedAt": "2026-11-25T06:26:02.117Z",
    "expiresAt": "2026-11-26T06:26:02.116Z",
    "confirmedAt": null
  },
  "issues": {
    "revision": 1,
    "items": [
      {
        "rowNumber": 3,
        "field": "unitCost",
        "sourceColumn": {
          "column": 8,
          "header": "Costo unitario"
        },
        "severity": "WARNING",
        "code": "COST_MISSING",
        "message": "No unit cost: the stock takes the product's current average cost",
        "value": null
      },
      {
        "rowNumber": 4,
        "field": null,
        "sourceColumn": null,
        "severity": "WARNING",
        "code": "DUPLICATE_ROW",
        "message": "Identical to row 2: counted once",
        "value": null
      }
    ],
    "total": 2,
    "page": 1,
    "pageSize": 25
  }
}
```

`stockRows` are the rows that will add stock (quantity above 0, not repeated). Every issue is counted; the first 10,000 are stored and listed.

Implemented in INV-009 (`src/inventory-imports/parse.ts`, `validate.ts`, `lookups.ts`):

- Matching follows Pango's own rules: SKUs, warehouse codes and names, category names and location codes ignore case but not accents (`Tornillería` and `Tornilleria` are two categories); `Seguimiento`, `Tipo de almacén` and units also ignore accents; lot codes are exact, as movements match them.
- A value that fails its format gets only `INVALID_VALUE`, not also `REQUIRED_FIELD`.
- Manufacture and expiry dates only matter on lot rows (a new lot takes them); on quantity rows they are ignored.
- "Already had stock or movements" (`ALREADY_HAS_STOCK`) means a stock balance row, or a movement line from or to that location, of that product and lot, of any status (stock in transit to the location counts).
- The data is read with eight set-based queries, whatever the number of rows. Measured locally (Docker PostgreSQL 17, 2026-11-24): 5,000 new rows were received in three batches in 0.9 s and validated in 1.2 s.

### Row issues

| Code | Severity | Meaning |
|---|---|---|
| `REQUIRED_FIELD` | ERROR | A required value is missing. |
| `INVALID_VALUE` | ERROR | Wrong format, too long, out of range or too many decimals. |
| `STOCK_UNIT_INVALID` | ERROR | Not a unit or alias of Pango. |
| `UNIT_MISMATCH` | ERROR | The existing product uses another unit. |
| `TRACKING_MISMATCH` | ERROR | The existing product tracks lots differently. |
| `PRODUCT_INCONSISTENT` | ERROR | The same SKU has a different name, unit or tracking in other rows. |
| `PRODUCT_INACTIVE`, `CATEGORY_INACTIVE`, `WAREHOUSE_INACTIVE` | ERROR | INV-BR-03. |
| `CATEGORY_AMBIGUOUS` | ERROR | Several categories have that name. |
| `WAREHOUSE_FORBIDDEN` | ERROR | Not a warehouse the user may import into; also for warehouses that exist but are not visible to the user. |
| `WAREHOUSE_CONFLICT` | ERROR | Code and name point to different warehouses, or a new warehouse's code or name is taken. |
| `WAREHOUSE_CODE_REQUIRED` | ERROR | A new warehouse without code. |
| `NON_STOCK_WAREHOUSE` | ERROR | Quantity above 0 in a warehouse that does not hold stock. |
| `LOCATION_INVALID` | ERROR | Not an active location of the warehouse. |
| `LOT_REQUIRED`, `LOT_NOT_ALLOWED` | ERROR | INV-BR-08. |
| `LOT_DATES_INVALID` | ERROR | Expiry before manufacture. |
| `ALREADY_HAS_STOCK` | ERROR | The identity already had stock or movements (INV-FR-05). |
| `ROW_CONFLICT` | ERROR | Same identity as another row with different values (both rows). |
| `COST_MISSING` | WARNING | No unit cost. |
| `PRODUCT_DIFFERS` | WARNING | The existing product's name, category, description or physical data differ; Pango's are kept (once per product). |
| `PRODUCT_VALUES_DIFFER` | WARNING | A later row of a new SKU gives other optional values; the first row's are used (once per product, INV-BR-18). |
| `LOT_DATES_DIFFER` | WARNING | The existing lot's dates differ; Pango's are kept. |
| `DUPLICATE_ROW` | WARNING | Identical to an earlier row; counted once. |

Issue fields: `rowNumber` (null for an issue of the whole import), `field` (null when not tied to one), `sourceColumn` (from the mapping, or null), `severity`, `code`, `message` (English, safe to show), `value` (the offending value, truncated to 200 characters).

### Preview rows: `GET /inventory-imports/:id/rows`

`status`: `VALID`, `INVALID` or `DUPLICATE`. Items, sorted by `rowNumber`:

```json
{
  "rowNumber": 2,
  "status": "VALID",
  "sku": "TOR-001",
  "product": {
    "id": null,
    "name": "Tornillo hexagonal",
    "isNew": true
  },
  "category": {
    "id": null,
    "name": "Tornillería",
    "isNew": true
  },
  "warehouse": {
    "id": 1,
    "code": "NORTE",
    "name": "NORTE",
    "isNew": false
  },
  "locationCode": "DEFAULT",
  "lot": null,
  "stockUnit": "EA",
  "quantity": "500",
  "unitCost": "350",
  "issues": 0
}
```

Ids are null for entities that would be created; quantities and costs are strings with their exact digits.

Implemented in INV-010:

- The page is `{ revision, items, total, page, pageSize }`: `revision` is the validation the preview comes from (0 before any), so the frontend can tell an outdated preview and confirm the revision it showed.
- `status` also accepts `PENDING`: before any validation every row is `PENDING`, with only its `sku` and every other field null.
- Once the import closes (completed, cancelled, expired) its staged rows and issues are deleted, so both pages are empty; the import keeps its summary and result.
- `GET /inventory-imports/:id/issues` answers the same shape as the issues of `validate`, with `revision` too; `severity` is `ERROR` or `WARNING`, `code` an issue code.
- Both are readable by whoever may see the import (INV-BR-17), not only its creator.

### `POST /inventory-imports/:id/confirm`

```json
{ "revision": 1 }
```

Only in `READY`, with the revision of the last validation. Everything is written in one transaction (INV-FR-03). Answers the import with its `result`:

```json
{
  "id": 1,
  "status": "COMPLETED",
  "schemaVersion": 1,
  "fileName": "inventario-noviembre.xlsx",
  "sheetName": "Inventario",
  "totalRows": 3,
  "receivedRows": 3,
  "revision": 1,
  "summary": {
    "reuse": {
      "lots": 0,
      "products": 0,
      "categories": 0,
      "warehouses": 1
    },
    "create": {
      "lots": 0,
      "products": 2,
      "categories": 1,
      "warehouses": 0
    },
    "errors": 0,
    "warnings": 2,
    "stockRows": 2,
    "totalRows": 3,
    "validRows": 2,
    "invalidRows": 0,
    "issueCounts": {
      "COST_MISSING": 1,
      "DUPLICATE_ROW": 1
    },
    "duplicateRows": 1
  },
  "result": {
    "created": {
      "lots": 0,
      "products": 2,
      "categories": 1,
      "warehouses": 0
    },
    "movements": 2,
    "stockRows": 2,
    "assignedWarehouses": 0
  },
  "createdBy": {
    "id": 1,
    "name": "Test Owner"
  },
  "createdAt": "2026-11-25T06:26:01.946Z",
  "updatedAt": "2026-11-25T06:26:02.290Z",
  "expiresAt": null,
  "confirmedAt": "2026-11-25T06:26:02.288Z"
}
```

- A repeated confirmation answers the same result and changes nothing.
- 409 `IMPORT_STALE` when the revision is not the last one, or when something the preview depends on changed since validation (stock or movements of an identity, products, categories, warehouses, lots or the user's permissions; the exact checks are defined in INV-003). Validate again and confirm the new revision.
- 409 `IMPORT_NOT_READY` in `RECEIVING` or `INVALID`; 409 `IMPORT_CLOSED` when cancelled or expired.
- If the transaction fails, nothing is written and the import stays `READY`; the frontend may retry the confirmation.

Implemented in INV-011 (`src/inventory-imports/confirm.ts`, `confirm()` in the service):

- The response is the import (as `GET /inventory-imports/:id`) with `status: COMPLETED`, `confirmedAt` and `result` `{ stockRows, movements, created: { categories, products, warehouses, lots }, assignedWarehouses }`.
- Stock is recorded with the movement engine (`MovementsService.record()`), so balances, product-warehouses, weighted average costs and alerts follow the same rules as any movement. Lines with a unit cost are recorded first, in every warehouse, then the lines without one: a line without cost takes the average the file's own costs produced, not 0 (INV-BR-01, INV-BR-13). Each warehouse gets at most two movements per 1,000 lines (one for lines with cost, one without), all "Opening balance", `documentRef = INV-IMP-<id>`, linked to the import and registered by its creator.
- A unique violation while creating (someone created the same SKU, warehouse or category since the validation) answers `IMPORT_STALE`.
- The logs record the import id, the outcome (error code or counts) and the duration; never row contents.
- Measured locally (Docker PostgreSQL 17, 2026-11-25): 5,000 new rows (5,000 products, 50 categories, 1,250 lots) confirmed in 17.8 s, in 6 movements.

### Other routes

- `POST /inventory-imports/:id/cancel`: no body; answers the import as `CANCELLED`. Repeating it answers the same.
- `GET /inventory-imports/:id`: the import as in the examples above (summary after validation, result after confirmation).
- `GET /inventory-imports`: imports the user may see (INV-BR-17), newest first; `status` filters.
- Visibility (INV-BR-17) uses the warehouses an import touches, which validation records; until then an import is visible to its creator and the Owner only. That list is internal: `summary` never shows it.
- Every read and write first expires the open imports idle for longer than the expiry hours (and deletes their staged data), so `status` and `expiresAt` are always current.

### Error codes by HTTP status

Real error bodies (from the contract test):

```json
{
  "incomplete": {
    "statusCode": 409,
    "code": "IMPORT_INCOMPLETE",
    "message": "Send every row before validating: 2 of 3 received",
    "receivedRows": 2,
    "totalRows": 3
  },
  "mappingInvalid": {
    "statusCode": 400,
    "code": "MAPPING_INVALID",
    "message": "The column mapping is not valid",
    "problems": [
      "mapping.sku is required",
      "mapping.name is required",
      "mapping.category is required",
      "mapping.stockUnit is required",
      "mapping.warehouse is required",
      "mapping.tracksLots is required",
      "mapping.stockQuantity is required"
    ]
  },
  "limitExceeded": {
    "statusCode": 413,
    "code": "IMPORT_LIMIT_EXCEEDED",
    "message": "An inventory import holds at most 5000 rows; split the file"
  },
  "notFound": {
    "statusCode": 404,
    "code": "IMPORT_NOT_FOUND",
    "message": "Inventory import not found"
  },
  "closed": {
    "statusCode": 409,
    "code": "IMPORT_CLOSED",
    "message": "The import is closed (completed, cancelled or expired)"
  }
}
```

Only these extra fields exist besides `statusCode`, `code` and `message`: `problems` (`MAPPING_INVALID`, `ROWS_INVALID`), `importId` (`IMPORT_ACTIVE_EXISTS`, for the creator), `receivedRows` and `totalRows` (`IMPORT_INCOMPLETE`, `ROWS_EXCEED_TOTAL`). `ValidationPipe` errors also carry `error`. The 413 for bodies over 1 MB has no `code`.

| Status | Codes |
|---|---|
| 400 | Validation errors (`message` array), `UNSUPPORTED_SCHEMA_VERSION`, `MAPPING_INVALID`, `ROWS_INVALID` |
| 401 / 403 | The session errors of [`auth.md`](auth.md); `FORBIDDEN` without `inventory.import`; `IMPORT_NOT_YOURS` |
| 404 | `IMPORT_NOT_FOUND` |
| 409 | `IDEMPOTENCY_CONFLICT`, `IMPORT_ACTIVE_EXISTS`, `BATCH_CONFLICT`, `ROWS_EXCEED_TOTAL`, `IMPORT_NOT_RECEIVING`, `IMPORT_INCOMPLETE`, `IMPORT_NOT_READY`, `IMPORT_STALE`, `IMPORT_CLOSED` |
| 413 | Body over 1 MB; `IMPORT_LIMIT_EXCEEDED` |
| 503 | `IMPORT_BUSY` (INV-012): time limit, conflict or lost connection; nothing was saved; repeat the same request |

## Standard template (INV-006)

The template is a static workbook stored and offered for download by `pango-frontend` (ADR-INV-003); the API never sees it. Its format reference is the v0.4 proposal (`Plantilla_Inventario_PANGO.xlsx`, kept outside this repository). This section is what the frontend must keep in sync with the API.

### Sheets

| Sheet | Content |
|---|---|
| `Inventario` | The only data-entry sheet: headers in row 1, one row per product, warehouse, location and lot from row 2. No example data. |
| `Instrucciones` | How to fill it, the accepted values and a fictitious example (never imported). |

### Columns of `Inventario`

In this order (A–U). Headers carry `*` (required) or `**` (required for lot-tracked products); the frontend matches them ignoring case, accents and these markers. Codes should be formatted as text in the workbook so leading zeros survive.

| Col. | Header | API key |
|---|---|---|
| A | Código producto * | `sku` |
| B | Producto * | `name` |
| C | Categoría * | `category` |
| D | Unidad de medida * | `stockUnit` |
| E | Bodega * | `warehouse` |
| F | Seguimiento * | `tracksLots` |
| G | Saldo inicial * | `stockQuantity` |
| H | Costo unitario | `unitCost` |
| I | Código de lote ** | `lotCode` |
| J | Ubicación | `locationCode` |
| K | Fecha fabricación | `manufactureDate` |
| L | Fecha vencimiento | `expiryDate` |
| M | Tipo de almacén | `warehouseType` |
| N | Código de bodega | `warehouseCode` |
| O | Dirección de bodega | `warehouseAddress` |
| P | Descripción | `description` |
| Q | Largo (cm) | `lengthCm` |
| R | Ancho (cm) | `widthCm` |
| S | Alto (cm) | `heightCm` |
| T | Peso (kg) | `weightKg` |
| U | Volumen (L) | `volumeL` |

Accepted values and limits are the field dictionary of the API contract; `GET /inventory-imports/fields` returns them at run time.

### Changes from v0.4 to the published template

v0.4 predates the approved rules. Before publishing it, the frontend's copy needs:

1. Title: drop "Propuesta para revisión"; name the version (`Plantilla v1`).
2. Remove the block "Notas para la revisión técnica": its pending points are decided (new warehouses need a code, categories are matched by name and created at the top level, no locations are created).
3. Instructions, in Spanish, reflecting the rules:
   - Unidad de medida: the accepted forms of INV-BR-11 (ud, und, unidad, unidades; kg, kilo, kilogramo; g, gr, gramo; l, litro; ml, mililitro; m, metro; caja, cj; paquete, paq). `cm` is not a unit of measure.
   - Saldo inicial: 0 creates the product (and its category or warehouse) without stock.
   - Costo unitario: when blank, Pango warns and values the stock at the product's current average cost (0 for a new product).
   - The first row of a product defines its name, category, description and measures; its other rows only add stock (INV-BR-18).
   - A new warehouse needs its `Código de bodega`; its type defaults to Bodega.
   - Ubicación: blank is the warehouse's general location; any other code must already exist in Pango.
   - Opening only (keep instruction 10): a product that already has stock or movements in that warehouse, location and lot is rejected; never re-import loaded stock.
   - At most 5,000 rows per file (the effective limit, ADR-INV-013); split larger inventories into several files.
   - Dates `AAAA-MM-DD` (`DD/MM/AAAA` is also accepted).
4. Remove the two dropdowns of v0.4 (Seguimiento: Cantidad / Lote; Tipo de almacén: Bodega / Tienda): the workbook has no data validation (ADR-INV-003). The `Instrucciones` sheet lists their accepted values instead: Seguimiento `Cantidad` or `Lote`; Tipo de almacén `Bodega` or `Tienda` (owner, 2026-11-24).

### Recovery and retention (INV-012)

No state is ever stored while work is in progress: validation and confirmation run inside one transaction each, so a crash, a lost connection or a timeout rolls everything back and leaves the import in the state it had.

| State | If something fails | How to recover |
|---|---|---|
| `RECEIVING` | A batch is stored whole or not at all. | Resend the batch (same number and rows): stored once. A lost creation answer is recovered by repeating `POST /inventory-imports` with the same `clientRequestId`. |
| `RECEIVING`, `READY`, `INVALID` while validating | Nothing changes: no revision, no issues. | Validate again. If only the answer was lost, `GET /inventory-imports/:id` shows the current `revision` and status. |
| `READY` while confirming | Nothing is written; the import stays `READY` with the same revision. | Confirm again: it applies once. If the answer was lost after it applied, the repeat answers the stored result. |
| `COMPLETED` | Final. | Its summary and result stay; staged data is gone. |
| `CANCELLED`, `EXPIRED` | Final. | Start a new import. |

- `503 IMPORT_BUSY` means the operation rolled back for time, contention or a lost connection; repeat the same request. `409 IMPORT_STALE` means the data changed: validate again first.
- An open import idle for `expiryHours` (24 by default) becomes `EXPIRED` the next time anyone reads or writes an import of the organization, and its staged rows, batches and issues are deleted then. With no scheduler, until that happens the staged data of one idle import (at most `maxRowsPerImport` rows) stays in the database.
- Kept forever: each import's row (creator, file and sheet names, mapping, `clientRequestId`, summary, result, dates), so creation stays idempotent and the origin of the stock stays auditable; and the opening movements, linked to the import. Never kept after closing: the staged cell values and issues.
- Only the creator cancels an open import; anyone else waits for it to expire.

## Security (INV-013)

Verified on 2026-11-25. The module adds no dependency.

| Check | How it holds | Evidence |
|---|---|---|
| Authentication, CSRF | Every route goes through the global `CsrfGuard` and `AuthGuard`; none is `@Public()`. | `inventory-imports.security.spec.ts`; HTTP against the built app: no session → 401 `UNAUTHENTICATED`; forged bearer → 401; session cookie from a foreign origin → 403 `CSRF_REJECTED` |
| Authorization | Every route requires `inventory.import`; rows are checked per warehouse; only the creator changes an import; others see it only with the permission in every warehouse it touches. Revoked permissions make the confirmation `IMPORT_STALE`. | `inventory-import-access.*`, `inventory-import-sessions.int-spec.ts`, `inventory-import-validation.int-spec.ts`, `inventory-import-preview.int-spec.ts` |
| Tenant isolation | A session only opens its organization's schema; ids of another organization's imports do not exist for it. | `inventory-import-isolation.int-spec.ts`: every route with another organization's import id → 404; nothing leaks into or blocks the other organization |
| Disclosure | Warehouses the user may not import into answer `WAREHOUSE_FORBIDDEN` without saying whether they exist; invisible imports answer 404. `IMPORT_ACTIVE_EXISTS` says that some import is open, with its id only to its creator. | `validate.spec.ts`, `inventory-import-sessions.int-spec.ts` |
| Request validation | `ValidationPipe` with `whitelist` and `forbidNonWhitelisted`: unknown fields, wrong types, text numbers, bad ids and oversized pages are refused; the mapping and the rows are checked key by key, so prototype keys (`__proto__`) are refused and nothing outside the dictionary is stored. Malformed JSON → 400. | `inventory-imports.security.spec.ts`, `fields.spec.ts`, `batch.spec.ts`; HTTP check |
| SQL | Every value is a bound parameter. Only the schema name (checked by `assertTenantSchema`) and integer time limits are written into SQL text. | Review of every raw query of `src/inventory-imports/` |
| Resources | 1 MB per request, 5,000 rows per batch and per import, 2,000 characters per value, 4,096 per row (so an import stages about 20 MB at most), one open import per organization, 10,000 stored issues, pages up to 100, bounded transactions (ADR-INV-014). | `batch.spec.ts`, `inventory-import-rows.int-spec.ts`, `inventory-import-recovery.int-spec.ts` |
| Logs | Import id, outcome code, counts and duration only; never cell values, names or tokens. | Review of the module's logger calls |

Findings:

| # | Finding | Severity | Status |
|---|---|---|---|
| S1 | A row could carry 21 values of 2,000 characters, so one import could stage about 210 MB. | Medium | Fixed: 4,096 characters per row (`ROWS_INVALID`). |
| S2 | `body-parser` < 2.4.0 (through Express) has a denial of service with trailing bytes after a JSON body (`pnpm audit --prod`, high). It affects every JSON route of the API, not only this module. | High, pre-existing, global | Open: update Express/body-parser in a separate task for the whole API. |
| S3 | The API has no request rate limiting. | Low, pre-existing, global | Open; the module bounds its own load (one open import, batch, row and byte limits). |
| S4 | `pnpm audit --prod` also lists `source-map-js`, `effect` and `fast-uri` (Prisma's CLI and config tooling) and `qs` (`stringify` with `arrayFormat: comma`, not used). | Moderate to high, pre-existing | Open; not on the module's request path. |
| S5 | Case-insensitive duplicates of SKUs, warehouses and categories created by hand at the very moment of a confirmation (see Technical design). | Low, pre-existing | Open; future improvement. |

No critical or high finding of the module itself remains open. This review does not prove the absence of vulnerabilities.

## Testing (INV-014)

Measured on 2026-11-25 (local Docker PostgreSQL 17, Node 24).

| Suite | Command | What it covers | Result |
|---|---|---|---|
| Unit | `pnpm test` | Every module of the repository; for this module: fields and mapping, batch shape and size, cell parsing, every validation rule, access rules, configuration, retryable errors, request validation, route permissions | 390 passed (38 files) |
| Integration | `pnpm test:int` | Real PostgreSQL: migrations on new and existing tenants, permission, staging constraints, sessions, batches, validation against real stock and movements, preview, confirmation with 12 injected failures and races, recovery (timeouts, cut connections, restarts, lost answers), tenant isolation, and the whole flow over HTTP | 69 passed (11 files) |
| HTTP end to end | part of `pnpm test:int` (`inventory-import-http.int-spec.ts`) | The real app with its guards and pipes: Pango's own routes create the warehouse, category, product and purchase; the import runs, is refused (`ALREADY_HAS_STOCK`), is fixed and confirmed; `/stock`, `/products`, `/movements` and `/products/:id/demand` then show the opening and no demand; Pango's error envelope; an Operator gets 403 on all 10 routes | 3 passed |
| Existing e2e | `pnpm test:e2e` | The repository's own end-to-end check | 1 passed |

- Regression: the warehouses, movements and stock-request unit suites pass without changes after the two approved changes to those modules (INV-011); over HTTP, `POST /warehouses` still creates the `DEFAULT` location and `POST /movements` still confirms a purchase.
- Coverage of `src/inventory-imports/` with unit and integration tests together (v8): 97.11% lines, 88.21% branches, 99.03% functions, 96.89% statements. Targets approved by the owner on 2026-11-25 ("apruebo umbrales y metas"): at least 90% lines and 85% branches; both are met. Coverage supports, but does not replace, the targeted tests of the critical paths listed in this document.
- Every stage also broke its own code on purpose (removing a lock, a check or a mapping) to prove the tests catch it, and reverted it; see the traceability evidence.
- `pnpm exec tsc --noEmit` reports only the three errors that existed before this module.

## Performance (INV-015)

Measured on 2026-11-25 with `pnpm test:perf` (`test/performance/inventory-import.perf-spec.ts`). Thresholds approved by the owner before measuring ("apruebo umbrales y metas").

**Method.** Local Docker PostgreSQL 17, Node 24.21, 8 CPUs, 12 GB RAM. Supabase was not used: the module's migrations are applied there only once the module works with the frontend. Network latency to the database is simulated by a TCP proxy (`test/performance/latency-proxy.ts`) that delays every chunk by half the round trip in each direction. Synthetic file: half the SKUs already exist without stock, three warehouses, 50 new categories, a quarter of the rows lot-tracked with an expiry date, one row in ten without cost; batches split under 1 MB. One second into each confirmation, a sale of a product outside the import is recorded.

| Rows | Round trip | Batches | Largest batch | Receive (all) | Validate | Confirm | Sale of another product | Memory growth | Movements |
|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 0 ms | 1 | 0.21 s | 0.21 s | 0.44 s | 4.2 s | 0.02 s | 40 MB | 6 |
| 2,500 | 0 ms | 1 | 0.39 s | 0.40 s | 0.85 s | 8.7 s | 0.01 s | 99 MB | 6 |
| 5,000 | 0 ms | 2 | 0.48 s | 0.76 s | 1.6 s | 16.8 s | 0.02 s | 27 MB | 9 |
| 5,000 | 1 ms | 2 | 0.52 s | 0.83 s | 2.4 s | 70.4 s | 0.02 s | 9 MB | 9 |
| 1,000 | 5 ms | 1 | 0.27 s | 0.27 s | 0.87 s | 23.8 s | 0.02 s | 2 MB | 6 |
| 5,000 | 5 ms | 2 | 0.61 s | 0.95 s | 2.9 s | 116.0 s | 0.02 s | 3 MB | 9 |
| 1,000 | 20 ms | 1 | 0.53 s | 0.53 s | 2.2 s | 84.7 s | 0.02 s | 1 MB | 6 |

A file of 5,001 rows is refused (`IMPORT_LIMIT_EXCEEDED`). Each confirmation holds one database connection (the second one sampled is the concurrent sale's).

| Threshold | Measured | Result |
|---|---|---|
| Each 1 MB batch ≤ 2 s | at most 0.61 s | Met |
| Validate 5,000 rows ≤ 10 s | at most 2.9 s | Met |
| Confirm 5,000 rows without latency ≤ 60 s | 16.8 s | Met |
| Confirm 5,000 rows at 5 ms ≤ 120 s | 116.0 s | Met, with 4 s of margin |
| A sale of another product during a confirmation ≤ 2 s | at most 0.02 s | Met |
| Memory growth during a confirmation ≤ 500 MB | at most 99 MB | Met |
| One database connection per confirmation | 1 | Met |

Reading the results:

- Receiving and validating stay under 3 s at the limit; confirming dominates, because the movement engine writes line by line (about three round trips per line, six with lots).
- Confirmation time grows with network latency: the 20 ms case (1,000 rows, 85 s) shows that 5,000 rows would take several minutes and exceed the 120 s limit. The API must run in the same region as Supabase.
- The 1 ms row is pessimistic: the proxy's timers cannot wait less than about 1 ms per direction, so it adds more than 1 ms per round trip. The 5 ms and 20 ms rows are closer to their nominal latency.
- While a confirmation runs, only the products it imports wait; the rest of Pango is not slowed down (the concurrent sale took 0.02 s in every case).
- These are local measurements with simulated latency, not a guarantee of production capacity.

Recommendations (no change made): keep 5,000 rows per import; deploy the API in Supabase's region; since 5,000 rows at 5 ms leave only 4 s of margin under the 120 s confirmation limit, set `INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS` to 300000 in production, or lower `INVENTORY_IMPORT_MAX_ROWS`, if the measured round trip there is 5 ms or more. Large imports are best confirmed outside business hours, because sales of the imported products wait for the confirmation.

## Trying it locally

Without Supabase, on the throwaway database of `docker-compose.test.yml` (data lives in memory and is lost when the container stops). Port 3000 may be taken on this machine, so the API runs on 3001.

```bash
docker compose -f docker-compose.test.yml up -d
docker exec pango-postgres-test createdb -U pango pango_dev     # once per container start
export DEV=postgresql://pango:pango@127.0.0.1:54329/pango_dev
DIRECT_URL=$DEV DATABASE_URL=$DEV pnpm db:migrate:control
DIRECT_URL=$DEV DATABASE_URL=$DEV pnpm tenant:create --subdomain demo --tax-id 900000000-1 \
  --legal-name "Demo SME SAS" --country CO --city Bogotá --business-sector RETAIL --team-size SIZE_1_5 \
  --product-count COUNT_1_100 --email owner@demo.pango.local --name "Demo Owner" --password "change-me-123"
DATABASE_URL=$DEV DIRECT_URL=$DEV PORT=3001 LOGIN_EMAIL_CODE_ENABLED=false pnpm start:dev
```

Then open `http://localhost:3001/docs`, call `POST /auth/login` with header `X-Tenant: demo` and `{ "email": "owner@demo.pango.local", "password": "change-me-123" }` (it sets the session cookie), and run the flow: `GET /inventory-imports/fields` → `POST /inventory-imports` → `POST /inventory-imports/{id}/rows` → `POST /inventory-imports/{id}/validate` → `GET …/rows` and `…/issues` → `POST /inventory-imports/{id}/confirm`, using the examples of the API contract. Create a warehouse first with `POST /warehouses`, or let the import create one (it needs `warehouseCode`). Checked on 2026-11-25: the login and `GET /inventory-imports/fields` answer, and Swagger lists the ten routes.

To try it from `pango-frontend`, its import page must first be rewritten to this contract (the current one still calls the old mock, `/imports/analyze`); then run it with `VITE_USE_MOCK=false` and its dev proxy pointed at `http://localhost:3001`.

## Frontend integration (final, INV-016)

Everything a `pango-frontend` implementation needs; the authoritative rules stay in the API, so the frontend validates nothing.

Flow: offer the static template for download → the user picks a workbook → read it locally → map columns → build rows → `POST /inventory-imports` → send batches → `POST …/validate` → show the summary, preview rows and issues → `POST …/confirm` with the revision → show the result.

- **Session and organization:** call the API with credentials (`credentials: 'include'`, so the HttpOnly session cookies travel) and send `X-Tenant: <subdomain>` when the API is served from another host than the organization's subdomain; requests from other origins are refused (`CSRF_REJECTED`). Non-browser clients may use `Authorization: Bearer`.
- **Who sees the feature:** only users holding `inventory.import`; without it every route answers 403 `FORBIDDEN`, so `GET /inventory-imports/fields` answering 403 is a reliable signal to hide the feature.
- **Reading the workbook:** read values only; do not run macros or formulas, do not follow external links, and bound the file size, rows, cells and processing time. Use the sheet `Inventario` of the template, or let the user choose a sheet.
- **Columns:** match headers to the dictionary ignoring case, accents and the `*` markers; let the user fix the mapping; send it in `mapping` with the column number, which also disambiguates repeated headers.
- **Rows:** skip completely blank rows (they do not count in `totalRows`); keep the file's row number in `rowNumber`.
- **Values:** send each cell as text. Codes (SKU, warehouse, lot, location) as displayed, so leading zeros are kept. Numbers as their full value with `.` and no thousands separator. Excel dates as `YYYY-MM-DD`. Empty cells as null or omitted, never `"0"`. Do not validate or fix contents: the server reports them.
- **Batches:** fill each batch while the serialized body (`JSON.stringify`, measured in UTF-8 bytes) stays under `limits.maxRequestBytes` with some margin and at most `limits.maxRowsPerBatch` rows; number them from 1. A row whose values add up to more than `limits.maxRowChars` characters rejects its batch (`ROWS_INVALID`), as does any value over `limits.maxValueChars`. A body over 1 MB answers 413 without a `code`; a file over `limits.maxRowsPerImport` rows answers 413 `IMPORT_LIMIT_EXCEEDED` on creation: ask the user to split it.
- **Retries:** on a network error, timeout or 5xx, resend the same batch with the same `batchNumber` and content. 409 `BATCH_CONFLICT` means the frontend sent different data under the same number or row: stop and start again. Keep one `clientRequestId` per file for `POST /inventory-imports`.
- **Completeness:** validate when `receivedRows` equals `totalRows`; on 409 `IMPORT_INCOMPLETE`, send the missing rows.
- **Preview:** show `summary`, then rows and issues by page. With errors (`INVALID`), the user fixes the workbook and starts a new import (cancel the old one); warnings do not block.
- **Confirmation:** send the `revision` shown (every preview page carries the `revision` it belongs to). On 409 `IMPORT_STALE`, validate again and show the new preview before confirming.
- **Waiting:** validation and confirmation answer when they finish; there is no progress endpoint. Measured locally, 5,000 rows validate in under 3 s and confirm in 17 s to about 2 minutes depending on the database latency (see Performance). Show a waiting state and give the HTTP client a timeout above the confirmation limit (120 s by default) with some margin. If the client gives up first, call `GET /inventory-imports/:id` (or repeat the confirmation, which answers the stored result) before telling the user anything.
- **History:** `GET /inventory-imports` lists the imports the user may see, newest first, with their status, summary and result.
- **Open import:** on 409 `IMPORT_ACTIVE_EXISTS` with `importId`, offer to resume or cancel it; without it, someone else's import is open (it expires after 24 hours without activity).
- **503 `IMPORT_BUSY`:** nothing was saved; repeat the same request (after a short wait). It is safe for every route.

## Permissions (INV-004)

Implemented; every route of the module requires it.

- `inventory.import`: warehouse scope, module `inventory`, added by the tenant migration `20261124100000_inventory_import_permission`. It grants the permission to the system role (Owner) and to the role named `Admin`; Operator and custom roles are not changed. An organization that renamed or deleted `Admin` gets it only on the Owner; the Owner can add it to any role through role management, which lists permissions from the database.
- `src/inventory-imports/inventory-import-access.ts`:
  - `importScope(auth)`: `'ALL'` for the Owner, otherwise the warehouses where one of the user's roles grants the permission.
  - `mayImportInto(scope, warehouseId)`: whether a row may put stock into an existing warehouse. Warehouses created by the same import need no check (INV-BR-15).
  - `rolesForNewWarehouse(auth)` and `assignCreatorToWarehouse(tx, auth, warehouseId)`: every non-system role of the user that grants the permission, assigned once on a warehouse their import creates, inside the confirmation's transaction; nothing for the Owner. This is the system acting on an approved rule, so it does not go through `assertCanAssign` (a user may not normally assign roles to themselves).
- Not applied to Supabase: the module's migrations run only in the local test database. The owner decided (2026-11-24) to apply them to Supabase once the module is finished and works with the frontend.

## Technical design (INV-003)

Approved design (T1–T11), implemented in INV-005 (persistence), INV-011 (confirmation) and INV-012 (bounded waits).

### Persistence

Implemented in INV-005 by the tenant migration `20261124200000_inventory_imports` (Prisma models `InventoryImport`, `InventoryImportBatch`, `InventoryImportRow`, `InventoryImportIssue`; `Movement.inventoryImportId`), so every existing and new organization gets them:

| Table | Holds |
|---|---|
| `inventory_imports` | One import: `client_request_id` (unique per creator), `created_by_id`, `status` (`RECEIVING`, `READY`, `INVALID`, `COMPLETED`, `CANCELLED`, `EXPIRED`), `schema_version`, `file_name`, `sheet_name`, `total_rows`, `received_rows`, `revision`, `mapping`, the creation request's fingerprint (for `IDEMPOTENCY_CONFLICT`), `summary`, the validation outcome's fingerprint (for staleness), `result`, `last_activity_at`, `confirmed_at`, `created_at`, `updated_at`. |
| `inventory_import_batches` | Batches received: `(import_id, batch_number)` primary key, SHA-256 of the batch, row count. |
| `inventory_import_rows` | Rows as sent (`values`), `(import_id, row_number)` primary key, the batch that brought them and, after validation, status and the resolved or new entities (staging references, not foreign keys). |
| `inventory_import_issues` | Issues of the last validation, the first 10,000. |

- `movements.inventory_import_id`: nullable, foreign key to `inventory_imports`, indexed. Movements also carry `document_ref = INV-IMP-<id>`, so the existing movement screens show their origin without changes.
- One open import per organization: partial unique index `inventory_imports_open_key` over `inventory_imports` where `status` is `RECEIVING`, `READY` or `INVALID`. Also hand-written: `inventory_imports_counts_chk`, `inventory_import_batches_counts_chk` and `inventory_import_rows_row_number_chk` ([`database.md`](../architecture/database.md)). Like the other partial indexes, the tenant `migrate diff` does not try to drop it.
- Batches store `received_rows_after`, so a retried batch answers exactly what it answered the first time (INV-API-04).
- Retention: closing an import deletes its batches, rows and issues in the same transaction; the import row stays.
- Expiry: an open import whose `last_activity_at` is older than the expiry hours becomes `EXPIRED` (and its staged data is deleted) when it is next read or written, and before a new import is created. No scheduler.

### Confirmation transaction

In one transaction, in this order:

1. Per-organization advisory lock for inventory import confirmations (as the movement history import does).
2. Lock the import row. `COMPLETED` → answer the stored result. Otherwise require `READY`, the creator, and the requested revision.
3. Lock what the preview depends on, always in this order: the existing warehouses it names (`FOR SHARE`, id order), the existing categories (`FOR SHARE`), then the existing products (`FOR UPDATE`, id order, the lock movements take).
4. Run the same validation as `validate` and compare its outcome fingerprint with the stored one; any difference (stock or movements of an identity, products, categories, warehouses, locations, lots, the user's permissions) → `IMPORT_STALE`, nothing written. Case-insensitive duplicates are rechecked here, under the locks.
5. Create the new categories (top level), warehouses with their `DEFAULT` location, the role assignments of a non-Owner creator (every role of theirs that grants `inventory.import`), and products. A unique violation here → `IMPORT_STALE`.
6. Create the new lots with the file's dates.
7. Record the stock with `MovementsService.record()`: one "Opening balance" movement per warehouse and per 1,000 lines, linked to the import. It enables products in warehouses, updates balances and average costs, and evaluates alerts.
8. Mark the import `COMPLETED` with its result and delete its staged data.

A failure at any step rolls everything back; the import stays `READY` and the failure is logged (import id, step, error code, duration; never row contents). Ordinary movements wait for the product locks (step 3) and never interleave with a confirmation.

Lock order matches the existing code: movements lock only products; closing a warehouse updates the warehouse row and then locks its products. Neither takes them in the opposite order, so no deadlock cycle is introduced.

### Changes to existing code (backward compatible, implemented in INV-011)

- `src/warehouses/warehouses.service.ts`: `createWarehouseWithDefaultLocation(tx, data)` creates the warehouse and its `DEFAULT` location in the caller's transaction; `POST /warehouses` calls it inside its own transaction, as before.
- `src/movements/movements.service.ts`: `MovementRecord.inventoryImportId` (optional) is stored on the movement; existing callers pass nothing and get null, as before. The warehouses, movements and stock-request tests pass unchanged.
- Products and categories are created by the import with its own set-based inserts, after the same checks (active category, existing unit, SKU free ignoring case), because the per-item services would issue thousands of queries.

### Case-insensitive duplicates

The import never creates an SKU, warehouse code or name, or category that already exists ignoring case: it rechecks under the confirmation's locks (step 4), and imports confirm one at a time. A user creating the same code by hand at the very same moment can still produce a case duplicate, a risk that already exists between Pango's own screens. A database rule that closes it everywhere is a future improvement (it affects other modules and needs existing duplicates cleaned first).

### Configuration

Environment variables, read at start-up, with these defaults; `GET /inventory-imports/fields` reports the effective values. They are in `.env.example`.

| Variable | Default |
|---|---|
| `INVENTORY_IMPORT_MAX_ROWS` | 5000 (ADR-INV-013) |
| `INVENTORY_IMPORT_MAX_BATCH_ROWS` | 5000 |
| `INVENTORY_IMPORT_EXPIRY_HOURS` | 24 |
| `INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS` | 120000 |

The 1 MB JSON body limit stays global (ADR-INV-008).

### Integration test harness

Implemented in INV-003 (ADR-INV-012):

```bash
docker compose -f docker-compose.test.yml up -d   # PostgreSQL 17 on 127.0.0.1:54329, data in memory
pnpm test:int                                      # *.int-spec.ts against it
docker compose -f docker-compose.test.yml down
```

`test/integration/database.ts` refuses any database that is not local (`TEST_DATABASE_URL`, default `postgresql://pango:pango@127.0.0.1:54329/pango_test`), resets it before each run (drops every tenant schema and `public`, applies the control migrations) and provisions organizations with `provisionOrganization`, so every run also applies all tenant migrations.

### Stock engine benchmark (T11)

Throwaway script (not in the repository) calling `MovementsService.record()` inside one transaction, with 1,000-line "Opening balance" movements, unit cost on every line, one warehouse, new product-warehouses, counting every query.

Environment: local Docker `postgres:17-alpine` (17.12), Node 24.21, 8 CPUs, 12 GB RAM; the database runs on the same machine, so network latency is near zero.

| Rows | Lots | Time | Queries | Queries per row |
|---|---|---|---|---|
| 1,000 | no | 3.3 s | 3,018 | 3.02 |
| 5,000 | no | 14.9 s | 15,082 | 3.02 |
| 10,000 | no | 29.9 s | 30,162 | 3.02 |
| 25,000 | no | 68.3 s | 75,402 | 3.02 |
| 50,000 | no | 134.4 s | 150,802 | 3.02 |
| 5,000 | yes | 20.6 s | 30,082 | 6.02 |
| 10,000 | yes | 41.6 s | 60,162 | 6.02 |

- Time grows linearly with rows: the engine runs about three sequential queries per line (product-warehouse, balance, movement line), six with lots.
- Estimates, not measurements: against a remote database every query also pays the network round trip, about queries × latency on top of the times above. At 1 ms (API in Supabase's region) 5,000 rows add about 15 s and 50,000 about 150 s; at the 300 ms measured from the developer's machine (`project-context.md`) even 1,000 rows take minutes.
- Memory was not measured reliably (garbage collection ran during the runs).

## Future improvements

Agreed with the owner, not part of this module:

- A set-based stock path for openings, writing thousands of lines per query, to raise the 5,000-row limit (ADR-INV-013).
- A database rule against case-insensitive duplicates of SKUs, warehouse codes and names and category names.

## Final report (INV-017)

Prepared and accepted by the owner on 2026-11-25: the backend module is implementation-complete. Production release (Supabase migrations, frontend, pull request) remains a separate, owner-controlled step.

1. **Summary.** An opening of current stock from one spreadsheet: the frontend reads the static template and sends JSON batches; the API validates every row against the organization's data, previews the result by revision, and confirms it in one transaction through the movement engine, or writes nothing. 10 routes, one permission, four staging tables, two backward-compatible changes to existing modules.
2. **Approved scope.** "Approved requirements" (INV-FR-01..09, INV-BR-01..18), the API contract (INV-API-01..12), the technical design (INV-TD-01..07) and security (INV-SEC-01..05); decisions ADR-INV-001..014. Out of scope: see "Scope".
3. **Traceability.** "Requirements traceability": every row has implementation paths, tests and dated evidence.
4. **Architecture.** `src/inventory-imports/`: `fields.ts` (dictionary), `batch.ts`, `parse.ts`, `lookups.ts`, `validate.ts` (pure rules and plan), `confirm.ts` (locks and writes), `inventory-import-access.ts`, `inventory-import-config.ts`, the service and the controller. See "Technical design".
5. **Database.** Tenant migrations `20261124100000_inventory_import_permission` (permission, data only) and `20261124200000_inventory_imports` (four staging tables, nullable `movements.inventory_import_id`, hand-written constraints). Existing data unchanged (tested on an existing tenant).
6. **API.** "API contract", verified against the running app; OpenAPI at `/docs`.
7. **Security.** "Security": no open critical or high finding of the module; S2 (body-parser, high) is pre-existing and global.
8. **Inventory integrity.** Opening only (identities without stock or movements), never subtracts, no artificial demand, average costs and alerts through the movement engine, creator assignment, everything in one transaction (12 injected failures leave nothing).
9. **Transactions and concurrency.** Locks in the order of the movement engine, re-validation under locks (`IMPORT_STALE`), bounded waits and `503 IMPORT_BUSY` (ADR-INV-011, ADR-INV-014); deterministic and racing tests.
10. **Tests.** "Testing": 390 unit, 72 integration (including HTTP end to end and contract), 1 e2e; every stage proved its tests catch a deliberate break.
11. **Coverage.** 97.11% lines, 88.21% branches of the module (targets 90% and 85%, approved).
12. **Performance.** "Performance": every approved threshold met locally with simulated latency.
13. **Migration and deployment.** Apply the two tenant migrations with `pnpm tenant:migrate` (new tenants get them on sign-up); run `pnpm prisma:generate` and `pnpm build`; add the optional `INVENTORY_IMPORT_*` variables (see `.env.example`; consider `INVENTORY_IMPORT_CONFIRM_TIMEOUT_MS=300000`); deploy the API in Supabase's region. Rollback: the migrations only add; to undo, drop the four tables, the column and the permission rows in a new migration after confirming no import was used. Not done: the owner decided to apply them to Supabase once the module works with the frontend.
14. **Frontend.** "Frontend integration (final)", "Standard template" and "Trying it locally".
15. **Limitations and residual risks.** 5,000 rows per import (larger files are split); a confirmation of many rows makes sales of the imported products wait; an idle import's staged data stays until the next import request of the organization; only the creator cancels an open import; case-insensitive duplicates created by hand at the same instant (S5); body-parser (S2) and no rate limiting (S3) across the API; performance not yet measured against Supabase.
16. **Outstanding work outside the module.** Rewrite the frontend import page; test frontend and API together; apply the migrations to Supabase and measure there; open the pull request to `dev`; future improvements (bulk stock path for larger openings, database rule against case duplicates); update body-parser for the whole API.
17. **Acceptance checklist.**

| Item | State |
|---|---|
| Every approved requirement implemented and verified | Yes (traceability) |
| Every route operational, no mocks or placeholders in production code | Yes |
| Atomicity proven against real PostgreSQL | Yes (12 injected failures) |
| No duplicate stock on retries; invariants preserved; no artificial demand | Yes |
| Concurrency tested (purchases, simultaneous confirmations, locks) | Yes |
| Tenant isolation and warehouse authorization tested | Yes |
| No open critical or high finding of the module | Yes (S2 is global, pre-existing) |
| Build, lint (0 warnings in the module) and every test suite pass | Yes |
| Performance thresholds approved and met | Yes (local, simulated latency) |
| Migrations verified on new and existing tenants | Yes (local); not applied to Supabase by decision |
| Documentation, OpenAPI and frontend contract consistent | Yes (contract test) |
| Stages INV-000 to INV-016 accepted by the owner | Yes |
| INV-017 accepted by the owner | Yes, 2026-11-25 |

## Discovery (INV-000)

Accepted by the owner on 2026-11-24. Inspected `dev` at `bd52a65`.

- **Reusable:** `MovementsService.record()` (`src/movements/movements.service.ts`) records a confirmed movement inside a caller's transaction: it locks the products' rows in id order, enables the product in the warehouse, creates lots, updates balances and the weighted average cost, and evaluates alerts. Stock requests already compose it. `evaluateAlerts` (`src/replenishment/evaluate-alerts.ts`) works inside the same transaction. The movement history import (`src/movement-imports/`) is the reference for staging, revisions and confirmation, except that it saves valid rows and drops invalid ones, which this module must not do.
- **Needs transaction-aware extraction:** product, category and warehouse creation (`src/catalog/products.service.ts`, `src/catalog/categories.service.ts`, `src/warehouses/warehouses.service.ts`) do not join a caller's transaction; warehouse creation opens its own.
- **Constraints:** quantities and costs are `numeric(14,4)`; `movement_lines.line_number` is `smallint` (at most 32,767 lines per movement; the movements API allows 200); movement transactions use a 20 s timeout; the global JSON body limit is 1 MB (`src/main.ts`).
- **Pre-existing risks:** SKU, warehouse code and name, and sibling category names are unique ignoring case only in application code, so concurrent creation can produce case duplicates; `holds_stock` is not enforced by movements; lot codes are matched exactly by movements but ignoring case by the history import's validation.
- **Locations:** only warehouse creation creates a location (`DEFAULT`), and nothing sets a product's default location, so today every balance is at a warehouse's `DEFAULT` location.
- **Baseline before any change:** `pnpm test` 289/289 passed (29 files); `pnpm lint` exit 0; `pnpm build` passed; `pnpm exec tsc --noEmit` 3 pre-existing errors (`test/app.e2e-spec.ts:4`, `src/movement-imports/movement-imports.service.spec.ts:429` and `:432`); `pnpm test:e2e` 1/1 passed; coverage of `src/` (v8, generated client excluded) 62.68% lines, 63.23% branches. No CI in the repository.

## Pending decisions

| Topic | Stage |
|---|---|

## Progress

| Stage | Objective | Status | Implementation approval | Final acceptance | Tests | Documentation |
|---|---|---|---|---|---|---|
| INV-000 | Read-only discovery | ACCEPTED | n/a (read only) | 2026-11-24 ("acepto las dos primeras INV") | Baseline above | This section |
| INV-001 | Requirements and business rules | ACCEPTED | 2026-11-24 ("apruebo todas las demás") | 2026-11-24 ("acepto INV-001 y autorizo INV-002") | n/a (documentation) | This document |
| INV-002 | Frontend/backend API contract | ACCEPTED | 2026-11-24 (C1–C7: "apruebo todas") | 2026-11-24 ("acepto INV-002") | n/a (documentation) | API contract, Frontend integration |
| INV-003 | Architecture and persistence design | ACCEPTED | 2026-11-24 (T1–T11 "apruebo todas"; T10–T11 included) | 2026-11-24 ("acepto INV-003 y autorizo INV-004") | `pnpm test:int` 1/1; benchmark above | Technical design |
| INV-004 | Authentication and authorization | ACCEPTED | 2026-11-24 ("sí, simplifícalo y empieza INV-004") | 2026-11-24 ("acepto INV-004 y autorizo INV-005") | Unit 8/8 (`inventory-import-access.spec.ts`); integration 4/4 (`inventory-import-access.int-spec.ts`) | Permissions, `database.md` |
| INV-005 | Database migrations and staging | ACCEPTED | 2026-11-24 ("acepto INV-004 y autorizo INV-005") | 2026-11-24 ("acepto inv-005, autorizo inv-006") | Integration 5/5 (`inventory-import-staging.int-spec.ts`); `migrate diff` in sync | Persistence, `database.md` |
| INV-006 | Template (static, frontend; see ADR-INV-003) | ACCEPTED | 2026-11-24 ("acepto inv-005, autorizo inv-006") | 2026-11-24 ("acepto INV-006 y autorizo INV-007") | n/a (documentation) | Standard template |
| INV-007 | Import session management | ACCEPTED | 2026-11-24 ("acepto INV-006 y autorizo INV-007") | 2026-11-24 ("acepto INV-007 y autorizo INV-008") | Unit 20/20 (`src/inventory-imports/*.spec.ts` except access); integration 9/9 (`inventory-import-sessions.int-spec.ts`); OpenAPI lists the 5 routes | API contract (sessions), Configuration |
| INV-008 | Batch reception and idempotency | ACCEPTED | 2026-11-24 ("acepto INV-007 y autorizo INV-008") | 2026-11-24 ("acepto INV-008 y autorizo INV-009") | Unit 4/4 (`batch.spec.ts`); integration 9/9 (`inventory-import-rows.int-spec.ts`); 413 checked over HTTP | API contract (rows) |
| INV-009 | Validation and normalization | ACCEPTED | 2026-11-24 ("acepto INV-008 y autorizo INV-009") | 2026-11-25 ("acepto INV-009 y autorizo INV-010") | Unit 40/40 (`parse.spec.ts`, `validate.spec.ts`); integration 5/5 (`inventory-import-validation.int-spec.ts`); 5,000 rows validated in 1.2 s locally | API contract (validate, row issues) |
| INV-010 | Preview and revision control | ACCEPTED | 2026-11-25 ("acepto INV-009 y autorizo INV-010") | 2026-11-25 ("acepto INV-010 y autorizo INV-011") | Integration 6/6 (`inventory-import-preview.int-spec.ts`); route metadata unit test; OpenAPI lists both routes | API contract (preview rows) |
| INV-011 | Atomic confirmation | ACCEPTED | 2026-11-25 ("acepto INV-010 y autorizo INV-011") | 2026-11-25 ("acepto INV-011 y autorizo INV-012") | Integration 20/20 (`inventory-import-confirm.int-spec.ts`: full plan, idempotency, stale, states, assignment, alerts, 12 injected failures, concurrency); 5,000 rows confirmed in 17.8 s locally | API contract (confirm), Technical design |
| INV-012 | Lifecycle and failure recovery | ACCEPTED | 2026-11-25 ("acepto INV-011 y autorizo INV-012") | 2026-11-25 ("acepto INV-012 y autorizo INV-013") | Unit 13/13 (`inventory-import-errors.spec.ts`); integration 4/4 (`inventory-import-recovery.int-spec.ts`); full suite 374 unit, 63 integration | Recovery and retention, ADR-INV-014 |
| INV-013 | Security hardening | ACCEPTED | 2026-11-25 ("acepto INV-012 y autorizo INV-013") | 2026-11-25 ("acepto INV-013 y autorizo INV-014") | Unit 15/15 (`inventory-imports.security.spec.ts`) + row limit; integration 3/3 (`inventory-import-isolation.int-spec.ts`); HTTP checks; `pnpm audit --prod` | Security |
| INV-014 | Integration and regression testing | ACCEPTED | 2026-11-25 ("acepto INV-013 y autorizo INV-014") | 2026-11-25 ("acepto INV-014 y autorizo INV-015") | Unit 390/390; integration 69/69 (HTTP end to end 3/3); e2e 1/1; module coverage 97.11% lines, 88.21% branches | Testing |
| INV-015 | Performance and load testing | ACCEPTED | 2026-11-25 ("acepto INV-014 y autorizo INV-015"; thresholds: "apruebo umbrales y metas") | 2026-11-25 ("acepto INV-015 y autorizo INV-016") | `pnpm test:perf` 8/8; every approved threshold met | Performance |
| INV-016 | Final frontend integration contract | ACCEPTED | 2026-11-25 ("acepto INV-015 y autorizo INV-016") | 2026-11-25 ("acepto INV-016 y autorizo INV-017") | Contract test 3/3 (`inventory-import-contract.int-spec.ts`); codes in code and doc match both ways; lint 0 warnings in the module | API contract (verified examples), Frontend integration (final) |
| INV-017 | Production readiness and final acceptance | ACCEPTED | 2026-11-25 ("acepto INV-016 y autorizo INV-017") | 2026-11-25 ("acepto INV-017, haz commit y push") | Final report; local run checked (login, fields, Swagger) | Final report, Trying it locally |

Approval process (owner, 2026-11-24, from INV-004): authorizing a stage also approves its proposal; the proposal is still shown, implementation starts at once, and the stage stops only for final acceptance.

INV-006 was "dynamic XLSX template" in the specification; after ADR-INV-003 its scope is documenting the static template for the frontend.

## Requirements traceability

| Requirement ID | Approved requirement/decision | Acceptance criteria | Implementation paths | Test references | Evidence | Status |
|---|---|---|---|---|---|---|
| INV-FR-01 | One file, one session, batches | All batches of a file are staged under one import id; validation runs only once every declared row is received | `src/inventory-imports/inventory-imports.service.ts` | `inventory-import-rows.int-spec.ts`; `test/integration/inventory-import-http.int-spec.ts` | 2026-11-25: batches of one file staged under one import id, in any order; over HTTP a file in two batches validates and confirms | Implemented, awaiting acceptance |
| INV-FR-02 | Per-session row limit | A session declaring or receiving more rows than the limit is rejected before staging them | `src/inventory-imports/inventory-import-config.ts`; `inventory-imports.service.ts` (`create`) | `inventory-imports.service.spec.ts`; `inventory-import-sessions.int-spec.ts` | 2026-11-25: `totalRows` above the limit → 413 `IMPORT_LIMIT_EXCEEDED` before touching the database; default 5,000 | Implemented, awaiting acceptance |
| INV-FR-03 | All or nothing | A failure injected after any intermediate write leaves products, categories, warehouses, locations, lots, product-warehouses, balances, movements, costs, alerts and the import status unchanged (real PostgreSQL) | `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: a failure injected by a database trigger during category, warehouse, default location, role assignment, product, lot, product-warehouse, balance, average cost, movement, alert or completion writes leaves every table and the import unchanged (12 cases), and the same import then confirms | Implemented, awaiting acceptance |
| INV-FR-04 | Independent sessions | A failed session leaves an earlier confirmed session's changes intact | `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts`; `test/integration/inventory-import-http.int-spec.ts` | 2026-11-25: imports confirmed one after another keep each other's changes; a failed confirmation leaves earlier imports intact | Implemented, awaiting acceptance |
| INV-FR-05 | Eligible identities only | A row whose identity has stock or any movement is a blocking error; re-importing a confirmed file changes nothing | `src/inventory-imports/validate.ts`; `src/inventory-imports/lookups.ts` | `src/inventory-imports/validate.spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: unit and integration tests passed; against real balances and movement lines, a new revision sees new stock; with the rule disabled 3 tests failed (check reverted) | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-FR-06 | Never subtract, absent ≠ zero | Balances not named in the file are unchanged; no outbound or decreasing movement is created | `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`); `src/inventory-imports/validate.ts` | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: only inbound "Opening balance" lines are recorded; an earlier balance at another location stays as it was | Implemented, awaiting acceptance |
| INV-FR-07 | Server validation, mandatory preview | Confirmation of a session that was never validated, or of another revision, is rejected | `src/inventory-imports/inventory-imports.service.ts` (`validate`, `confirm`) | `test/integration/inventory-import-validation.int-spec.ts`; `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: confirming another revision → `IMPORT_STALE`; INVALID or RECEIVING → `IMPORT_NOT_READY`; validation writes nothing definitive | Implemented, awaiting acceptance |
| INV-FR-08 | No artificial demand | After a confirmed import, `GET /products/:id/demand` and the forecast input's demand are unchanged | `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: after a confirmed import the shared demand rule (`demandCondition`) finds no line; every opening movement has `countsAsDemand = false` | Implemented, awaiting acceptance |
| INV-FR-09 | No workbook in the API | No endpoint accepts or returns a workbook | `src/inventory-imports/inventory-imports.controller.ts` | `inventory-imports.service.spec.ts` (route list); OpenAPI check | 2026-11-25: the 10 routes take and return JSON only; no upload or download route exists | Implemented, awaiting acceptance |
| INV-BR-01 | Missing cost: warning | A row without cost is valid, warned `COST_MISSING`, and its line takes the current average cost | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-02 | Existing product conflicts | Unit or tracking mismatch → error; descriptive mismatch → warning; the product row is unchanged | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-03 | Inactive entities | Inactive product, warehouse or category → error | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-04 | Non-stock warehouses | Quantity > 0 where `holds_stock = false` → error | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-05 | Category resolution | One match reused, several → `CATEGORY_AMBIGUOUS`, none → created at the top level on confirmation | `src/inventory-imports/validate.ts`; `src/inventory-imports/lookups.ts` | `src/inventory-imports/validate.spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: unit and integration tests passed; accents distinguish categories | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-06 | Warehouse resolution | Code first, then name; mismatching code and name → error; new warehouse without code → error; default type `WAREHOUSE` | `src/inventory-imports/validate.ts`; `src/inventory-imports/lookups.ts` | `src/inventory-imports/validate.spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-07 | Location resolution | Blank → product default or `DEFAULT`; unknown or inactive → error; no location created | `src/inventory-imports/validate.ts`; `src/inventory-imports/lookups.ts` | `src/inventory-imports/validate.spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-08 | Lots | Required/refused by tracking; existing lot reused, differing dates warned and kept; new lot gets the file's dates | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-09 | Lot dates | Expiry before manufacture → error | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-10 | Zero rows | Creates new entities named, no stock, no lot, no zero-quantity movement | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-11 | Units and aliases | Listed aliases resolve; anything else → error; existing product's unit must match | `src/inventory-imports/validate.ts`; `src/inventory-imports/lookups.ts` | `src/inventory-imports/validate.spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: unit and integration tests passed; aliases from `fields.ts` | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-12 | Duplicate rows | Identical rows count once with a warning; same identity with different values → error on both; same SKU with different name, unit or tracking → error | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-BR-13 | Valuation | Average cost after confirmation equals the weighted average of existing stock (in transit included) and the imported quantities at their costs | `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: 50 at 10 plus 30 at 20 → 13.75; a new product at 100 with a line without cost keeps 100 | Implemented, awaiting acceptance |
| INV-BR-14 | Opening balance movements | Every stock line is an inbound "Opening balance" movement registered by the importer, at confirmation time, linked to the import | `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: every movement is a CONFIRMED "Opening balance" with `documentRef = INV-IMP-<id>`, `inventory_import_id` and the creator as `registered_by` | Implemented, awaiting acceptance |
| INV-BR-15 | Authorization per warehouse | Owner: any warehouse; others: warehouses where they hold the permission plus warehouses the import creates; creator assigned to new warehouses; anything else → error without revealing whether the warehouse exists | `src/inventory-imports/inventory-import-access.ts`; `src/inventory-imports/validate.ts`; `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `inventory-import-access.spec.ts`; `test/integration/inventory-import-access.int-spec.ts`; `test/integration/inventory-import-validation.int-spec.ts`; `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: Owner anywhere; an Admin only in their warehouses (`WAREHOUSE_FORBIDDEN` elsewhere, without revealing it), and assigned with Admin on the warehouse their import created | Implemented, awaiting acceptance |
| INV-BR-16 | Default grants | After migration, Owner and Admin hold `inventory.import`, Operator does not, custom roles are unchanged | `prisma/tenant/migrations/20261124100000_inventory_import_permission/migration.sql` | `test/integration/inventory-import-access.int-spec.ts` | 2026-11-24: new and existing tenant 2/2 passed; with the migration altered to also grant Operator, 3 tests failed (check reverted) | Implemented, awaiting acceptance |
| INV-BR-17 | Session ownership and visibility | Only the creator changes a session; others see it only with the permission in every warehouse it touches, else 404 | `src/inventory-imports/inventory-imports.service.ts` (`canSee`, `lockOwn`) | `src/inventory-imports/inventory-imports.service.spec.ts`; `test/integration/inventory-import-sessions.int-spec.ts` | 2026-11-24: creator and Owner see; an Admin sees only imports whose warehouses are all theirs, else 404; non-creator cancel → 403 | Implemented for sessions, awaiting acceptance |

| INV-API-01 | Values as text (ADR-INV-007) | A bad cell becomes a row issue with its row and source column; the batch is accepted | `src/inventory-imports/batch.ts`; `src/inventory-imports/parse.ts` | `batch.spec.ts`; `parse.spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: `"diez"` as quantity is accepted by the batch and reported as `INVALID_VALUE` on its row and source column | Implemented, awaiting acceptance |
| INV-API-02 | Batches under 1 MB (ADR-INV-008) | Batches up to 5,000 rows within 1 MB are accepted; larger bodies answer 413; `main.ts` limit unchanged | `src/main.ts` (unchanged 1 MB); `src/inventory-imports/inventory-imports.service.ts` (`appendRows`) | `test/integration/inventory-import-rows.int-spec.ts`; HTTP check | 2026-11-24: 1.4 MB body → 413 (no `code`); more rows than the batch limit → 413 `IMPORT_LIMIT_EXCEEDED`; `main.ts` not changed | Implemented, awaiting acceptance |
| INV-API-03 | Idempotent creation | Repeating `POST /inventory-imports` with the same `clientRequestId` returns the same import; a different body → 409 `IDEMPOTENCY_CONFLICT`; concurrent repeats create one import | `src/inventory-imports/inventory-imports.service.ts` (`create`) | `test/integration/inventory-import-sessions.int-spec.ts`; `test/integration/inventory-import-recovery.int-spec.ts` | 2026-11-25: replay, `IDEMPOTENCY_CONFLICT`, and 10 rounds of 4 simultaneous identical requests → one import each (5 consecutive runs). INV-012 found and fixed a race: a twin that committed between the two reads made the other answer `IMPORT_ACTIVE_EXISTS`; the open import is now checked first and recognized as the same request. A creation repeated after a restart answers the same import | Implemented, awaiting acceptance |
| INV-API-04 | Idempotent batches | Same batch again → same response, `replayed: true`, counts unchanged; other content or a row already received → 409 `BATCH_CONFLICT` | `src/inventory-imports/inventory-imports.service.ts` (`appendRows`) | `test/integration/inventory-import-rows.int-spec.ts` | 2026-11-24: retry (rows reordered) → same answer, `replayed: true`, counts unchanged; other rows under the number or a received row → `BATCH_CONFLICT`, nothing stored; 5 identical batches at once → stored once; 6 different batches at once → 60 rows, counts 10..60. Without the hash check, the received-row check or the row lock, 1 test failed each (checks reverted) | Implemented, awaiting acceptance |
| INV-API-05 | Completeness | Validation before every declared row arrived → 409 `IMPORT_INCOMPLETE`; more rows than declared → 409 `ROWS_EXCEED_TOTAL` | `src/inventory-imports/inventory-imports.service.ts` (`appendRows`, `validate`) | `test/integration/inventory-import-rows.int-spec.ts`; `test/integration/inventory-import-validation.int-spec.ts` | 2026-11-24: more rows than declared → `ROWS_EXCEED_TOTAL`; validating with rows missing → `IMPORT_INCOMPLETE` with both counts | Implemented, awaiting acceptance |
| INV-API-06 | Lifecycle | Every state × action in the lifecycle table answers as documented | `src/inventory-imports/inventory-imports.service.ts` | `test/integration/inventory-import-sessions.int-spec.ts`; `inventory-import-rows.int-spec.ts`; `inventory-import-validation.int-spec.ts`; `inventory-import-confirm.int-spec.ts`; `inventory-import-recovery.int-spec.ts` | 2026-11-25: every state × action of the lifecycle table answers as documented; a failure in any state leaves it unchanged and the same request succeeds when repeated | Implemented, awaiting acceptance |
| INV-API-07 | One open import, 24 h expiry | A second open import → 409 `IMPORT_ACTIVE_EXISTS`; an import idle for 24 h is `EXPIRED` when read and no longer blocks a new one | `src/inventory-imports/inventory-imports.service.ts`; `inventory_imports_open_key` | `test/integration/inventory-import-sessions.int-spec.ts` | 2026-11-24: simultaneous creations by two users → one import and `IMPORT_ACTIVE_EXISTS` (with `importId` only for its creator); idle 25 h → `EXPIRED`, staged data deleted, a new import allowed; with expiry not deleting staged data 1 test failed (check reverted) | Implemented, awaiting acceptance |
| INV-API-08 | Synchronous validation and confirmation | Both answer the final state in the same request; no state stays "processing" | `src/inventory-imports/inventory-imports.service.ts` | `test/integration/inventory-import-validation.int-spec.ts`; `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: validate and confirm answer the final state in the request; no state other than RECEIVING, READY, INVALID, COMPLETED, CANCELLED, EXPIRED is ever stored | Implemented, awaiting acceptance |
| INV-API-09 | Idempotent confirmation, stale preview | Repeated confirmation returns the same result without new writes; a changed dependency → 409 `IMPORT_STALE` | `src/inventory-imports/confirm.ts`; `src/inventory-imports/inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: a repeated confirmation and two simultaneous ones answer the same result with one set of movements; a change after validation → `IMPORT_STALE`, nothing written; without the fingerprint check 2 tests failed (check reverted) | Implemented, awaiting acceptance |
| INV-API-10 | Bounded responses | Rows, issues and history are paginated (`pageSize` ≤ 100); at most 10,000 issues stored, all counted | `src/inventory-imports/inventory-imports.service.ts` (`rowPage`, `issuePage`, `list`); `inventory-import-config.ts` (`maxStoredIssues`) | `test/integration/inventory-import-preview.int-spec.ts`; `inventory-import-sessions.int-spec.ts` | 2026-11-25: rows and issues paged and filtered (status, severity, code), each page carries its revision; empty once closed; without the status filter, the severity filter or the visibility check, 1 test failed each (checks reverted) | Implemented, awaiting acceptance |
| INV-API-11 | Field metadata | `GET /inventory-imports/fields` lists the 21 fields, units with aliases and the effective limits, from the same definitions the server validates with | `src/inventory-imports/fields.ts`; `src/inventory-imports/inventory-imports.service.ts` | `src/inventory-imports/fields.spec.ts`; `test/integration/inventory-import-sessions.int-spec.ts` | 2026-11-24: 21 fields, 8 units with aliases, default limits | Implemented, awaiting acceptance |

| INV-BR-18 | First row defines a new product or warehouse | Later rows' differing values yield one `PRODUCT_VALUES_DIFFER` warning per product and are not applied; differing unit or tracking → `PRODUCT_INCONSISTENT` | `src/inventory-imports/validate.ts` | `src/inventory-imports/validate.spec.ts` | 2026-11-24: unit and integration tests passed | Validation implemented, awaiting acceptance (written on confirmation, INV-011) |
| INV-TD-01 | Staging, one open import, retention (ADR-INV-010) | Two concurrent creations → one import, one 409; closing deletes batches, rows and issues and keeps the import row | `prisma/tenant/schema.prisma` (inventory import models); `prisma/tenant/migrations/20261124200000_inventory_imports/migration.sql` | `test/integration/inventory-import-staging.int-spec.ts` | 2026-11-24: 5/5 passed (one open import, client request id, counts, cascade of staged data, movements keep their import, existing tenant unchanged); without the open-import index and the counts check, 2 tests failed (check reverted). The 409 and the deletion on close are service behavior (INV-007, INV-012) | Database part implemented, awaiting acceptance |
| INV-TD-02 | Confirmation under locks with re-validation (ADR-INV-011) | A sale, purchase or entity change committed between validation and confirmation → `IMPORT_STALE` and no write; a sale started during a confirmation waits and then applies on top of the opening | `src/inventory-imports/confirm.ts` (`lockDependencies`); `inventory-imports.service.ts` (`confirm`) | `test/integration/inventory-import-confirm.int-spec.ts` | 2026-11-25: a purchase holding the product makes the confirmation wait and then answer `IMPORT_STALE` (deterministic test); in 10 races with a purchase the balance always equals its movement lines and an opening is never loaded on a lot that had stock. Without the locks before re-validating, the deterministic test failed (check reverted) | Implemented, awaiting acceptance |
| INV-TD-03 | Backward-compatible extractions | Existing warehouse and movement tests pass unchanged; `POST /warehouses` and `POST /movements` answer as before | `src/warehouses/warehouses.service.ts` (`createWarehouseWithDefaultLocation`); `src/movements/movements.service.ts` (`inventoryImportId`) | `src/warehouses/warehouses.service.spec.ts`; `src/movements/movements.service.spec.ts`; `src/stock-requests/stock-requests.service.spec.ts` | 2026-11-25: the three suites (45 tests) pass without changes | Implemented, awaiting acceptance |
| INV-TD-04 | Configurable limits | Each variable changes the effective limit and `GET /inventory-imports/fields` | `src/inventory-imports/inventory-import-config.ts`; `.env.example` | `src/inventory-imports/inventory-import-config.spec.ts` | 2026-11-24: defaults, overrides and invalid values (start-up error) tested | Implemented, awaiting acceptance |
| INV-TD-05 | Integration harness (ADR-INV-012) | Refuses a non-local database; provisions a tenant with every migration | `docker-compose.test.yml`, `vitest.config.integration.ts`, `test/integration/database.ts`, `test/integration/global-setup.ts` | `test/integration/provisioning.int-spec.ts` | 2026-11-24: `pnpm test:int` 1/1 passed; with `TEST_DATABASE_URL` on `db.example.com` the run stops with "Integration tests only run against a local database" | Implemented, awaiting acceptance |
| INV-TD-07 | Bounded waits and retryable failures (ADR-INV-014) | A confirmation waiting for a lock longer than its limit answers 503 `IMPORT_BUSY` within the limit, writes nothing and confirms on retry; a connection cut mid-confirmation does the same; an import continues after a restart | `src/inventory-imports/inventory-import-errors.ts`; `src/inventory-imports/inventory-imports.service.ts` (`boundWaits`, `retryable`) | `src/inventory-imports/inventory-import-errors.spec.ts`; `test/integration/inventory-import-recovery.int-spec.ts` | 2026-11-25: lock held 3 s, limit 0.8 s → 503 in under 2.5 s; `pg_terminate_backend` on the waiting confirmation → 503, nothing written, the retry completes; a second server instance finishes an import the first started. Without the time limits or the 503 mapping, 1 and 2 tests failed (checks reverted) | Implemented, awaiting acceptance |
| INV-SEC-01 | Tenant isolation | Another organization's import ids answer 404 on every route; nothing leaks into or blocks the other organization | `src/inventory-imports/inventory-imports.service.ts` (tenant client from the session) | `test/integration/inventory-import-isolation.int-spec.ts` | 2026-11-25: 3/3 passed | Implemented, awaiting acceptance |
| INV-SEC-02 | Request validation | Unknown fields, wrong types and prototype keys refused before the handlers; malformed JSON → 400 | `src/inventory-imports/dto.ts`; `fields.ts`; `batch.ts` | `src/inventory-imports/inventory-imports.security.spec.ts`; `fields.spec.ts`; `batch.spec.ts` | 2026-11-25: 15/15 passed; HTTP: malformed JSON → 400 | Implemented, awaiting acceptance |
| INV-SEC-03 | Staged size bound | A row over 4,096 characters → `ROWS_INVALID`; `maxRowChars` in `GET /fields` | `src/inventory-imports/batch.ts`; `inventory-import-config.ts` | `src/inventory-imports/batch.spec.ts`; `inventory-import-sessions.int-spec.ts` | 2026-11-25: passed; without the check its test failed (check reverted) | Implemented, awaiting acceptance |
| INV-SEC-04 | Session and CSRF on every route | No `@Public()`; no session → 401; foreign origin with a session cookie → 403 | `src/inventory-imports/inventory-imports.controller.ts` (global guards) | `inventory-imports.security.spec.ts`; HTTP checks | 2026-11-25: passed | Implemented, awaiting acceptance |
| INV-SEC-05 | Dependency review | No new dependency; audit findings recorded with severity | `package.json` (only `test:int` added) | `pnpm audit --prod` | 2026-11-25: 3 high, 3 moderate, 2 low, all pre-existing (S2, S4) | Reviewed, awaiting acceptance |
| INV-API-12 | Contract verified against the running API | Every response of every route conforms to its OpenAPI schema; OpenAPI lists exactly the ten routes; error bodies carry only documented fields; every issue and error code the module produces is documented, and every documented one is produced; examples are real responses | `src/inventory-imports/` (controllers, DTOs, responses) | `test/integration/inventory-import-contract.int-spec.ts` | 2026-11-25: 3/3 passed; with an undocumented field added to a response the test failed (check reverted) | Implemented, awaiting acceptance |
| INV-TD-06 | Limit from measurements (ADR-INV-013) | Default 5,000 rows per import; benchmark recorded with its environment | `src/inventory-imports/inventory-import-config.ts` (5,000 by default) | `test/performance/inventory-import.perf-spec.ts` | 2026-11-25: 1,000 to 5,000 rows at 0 to 20 ms of simulated latency; every approved threshold met (5,000 rows at 5 ms confirmed in 116.0 s of 120 s); 5,001 rows refused | Implemented, awaiting acceptance |

## Change log

- 2026-11-25 — INV-017 accepted: the backend module is complete.
- 2026-11-25 — INV-016 accepted. INV-017: final report, local trial instructions (checked), status set for final acceptance.
- 2026-11-25 — INV-015 accepted. INV-016: contract test against OpenAPI and real responses, examples replaced by real ones, error extras documented, frontend guide completed (session, visibility, limits, waiting, history), stale statements and ADR statuses updated, lint warnings in the module fixed.
- 2026-11-25 — INV-014 accepted; performance thresholds and coverage targets approved. INV-015: benchmark (`pnpm test:perf`, latency proxy), measurements from 1,000 to 5,000 rows at 0 to 20 ms, every threshold met, recommendations recorded.
- 2026-11-25 — INV-013 accepted. INV-014: HTTP end-to-end test through the real app, regression of the touched modules, test inventory and module coverage (97.11% lines, 88.21% branches).
- 2026-11-25 — INV-012 accepted. INV-013: security review (authentication, CSRF, authorization, tenant isolation, disclosure, request validation, SQL, resources, logs, dependencies); 4,096-character row limit (S1); open pre-existing findings recorded; security, isolation and HTTP checks.
- 2026-11-25 — INV-011 accepted. INV-012: bounded lock waits and statements in every import transaction, `503 IMPORT_BUSY` for retryable failures (ADR-INV-014), recovery and retention documented per state, a creation race fixed; recovery tests (lock timeout, cut connection, restart, lost answers).
- 2026-11-25 — INV-010 accepted. INV-011: `POST /inventory-imports/:id/confirm` (re-validation under locks, `IMPORT_STALE`, plan written in one transaction through the movement engine, lines with cost first, creator assignment, staged data deleted); `createWarehouseWithDefaultLocation` and `MovementRecord.inventoryImportId` in existing modules; integration tests with injected failures and races; 5,000 rows measured.
- 2026-11-25 — INV-009 accepted. INV-010: `GET /inventory-imports/:id/rows` and `GET /inventory-imports/:id/issues`, paged and filtered, carrying the validation `revision` (added to the contract); integration tests.
- 2026-11-24 — Handoff section added for whoever continues the module.
- 2026-11-24 — INV-008 accepted. INV-009: `POST /inventory-imports/:id/validate` with cell parsing, set-based lookups, every row rule, stored previews, issues and summary, revision and outcome fingerprint; unit and integration tests; 5,000 rows measured locally.
- 2026-11-24 — INV-007 accepted. INV-008: `POST /inventory-imports/:id/rows` (structural batch check, idempotent batches by number and SHA-256, received-row and declared-total checks, one batch at a time per import), unit and integration tests; the 413 body for bodies over 1 MB recorded.
- 2026-11-24 — INV-006 accepted. INV-007: `InventoryImportsModule` with the field dictionary, configuration, session routes (fields, create, get, cancel, list), idempotent creation, one open import, lazy expiry and visibility; unit and integration tests; `.env.example`. `GET /fields` returns `units` at the top level (the contract example showed them inside the unit field).
- 2026-11-24 — INV-005 accepted. INV-006: standard template section (sheets, columns A–U with API keys, changes from v0.4).
- 2026-11-24 — INV-004 accepted. INV-005: tenant migration `20261124200000_inventory_imports` (staging tables, `movements.inventory_import_id`, hand-written constraints) with integration tests; `database.md` updated.
- 2026-11-24 — INV-004: `inventory.import` permission migration, access helpers and automatic assignment, with unit and integration tests; `database.md` permission catalog updated (32 permissions; it said 30 although 31 existed before this migration). Approval process simplified by the owner.
- 2026-11-24 — INV-003 accepted; INV-004 authorized, proposal under review.
- 2026-11-24 — INV-003: technical design (persistence, confirmation transaction and lock order, code changes, configuration), integration harness, stock engine benchmark, ADR-INV-010..013, INV-BR-18 (first row defines a new product; supersedes the name rule of INV-BR-12) and the 5,000-row default (INV-FR-02 and contract examples updated).
- 2026-11-24 — INV-002 accepted.
- 2026-11-24 — INV-002: API contract, frontend integration guide, ADR-INV-007..009 and INV-API-01..11 recorded after the owner approved C1–C7.
- 2026-11-24 — INV-001 accepted; INV-002 authorized, proposal under review.
- 2026-11-24 — INV-001: document created with the accepted discovery, approved requirements and business rules (INV-FR-01..09, INV-BR-01..17) and ADR-INV-001..006.
