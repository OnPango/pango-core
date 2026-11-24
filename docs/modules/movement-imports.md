# Pango — Movement history import

CU-17 (T-01, US-042): a company imports its movement history from before Pango so that demand and the forecast have a base from day one. Code: `src/movement-imports/`. Data model: `movement_imports`, `movement_import_rows`, `movement_import_issues` and `historical_movements` in [`database.md`](../architecture/database.md). Design and decisions: [`plans/cu-17-movement-history-import.md`](../plans/cu-17-movement-history-import.md).

**Imported history is isolated from inventory.** It never changes stock, costs, alerts, reorder points or the catalog, and inventory never reads it; validation only reads the organization's data. Current stock comes from its own import (not built yet) and, after it, only from movements made in Pango.

## Flow

The frontend reads the company's file (CSV or XLSX) in the browser, lets the user map its columns onto the [v1 template](../templates/pango-standard-kardex-movement-history-import-v1.csv), and sends the rows as JSON. The API never receives the file.

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /movement-imports` | `movement.import` | Start an import: `{ sourceNamespace, fileName? }`. |
| `POST /movement-imports/:id/rows` | `movement.import`, its uploader | Send a batch: `{ rows: [{ rowNumber, values }] }`, up to 2,000 rows (200,000 per import). A row number sent again replaces that row, so a retried batch is safe. Reopens a validated import. |
| `POST /movement-imports/:id/validate` | `movement.import`, its uploader | Validate every row; answers the import with a new `revision` and the first page of issues. |
| `POST /movement-imports/:id/confirm` | `movement.import`, its uploader | `{ revision }`: save the valid rows into the history. A repeated confirmation answers the first result. |
| `GET /movement-imports/:id?page=&pageSize=&severity=&code=` | `movement.import` | The import and a page of its issues, by row. |
| `GET /movement-imports/:id/balances?page=&pageSize=` | `movement.import` | Per product and warehouse: valid rows, the closing balance the file gives (null without a starting balance) and its demand. |
| `GET /historical-movements?productId=&warehouseId=&from=&to=&movementType=&importId=&page=&pageSize=` | `movement.read` in the warehouses read | The imported history, newest first, apart from Pango's movements. |

- `movement.import` is a warehouse permission, granted to Owner and Admin (not Operator). Rows of warehouses where you lack it are `UNKNOWN_WAREHOUSE`; movement types your roles don't allow there, `MOVEMENT_TYPE_NOT_ALLOWED`. Confirmation checks the warehouses again.
- Only the uploader sends rows, validates and confirms (`403 IMPORT_NOT_YOURS`). Others see an import if they may import in every warehouse its rows resolved to; otherwise `404 IMPORT_NOT_FOUND`.
- `sourceNamespace` names the system the external ids come from (`siigo-main`), stored lower-case. Use the same one for every import from that system: it is how lines already imported are recognized.
- Request bodies are JSON up to 1 MB (`413` above).

## Rows

`values` holds the 14 template columns, each a string or null; any other key rejects the batch (`400 ROWS_INVALID`, with the problems). The frontend converts the file's values to the template format:

| Column | Rule |
|---|---|
| `external_movement_id`, `line_number` | Required. The source key of the line (with the leg of its movement code: ordinary, transfer dispatch or receipt). Line 1–999999. |
| `business_date` | Required. `YYYY-MM-DD` (`DD/MM/YYYY` is accepted too); not after today in the organization's time zone. |
| `warehouse_code`, `sku` | Required; matched ignoring case. A numeric code that is not found hints that leading zeros may have been lost. |
| `stock_unit` | Optional: blank takes the product's unit; another one is `UNIT_MISMATCH`. |
| `movement_type` | `OPENING_BALANCE`, `PURCHASE_RECEIPT`, `SALE`, `INTERNAL_CONSUMPTION`, `ADJUSTMENT_IN`, `ADJUSTMENT_OUT`, `TRANSFER_OUT`, `TRANSFER_IN`, mapped to the base types "Opening balance", "Purchase receipt", "Sales issue", "Consumption issue", "Inventory adjustment" and "Transfer". |
| `quantity_in`, `quantity_out` | One positive quantity on the code's side (`QUANTITY_SIDE`); `OPENING_BALANCE` may be 0. A point as decimal separator, at most 4 decimals, no thousands separators. |
| `balance_after` | Optional. Checked against the movements (`BALANCE_MISMATCH`). |
| `location_code` | Blank = the warehouse's `DEFAULT` location; must exist. |
| `lot_code` | Required for lot-tracked products, refused for the others. A lot not in Pango is only a warning (`LOT_NOT_FOUND`): its code is kept, no lot is created. |
| `unit_cost`, `document_ref` | Optional. |

Across rows:

- The same source key twice in one import with the same content counts once (`DUPLICATE_ROW`); with different content both fail (`KEY_CONFLICT`). Two sales of one SKU on one day with different keys are two events.
- A line already in the history under the same namespace and key is skipped (`ALREADY_IMPORTED`); with different content it fails (`IMPORTED_DIFFERENTLY`).
- The lines of one source movement share date, warehouse, movement type and document reference (`DOCUMENT_INCONSISTENT`); ordinary lines and transfer legs cannot share an id.
- Balances run per product and warehouse in date order, then row order. They start at an `OPENING_BALANCE` or at the first reported `balance_after`; a row with errors breaks the chain until the next reported balance. A product-warehouse that never gets a balance is warned once (`NO_BALANCE`): its demand still counts, but the forecast gets no stock for that period.

Warnings never block. Confirmation saves the `VALID` rows; `INVALID` and `DUPLICATE` ones are left out.

## How the history is used

For each product and warehouse, the history only counts **before the first movement registered in Pango there** (any movement, in either warehouse of a transfer). From that day Pango's own record rules, even if the file has later dates; the cutover is computed when read, so it follows the first Pango movement whenever it happens.

- **Demand** (`GET /products/:id/demand`, [`demand.md`](demand.md)): adds the history's sales and internal consumption.
- **Forecast input** ([`forecasting.md`](forecasting.md)): adds that demand and, as stock, the daily closing of the file's running balance (the last line of each day; with several imports, the latest one's).
- **History view**: lists every line; `afterCutover` marks the ones on or after the cutover, which are shown but not counted.

## Concurrency and integrity

- Sending rows, validating and confirming lock the import row; a batch or validation never sees another half-done.
- Confirmations of one organization run one at a time (a transaction advisory lock), and recheck the revision, the user's warehouses and whether another import saved any of the lines since validation (`409 IMPORT_STALE`: validate again). A unique key on the source line makes a double save impossible.

## Not done yet

- The inventory (current stock) import, a separate module.
- A downloadable XLSX template with the organization's codes as drop-down lists.
- Listing past imports.
- Saved column mappings per organization and source system.
