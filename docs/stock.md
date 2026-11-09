# Pango — Stock queries and lots

Stock per warehouse (the inventory page "by warehouse"), stock of a product by location and lot, and the lots of a product. Code: `src/stock/`. Data model: `product_warehouses`, `stock_balances` and `lots` in [`database.md`](database.md). Stock per product across warehouses (US-15) stays in `GET /products/:id`.

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /stock?warehouseId=&search=&categoryId=&includeZero=&page=&pageSize=` | `stock.read` in the warehouse | Products with stock in a warehouse, sorted by name: `{ items, total, page, pageSize }`. |
| `GET /products/:id/stock?warehouseId=` | `stock.read` in the warehouse | Totals and non-zero balances of a product by location and lot. |
| `GET /products/:id/lots?warehouseId=` | `stock.read` in the warehouse | Lots of a product with stock in the warehouse, earliest expiry first. |
| `PATCH /products/:id/lots/:lotId` | `product.manage` | Set a lot's manufacture and expiry dates. |

Without `stock.read` in the warehouse (or if it does not exist) the read endpoints answer `404 WAREHOUSE_NOT_FOUND`, as `GET /warehouses/:id`. An unknown product answers `404 PRODUCT_NOT_FOUND`.

## `GET /stock`

- `warehouseId` is required. `search` matches the product SKU or name, case-insensitively (`%` and `_` are literal). `categoryId` includes the subcategories. `pageSize` ≤ 100 (default 25).
- Lists the products with on hand ≠ 0 in the warehouse, archived ones included (archiving a product does not hide its stock). With `includeZero=true`, it also lists the active products enabled there (`product_warehouses`) with no stock.
- Each item has the product (`id`, `sku`, `name`, `stockUnit`, `category`, `tracksLots`, `isActive`), `onHand`, `reserved` (stock requests in attention) and `available` (on hand − reserved, what the reorder point is compared against). `onHand` equals the warehouse's `onHand` in `GET /products/:id`.
- No matches, or a page past the end, answer an empty `items` with the real `total`.

## `GET /products/:id/stock`

`{ product, warehouse, onHand, reserved, available, balances }`. `balances` are the non-zero `stock_balances` rows: `{ location: { id, code }, lot: { id, code, manufactureDate, expiryDate } | null, onHand }`, sorted by location code and then earliest expiry. A product not enabled in the warehouse answers zeros and no balances. Use it to pick the location (and lot) of an outbound line or of a stock request fulfilment.

## Lots

- A lot belongs to one product (`code` unique per product) and exists only for products with `tracks_lots`. Movements create it when stock first arrives with a new `lotCode` ([`movements.md`](movements.md)).
- `GET /products/:id/lots` answers `[{ id, code, manufactureDate, expiryDate, onHand, locations: [{ location, onHand }] }]`, only lots with stock in the warehouse, sorted by earliest expiry (lots without one last) and then code. Products that do not track lots answer `[]`. Outbound forms offer this list instead of typing the code.
- `PATCH /products/:id/lots/:lotId` body: `{ "manufactureDate": "2026-10-01", "expiryDate": "2027-04-30" }` (ISO 8601 dates; omitted keeps the value, `null` clears it). The expiry cannot be before the manufacture date (`400 LOT_DATES_INVALID`). A lot of another product answers `404 LOT_NOT_FOUND`.

## Not done yet

- Setting the lot dates when the lot is created by a movement.
- Picking the lot automatically (first expired, first out) on outbound movements.
- Expiry alerts.
