# Pango — Product catalog

CU-03 (US-08, US-09, US-10, US-11): the organization's products, their families (categories) and units of measure. Code: `src/catalog/`. Data model: `products`, `categories` and `units_of_measure` in [`database.md`](../architecture/database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /products?search=&categoryId=&status=&page=&pageSize=` | `catalog.read` | Paginated search sorted by name: `{ items, total, page, pageSize }`. `search` matches code or name (case-insensitive); `categoryId` includes its subcategories; `status` is `ACTIVE` (default), `INACTIVE` or `ALL`; `pageSize` ≤ 100 (default 25). No matches is an empty page, not an error. |
| `GET /products/:id` | `catalog.read` | Product with `totalOnHand`, and per enabled warehouse its on-hand stock, safety stock, reorder point and their `valueSource`; `hasMovements`. |
| `POST /products` | `product.manage` | Register a product (no stock yet). |
| `PATCH /products/:id` | `product.manage` | Edit any field; `isActive: false` retires it and resolves its open alerts (reactivating evaluates them again). |
| `GET /categories?status=` | `catalog.read` | Flat list with `parentId` and `productCount`; `status` defaults to `ALL`. |
| `GET /categories/:id` | `catalog.read` | One category. |
| `POST /categories` | `category.manage` | `{ name, parentId?, description? }`. |
| `PATCH /categories/:id` | `category.manage` | Rename, move (`parentId: null` = top level) or (de)activate. |
| `GET /units-of-measure` | `catalog.read` | Units seeded by migrations (`EA`, `KGM`, `GRM`, `LTR`, `MLT`, `MTR`, `BX`, `PK`). |

Product body:

```json
{
  "sku": "TOR-001",
  "name": "Hex bolt 1/4\"",
  "description": null,
  "categoryId": 3,
  "stockUnitId": 1,
  "lengthCm": 5,
  "widthCm": 2,
  "heightCm": 1,
  "weightKg": 0.012,
  "volumeL": 0.01,
  "tracksLots": false
}
```

Required: `sku`, `name`, `categoryId`, `stockUnitId` (the unit every quantity of the product is counted in: stock, movements, requests, reorder point; see `GET /units-of-measure`). It is not related to the physical data, which always uses cm, kg and litres. Physical data is optional and non-negative; `null` clears it on `PATCH`.

## Rules

- The code (`sku`) is unique in the organization, ignoring case (`409 SKU_TAKEN`).
- Once the product has movements, its code (`409 SKU_LOCKED`) and lot tracking (`409 TRACKS_LOTS_LOCKED`, also once it has lots) cannot change.
- Products and categories are never deleted, only deactivated.
- Every product response carries `averageCost`: the weighted average cost of one stock unit, across every warehouse. It is read-only here: inbound movements with a `unitCost` set it ([`movements.md`](movements.md)). It is 0 until the first one, and stock is valued with it (on hand × average cost).
- A product needs an active category (`400 CATEGORY_INVALID`) and an existing stock unit (`400 STOCK_UNIT_INVALID`).
- Category names are unique among siblings, ignoring case (`409 CATEGORY_NAME_TAKEN`). A category cannot move under itself or a descendant (`400 CATEGORY_CYCLE`), needs an active parent to be active (`400 CATEGORY_PARENT_INVALID`) and cannot be deactivated while it has active subcategories (`409 CATEGORY_HAS_ACTIVE_CHILDREN`). Products of an inactive category keep it.

## Not done yet

- Lead time is per product and warehouse (`product_warehouses`), not on the product; safety stock and reorder point are set in [`replenishment.md`](replenishment.md).
- Search by location (S6), barcodes/QR (CU-06) and custom attributes.
- Audit log of catalog changes (CU-15).
