# Pango — Inventory movements

CU-05 (US-12, US-13, US-14, US-15): inbound, outbound and adjustment movements, and the movement history. CU-16: transfers between warehouses. Code: `src/movements/`. Data model: `movement_types`, `movements`, `movement_lines`, `product_warehouses` and `stock_balances` in [`database.md`](../architecture/database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /movement-types?warehouseId=` | session | Movement types sorted by name. With `warehouseId`, only the ones you can register there. |
| `POST /movements` | `movement.create` in the warehouse, and a role there that allows the type | Register a movement; it is confirmed at once, except transfers in transit. |
| `POST /movements/:id/receive` | `movement.receive` in the destination | Receive a transfer in transit ([Transfers](#transfers)). |
| `GET /movements?warehouseId=&destinationWarehouseId=&status=&productId=&movementTypeId=&nature=&from=&to=&page=&pageSize=` | `movement.read` in the warehouse | History, most recent first: `{ items, total, page, pageSize }`. `warehouseId`: movements with a line there (a transfer shows in both warehouses); `destinationWarehouseId`: movements whose stock goes there. `from`/`to` are inclusive ISO 8601 instants; `pageSize` ≤ 100 (default 25). |
| `GET /movements/:id` | `movement.read` in the warehouse (on transfers, the origin or the destination) | One movement; `404` if you cannot read it. |

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
- `unitCost` applies only when stock is added. It updates the product's weighted average cost (`products.average_cost`, across every warehouse, stock in transit included). Without it, the line takes the current average cost. Lines that remove stock, and transfers, always take the current average cost.
- `destinationWarehouseId`, `receiveNow` and the lines' `destinationLocationId` are for transfers only (`400 TRANSFER_FIELDS_NOT_ALLOWED` on other types).

## Movement types

`GET /movement-types` lists them. Every organization starts with the base types (`isBase`): "Opening balance" and "Purchase receipt" (`INBOUND`), "Consumption issue" and "Sales issue" (`OUTBOUND`), "Transfer" (`TRANSFER`) and "Inventory adjustment" (`ADJUSTMENT`). Register sales from a store or warehouse with "Sales issue" and the invoice in `documentRef`. It counts as demand (`countsAsDemand`), like internal consumption ("Consumption issue"), with or without a stock request ([`database.md`](../architecture/database.md), demand history).

## Rules

- A movement is registered `CONFIRMED`. The movement, its lines and the stock balances change in one transaction, and a movement is never edited or deleted (RN-006). Mistakes are corrected with an adjustment.
- Stock never goes negative (RN-005, `409 INSUFFICIENT_STOCK`) unless `settings.allow_negative_stock`. The check is per balance (location and lot), not per warehouse total. Concurrent movements of the same product are serialized: the transaction locks the products' rows first, then updates the balances.
- A product is enabled in a warehouse (`product_warehouses`, with default replenishment parameters) when stock first arrives there. Removing stock from a warehouse where the product is not enabled answers `INSUFFICIENT_STOCK`.
- Lines by nature: `INBOUND` sets the destination location; `OUTBOUND` sets the origin; `ADJUSTMENT` sets the destination (increase) or the origin (decrease); `TRANSFER` sets both.
- The movement number is `MV-` plus its id padded to 8 digits. Ids come from the table's sequence, so failed registrations leave gaps.
- The product must be active (`400 PRODUCT_INVALID`), the warehouse active (`400 WAREHOUSE_INVALID`), the department active (`400 DEPARTMENT_INVALID`).
- `source` in responses is `MANUAL`, or `STOCK_REQUEST` for movements that fulfil a stock request (CU-09, [`stock-requests.md`](stock-requests.md)); their `department` is the requesting one.
- Existing stock per warehouse (US-15) is in `GET /products/:id`; stock of a warehouse, by location and lot, and the lots of a product are in [`stock.md`](stock.md).
- Each movement re-evaluates the stock alerts of its products in the warehouse, in the same transaction (CU-12a, [`replenishment.md`](replenishment.md)).

## Transfers

CU-16. A `TRANSFER` movement moves stock from `warehouseId` (the origin) to `destinationWarehouseId`, in one step or two:

```json
{
  "movementTypeId": 4,
  "warehouseId": 1,
  "destinationWarehouseId": 2,
  "receiveNow": false,
  "documentRef": "REM-0042",
  "lines": [
    { "productId": 1, "quantity": 12, "locationId": 7, "destinationLocationId": 15 },
    { "productId": 4, "quantity": 3, "lotCode": "L-2026-11" }
  ]
}
```

- **Two steps** (default, `receiveNow: false`): the stock leaves the origin now and the transfer is `IN_TRANSIT`. Stock in transit is on no warehouse's balance, so neither warehouse can use it. The destination receives it later with `POST /movements/:id/receive`, which adds it there and confirms the transfer (`receivedBy`, `receivedAt`). Pending ones: `GET /movements?status=IN_TRANSIT&destinationWarehouseId=2`.
- **One step** (`receiveNow: true`): the stock leaves the origin and arrives at the destination in the same transaction, and the transfer is `CONFIRMED`. It also needs `movement.receive` in the destination (`403 FORBIDDEN`), since nobody else confirms what arrived.
- The destination must be active (`400 DESTINATION_WAREHOUSE_INVALID`) and other than the origin (`400 SAME_WAREHOUSE`); it is required (`400 DESTINATION_WAREHOUSE_REQUIRED`). Transfers take no department (`400 DEPARTMENT_NOT_ALLOWED`).
- `locationId` is where the stock leaves from; `destinationLocationId`, an active location of the destination, where it arrives. Without it: the product's default location in the destination, or else the destination's `DEFAULT` location. The lot travels with the stock.
- The origin's stock is checked like an outbound line (`409 INSUFFICIENT_STOCK`). The product is enabled in the destination when the stock arrives.
- Transfers keep the average cost: their lines take the current one, and they never count as demand.
- Alerts: the origin's are re-evaluated when the stock leaves; the destination's when it arrives.
- Warehouses with transfers in transit to or from them cannot be closed (`409 WAREHOUSE_HAS_TRANSFERS_IN_TRANSIT`, [`warehouses.md`](warehouses.md)).

Receiving:

```json
{ "lines": [{ "lineNumber": 2, "receivedQuantity": 2, "locationId": 16 }] }
```

- Without a body, or without `lines`, everything arrived in full at the locations chosen when it was dispatched. `lines` lists only the lines that differ: `receivedQuantity` from 0 up to the quantity sent (`400 RECEIVED_QUANTITY_INVALID`), and optionally another active location of the destination (`400 LOCATION_INVALID`). A line that is not in the transfer, or is repeated, answers `400 RECEIPT_LINE_INVALID`.
- What arrived is stored in each line's `receivedQuantity`. A line received short records the difference as **lost in transit**: it does not return to the origin, and the movement keeps both quantities (sent and received) so the loss stays visible.
- Only transfers `IN_TRANSIT` can be received, once (`409 MOVEMENT_NOT_IN_TRANSIT`); two simultaneous receipts cannot both apply.
- `movement.receive` is checked in the destination (`403 FORBIDDEN`). The origin can read the transfer but not receive it.

## Not done yet

- Drafts, voiding with a reversing movement (`movement.confirm`, `movement.void`), and cancelling a transfer in transit (S8).
- Registering by scanning a code (CU-06).
- Backdated movements (`occurred_at` is always the time of registration).
