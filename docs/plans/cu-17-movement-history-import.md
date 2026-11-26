# CU-17 · Movement history import

**Status** · Implemented on `feature/movement-import-preview` (2026-11-24), validated against Supabase. Behavior: [`modules/movement-imports.md`](../modules/movement-imports.md).

## Goal

Give demand and the forecast a base from a company's history before Pango, from its first day, without ever touching inventory.

## Decisions (with the user, 2026-11-24)

1. **Isolated from inventory.** The range and freshness of a company's history cannot be controlled, so it never changes stock, costs, alerts, reorder points or the catalog, and inventory never reads it. Current stock gets its own import module; after it, only Pango movements change stock.
2. **Separate table.** History lives in `historical_movements`, not in `movements`: isolation holds by construction instead of depending on every stock query filtering it, and the source data doesn't have to fake what Pango movements require (user, number, status, existing lots).
3. **Visible apart.** `GET /historical-movements`, shown separately from Pango's movements.
4. **Validation reads only.** Rows are checked against the organization's SKUs, warehouses, locations, lots, units and movement types; nothing is created. Unknown lots are a warning and keep their code.
5. **The frontend maps the file.** The browser reads CSV/XLSX, maps the company's columns onto the v1 template and sends JSON rows in batches of up to 2,000. The API never parses spreadsheets (no ZIP/XML attack surface on the server), and the same contract serves any source.
6. **Cutover.** Per product and warehouse, history counts only before its first Pango movement there, computed on read.
7. **Forecast from day one.** The forecast gets imported demand and, as stock, the file's running balance. Without any balance in the file, demand is still sent (`NO_BALANCE` warning).

## Out of scope

The inventory import; the catalog-backed XLSX download with drop-downs; saved column mappings; listing past imports; using imported history in the dashboard.
