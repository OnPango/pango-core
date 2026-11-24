# CU-17 · Importing the Pango kardex

**Status** · Proposed. The user confirmed that the initial kardex belongs in the organization's movement history and must include original dates, product identity and movement type. The posting, overlap and reconciliation policies below await approval.

## Architecture decision

Publish one canonical history in the tenant's `movements` and `movement_lines`. Preserve native movement IDs, original source dates and existing entries. Use separate import records for staging, source identities, user decisions and audit. A separate demand-only history would fail the requested movement-history use case. RF-PRED-007 and US-042 cover historical demand. Posting opening inventory and subsequent operational entries extends that scope. T-01 requires source reconciliation, rejection reasons, unmapped products and duplicate protection.

Classify each source event by the inventory position it represents. Upload time and product creation time cannot establish whether its quantity is already in stock.

| Situation | Proposed posting rule |
| --- | --- |
| Initial load, catalog already present, no relevant inventory activity | Reconstruct stock and weighted cost chronologically from a known initial position. Post the original movements and their lines once. Reconcile by product, warehouse, location and lot. A closing quantity from the file is a check total. |
| Older history, covered by an existing Pango opening | Require an identified opening and reconcile the historical close against it. Record original movements with an explicit historical posting classification. They contribute to historical demand and daily stock through the cutoff. The existing opening anchors the operational period. Current stock and valuation receive zero incremental effect. |
| File overlaps a period with Pango operations | Resolve line identity first. Link matched native lines, skip known repeats and hold conflicting or uncertain lines. Post a genuinely missing event to operational stock only after reviewing its effect on subsequent balances, cost and any later physical count or adjustment. |
| Missing opening, unexplained difference or unreliable ordering | Show the discrepancy and affected scope. Keep the batch staged until the administrator supplies evidence or chooses an explicit, auditable reconciliation. A physical difference can be recorded separately as an authorized inventory adjustment. |

Define the cutoff as the first operational day for the coverage being reconciled. A split within one day requires reliable source ordering or manual reconciliation. Check both ends of a transfer and all warehouses sharing a product's average cost before choosing a posting treatment. A product's existence in the catalog alone is compatible with an initial load.

**Ledger and reporting.** Persist the posting treatment and the opening it is reconciled against. Historical entries are visible in movement history. For a reconciled boundary, use historical changes before the opening and start the operational running balance at the opening quantity. This prevents a cumulative sum from counting the opening twice. Apply the same boundary to stock reconstruction, forecasts and reconciliation reports; count each eligible sale or internal consumption once in demand. For transfers, use dispatch date and dispatched quantity at origin, receipt date and actual quantity at destination. Preserve existing forecast runs; subsequent requested runs use the reconciled history. Evaluate current alerts against the resulting available stock once when the operational import commits. See [movements](movements.md), [demand](demand.md) and [forecasting](forecasting.md).

## Template v1

Companies map their source records to the [CSV example](kardex-v1.csv). CSV and XLSX use the same columns. One row represents a source product line in one warehouse on its actual local business date. Preserve codes as text and quantities in the product's stock unit at up to four decimal places.

| Columns | Contract |
| --- | --- |
| `external_movement_id`, `line_number` | Stable event key from the source and its stable line number. The source namespace includes any branch, register, series or document class needed to make document IDs unique. Persist the assigned IDs across exports when the source is a spreadsheet. |
| `business_date`, `warehouse_code`, `sku`, `stock_unit` | Original local date (YYYY-MM-DD), warehouse code, product SKU and expected unit. Record the upload timestamp separately. Resolve master data inside the tenant and report unknown or ambiguous codes. |
| `movement_type`, `quantity_in`, `quantity_out` | Opening balance, purchase receipt, sale, internal consumption, adjustment in/out or transfer in/out. Use one positive quantity on the applicable side. A documented zero opening can establish the baseline without writing a zero-quantity movement line. |
| `document_ref`, `balance_after` | Human-readable reference and optional reconciliation total per product and warehouse. Use the original event sequence for intraday balances and costs. |
| `location_code`, `lot_code`, `unit_cost` | Resolve the location under the warehouse, require a lot for lot-tracked products, and establish a defensible opening or inbound cost in tenant currency when reconstructing valuation. Preview any use of existing defaults. Report missing detail that prevents posting. |

Transfers use two dated legs of one transfer with a stable source identity. For example, five units dispatched from MAIN on August 5 and received at NORTH on August 7 appear on their respective dates, contribute zero demand, and link to one Pango transfer line. Keep dispatch and receipt distinguishable across uploads.

### Proposed workbook download

Generate the XLSX for the authenticated organization when the user downloads it. The first worksheet, `Kardex`, contains the import columns. A `Catalogs` worksheet holds the eligible codes, names and units at download time. Use cell ranges from this sheet for Excel list validation. The CSV keeps the same data columns for bulk exports.

Offer SKU codes from the organization's catalog and warehouse codes within the user's import permissions. After warehouse selection, offer its locations and the standardized movement codes mapped to movement types the user may register there. For example, `TRANSFER_OUT` and `TRANSFER_IN` both map to the transfer type. Fill the stock unit from the selected SKU. Keep codes as text, including leading zeros.

Preview and confirmation resolve submitted codes against the current tenant catalog and permissions. Report a stale or unrecognized value with its row, field and reason. Check workbook generation with a catalog larger than one API page, two users with different warehouse access, and an upload after a reference or permission changes.

## Duplicate detection and confirmation

1. Enforce a database unique key on tenant, stable source namespace, external movement ID, source line number and transfer leg where applicable (use a concrete value for ordinary lines). Map this identity to the canonical Pango movement and line. Keep the file, row number and upload batch as audit metadata. A file hash helps recognize identical uploads; the source key also works across exports and files sorted differently.
2. Same key and equivalent normalized business fields means skip. Same key with a different SKU, date, warehouse, quantity, lot or cost means conflict. Include other material fields such as movement type and location in the comparison. Audit any subsequent correction through the movement correction process.
3. A native entry or a second source may lack the original key. Show candidate Pango movement and line IDs using the document reference, warehouse, SKU, lot, date, type and quantities. Allow an authorized user to link a matching line with zero stock impact or confirm a distinct event. Preserve the link for future reimports. Identical quantities for the same SKU on the same day can represent two genuine sales. In overlapping coverage require explicit disposition even if the search has no candidates.
4. Preview counts and reasons for new, historical, matched, skipped, ambiguous, conflicting and invalid lines. Show current and projected quantities and valuation, and differences from opening or count records. Confirm only a reconciled batch. Recheck permissions, source keys and balances under the normal product locks and commit movements, mappings, stock changes and audit together. A retry or competing confirmation must have one effect. Re-preview when live inputs have changed.

## Implementation task for Claude

**Status** · Proposed.

**Objective.** Import a standardized kardex into movement history with explainable, nonduplicated stock and demand effects.

**Scope.** CSV/XLSX mapping, preview and confirmation, tenant-scoped source and posting records, canonical movement and transfer posting, and boundary-aware stock and demand reads. Update Swagger and the movement, database, demand and forecasting guides.

**Technical constraints.** Preserve historical and recording dates, tenant and warehouse permissions, native movement identities, lot/location rules and product-wide weighted costs. Support stable retries and concurrent writes. The current movement endpoint uses registration time; import requires explicit historical posting. Gate retroactive operational posting on a validated replay of affected downstream stock and cost; surface unsupported cases for reconciliation.

**Dependencies.** Approval of posting and reconciliation policy, representative anonymized source exports, catalog mappings, original ordering where valuation depends on it, and documented opening balances for live cutovers.

**Acceptance criteria.** The template yields 105 on hand and 15 demand on a clean initial load. For an existing opening of 105 followed by a Pango sale of 5, importing the same pre-opening history leaves 100 on hand and gives 20 demand across both periods. A different line for a second genuine sale of the same SKU posts once. Matching a native sale changes neither stock nor demand. Changed source content, unexplained differences and ambiguous matches block confirmation; repeated files and concurrent confirmations cannot double post.

**Validation requirements.** Compare equivalent CSV/XLSX fixtures. Reconcile ledger balances, daily forecast inputs and demand by product, warehouse and period. Include transfers spanning dates, lots, location balances, weighted costs, later physical counts, cutover boundaries, repeated and reordered files, native rows with and without source keys, rollback and concurrent operational writes. Report actual commands and results.

**Out of scope.** Vendor-specific converters, automatic catalog creation, silent edits of posted movements, and automatic forecast runs.
