# Pango — Departments and internal stock requests

CU-08 (US-28, US-29) and CU-09 (US-30, US-31, US-32): a department (área) requests products from a warehouse, and the warehouse staff attend the request. Code: `src/departments/`, `src/stock-requests/`. Data model: `departments`, `stock_requests`, `stock_request_lines` and `stock_request_events` in [`database.md`](../architecture/database.md).

## Departments

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /departments?status=` | session | Sorted by name; `status` = `ACTIVE` (default), `INACTIVE` or `ALL`. |
| `GET /departments/:id` | session | One department, with `userCount`. |
| `POST /departments` | `department.manage` | `{ name, costCenter? }`. The name is unique case-insensitively (`409 DEPARTMENT_NAME_TAKEN`). |
| `PATCH /departments/:id` | `department.manage` | Rename it, change its cost center or deactivate it (`isActive`). |

A user's department is set with `PATCH /users/:id` (`departmentId`). Every user who requests stock must belong to an active department (RN-015).

## Stock requests

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /stock-requests` | `stock_request.create` in the warehouse | Create a request; it starts `PENDING` and does not change stock. |
| `GET /stock-requests?warehouseId=&departmentId=&productId=&status=&from=&to=&page=&pageSize=` | see below | History, most recent first: `{ items, total, page, pageSize }`. `from`/`to` filter by creation (inclusive ISO 8601 instants); `pageSize` ≤ 100 (default 25). |
| `GET /stock-requests/:id` | see below | One request with its lines, status history and fulfilling movement; `404` if you cannot read it. |
| `POST /stock-requests/:id/start` | `stock_request.approve` in the warehouse | `PENDING` → `IN_PROGRESS`; reserves the stock. |
| `POST /stock-requests/:id/fulfil` | `stock_request.approve` in the warehouse | `IN_PROGRESS` → `FULFILLED`; registers the outbound movement. |
| `POST /stock-requests/:id/reject` | `stock_request.approve` in the warehouse | `PENDING` / `IN_PROGRESS` → `REJECTED`, with `{ reason }`. |
| `POST /stock-requests/:id/cancel` | the requester | `PENDING` → `CANCELLED`. Anyone else: `403 NOT_REQUESTER`. |

Reading: you see the requests of the warehouses where you hold `stock_request.read`, and every request of your own department.

Create body:

```json
{
  "warehouseId": 1,
  "type": "INTERNAL_CONSUMPTION",
  "priority": 2,
  "requiredDate": "2026-11-15",
  "notes": null,
  "lines": [{ "productId": 1, "quantity": 12 }]
}
```

- The requesting department is the user's (`400 DEPARTMENT_REQUIRED` without an active one); the warehouse is the attending side and must be active (`400 WAREHOUSE_INVALID`).
- `type` defaults to `INTERNAL_CONSUMPTION`, the only one supported for now (`400 STOCK_REQUEST_TYPE_NOT_SUPPORTED`). `INTERNAL_REPLENISHMENT`, `RETURN` and `INCIDENT` exist in the data model for later.
- From 1 to 200 lines, each product active (`400 PRODUCT_INVALID`) and only once (`400 PRODUCT_DUPLICATED`); quantities in the product's stock unit, greater than zero, up to 4 decimals. `priority` 1 (highest) to 3, default 2.
- The number is `SR-` plus the id padded to 8 digits.

Fulfil body (optional): `{ "lines": [{ "lineNumber": 1, "locationId": 7, "lotCode": "L-2026-11" }], "notes": null }`. Each listed line says where to take the stock from; lines not listed use the product's default location in the warehouse, or else the warehouse's `DEFAULT` location. `lotCode` is required for products that track lots. Unknown line numbers answer `400 LINE_INVALID`.

## Rules

- Status cycle (RF-REQ-003, RN-016): `PENDING → IN_PROGRESS → FULFILLED`, or `REJECTED` (from `PENDING` or `IN_PROGRESS`, reason required), or `CANCELLED` (from `PENDING`, by the requester). Any other change answers `409 STOCK_REQUEST_STATUS_INVALID`. Every change is recorded in `events` with the user and date. There is no partial attention.
- Starting the attention reserves the full requested quantity of every line (`reserved_quantity`). It fails with `409 INSUFFICIENT_STOCK` if the warehouse's available stock (on hand − reservations of other requests in attention) is not enough, unless `settings.allow_negative_stock`. Reservations lower the available stock, so the stock alerts are re-evaluated ([`replenishment.md`](replenishment.md)).
- Fulfilling releases the reservation and registers, in the same transaction, a confirmed outbound movement of type `settings.stock_request_movement_type_id` ("Consumption issue", which counts as demand) with `stock_request_id`, the request's department and `documentRef` = the request number. Its `source` in `GET /movements` is `STOCK_REQUEST`, so the demand history has product, department, date and quantity (RF-REQ-004). The movement follows the movement rules ([`movements.md`](movements.md)): if a location or lot does not have enough stock, nothing changes (`409 INSUFFICIENT_STOCK`). A fulfilled request cannot be fulfilled again, so stock is never discounted twice.
- Rejecting a request in attention releases its reservation.
- Transitions lock the request's row, and then the products' rows (the same lock movements take), so concurrent changes are serialized.
- Fulfilling does not check the role's allowed movement types (`role_movement_types`); `stock_request.approve` is enough.

## Not done yet

- Request types other than internal consumption (RF-REQ-007).
- Reservation expiry (`reservation_expires_at` is never set; `settings.reservation_expiry_days` is unused).
- Notifying the requester of status changes.
