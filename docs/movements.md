# Pango — Inventory movements

CU-05 (US-12, US-13, US-14, US-15): inbound, outbound and adjustment movements, and the movement history. Code: `src/movements/`. Data model: `movement_types`, `movements`, `movement_lines`, `product_warehouses` and `stock_balances` in [`database.md`](database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /movement-types?warehouseId=` | session | Movement types sorted by name. With `warehouseId`, only the ones you can register there. |
| `POST /movements` | `movement.create` in the warehouse, and a role there that allows the type | Register a movement; it is confirmed at once. |
| `GET /movements?warehouseId=&productId=&movementTypeId=&nature=&from=&to=&page=&pageSize=` | `movement.read` in the warehouse | History, most recent first: `{ items, total, page, pageSize }`. `from`/`to` are inclusive ISO 8601 instants; `pageSize` ≤ 100 (default 25). |
| `GET /movements/:id` | `movement.read` in the warehouse | One movement; `404` if you cannot read it. |

Request body:

```json
{
  "movementTypeId": 2,
  "warehouseId": 1,
  "departmentId": null,
  "documentRef": "FAC-1043",
  "notes": null,
  "lines": [
    { "productId": 1, "quantity": 12, "unitCost": 1500 },
    { "productId": 4, "quantity": 3, "lotCode": "L-2026-11", "locationId": 7 }
  ]
}
```

- `quantity` is in the product's stock unit, greater than zero, up to 4 decimals. From 1 to 200 lines.
- `locationId` is optional: an active location of the warehouse. Without it, the line uses the product's default location in the warehouse, or else the warehouse's `DEFAULT` location.
- `lotCode` is required for products that track lots and rejected for the others. Adding stock creates the lot if needed; removing stock needs an existing lot.
- `direction` (`INCREASE` / `DECREASE`) is required on `ADJUSTMENT` types and rejected on the others.
- `unitCost` applies only when stock is added. It updates the product's weighted average cost (`products.average_cost`, across every warehouse). Without it, the line takes the current average cost. Lines that remove stock always take the current average cost.

## Rules

- A movement is registered `CONFIRMED`. The movement, its lines and the stock balances change in one transaction, and a movement is never edited or deleted (RN-006). Mistakes are corrected with an adjustment.
- Stock never goes negative (RN-005, `409 INSUFFICIENT_STOCK`) unless `settings.allow_negative_stock`. The check is per balance (location and lot), not per warehouse total. Concurrent movements of the same product are serialized: the transaction locks the products' rows first, then updates the balances.
- A product is enabled in a warehouse (`product_warehouses`, with default replenishment parameters) when stock first arrives there. Removing stock from a warehouse where the product is not enabled answers `INSUFFICIENT_STOCK`.
- Lines by nature: `INBOUND` sets the destination location; `OUTBOUND` sets the origin; `ADJUSTMENT` sets the destination (increase) or the origin (decrease).
- `TRANSFER` types are rejected (`400 MOVEMENT_TYPE_NOT_SUPPORTED`).
- The movement number is `MV-` plus its id padded to 8 digits. Ids come from the table's sequence, so failed registrations leave gaps.
- The product must be active (`400 PRODUCT_INVALID`), the warehouse active (`400 WAREHOUSE_INVALID`), the department active (`400 DEPARTMENT_INVALID`).
- `source` in responses is `MANUAL`, or `STOCK_REQUEST` for movements that fulfil a stock request (CU-09, [`stock-requests.md`](stock-requests.md)); their `department` is the requesting one.
- Existing stock per warehouse (US-15) is in `GET /products/:id`; stock of a warehouse, by location and lot, and the lots of a product are in [`stock.md`](stock.md).
- Each movement re-evaluates the stock alerts of its products in the warehouse, in the same transaction (CU-12a, [`replenishment.md`](replenishment.md)).

## Not done yet

- Drafts, voiding with a reversing movement (`movement.confirm`, `movement.void`) and transfers between warehouses (CU-16, S8).
- Registering by scanning a code (CU-06).
- Backdated movements (`occurred_at` is always the time of registration).
