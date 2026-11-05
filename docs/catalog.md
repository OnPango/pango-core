# Pango — Product catalog

CU-03 (US-08, US-09, US-10, US-11): the organization's products, their families (categories) and units of measure. Code: `src/catalog/`. Data model: `products`, `categories` and `units_of_measure` in [`database.md`](database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /products?search=&categoryId=&status=&page=&pageSize=` | `catalog.read` | Paginated search sorted by name: `{ items, total, page, pageSize }`. `search` matches code or name (case-insensitive); `categoryId` includes its subcategories; `status` is `ACTIVE` (default), `INACTIVE` or `ALL`; `pageSize` ≤ 100 (default 25). No matches is an empty page, not an error. |
| `GET /products/:id` | `catalog.read` | Product with `totalOnHand`, and per enabled warehouse its on-hand stock, safety stock, reorder point and their `valueSource`; `hasMovements`. |
| `POST /products` | `product.manage` | Register a product (no stock yet). |
| `PATCH /products/:id` | `product.manage` | Edit any field; `isActive: false` retires it. |
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
  "unitOfMeasureId": 1,
  "lengthCm": 5,
  "widthCm": 2,
  "heightCm": 1,
  "weightKg": 0.012,
  "volumeL": 0.01,
  "tracksLots": false
}
```

Required: `sku`, `name`, `categoryId`, `unitOfMeasureId`. Physical data is optional and non-negative; `null` clears it on `PATCH`.

## Rules

- The code (`sku`) is unique in the organization, ignoring case (`409 SKU_TAKEN`).
- Once the product has movements, its code (`409 SKU_LOCKED`) and lot tracking (`409 TRACKS_LOTS_LOCKED`, also once it has lots) cannot change.
- Products and categories are never deleted, only deactivated.
- A product needs an active category (`400 CATEGORY_INVALID`) and an existing unit (`400 UNIT_OF_MEASURE_INVALID`).
- Category names are unique among siblings, ignoring case (`409 CATEGORY_NAME_TAKEN`). A category cannot move under itself or a descendant (`400 CATEGORY_CYCLE`), needs an active parent to be active (`400 CATEGORY_PARENT_INVALID`) and cannot be deactivated while it has active subcategories (`409 CATEGORY_HAS_ACTIVE_CHILDREN`). Products of an inactive category keep it.

## Not done yet

- Lead time and replenishment parameters are per product and warehouse (`product_warehouses`), set with CU-11 / US-16, not on the product.
- Search by location (S6), barcodes/QR (CU-06) and custom attributes.
- Audit log of catalog changes (CU-15).
