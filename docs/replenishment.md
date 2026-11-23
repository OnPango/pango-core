# Pango — Replenishment parameters and stock alerts

US-16 (manual safety stock and reorder point), CU-11 (US-40, calculated from the forecast) and CU-12 / CU-12a (US-43, US-44): replenishment parameters per product and warehouse, and the alerts raised when available stock reaches the reorder point. Code: `src/replenishment/`. Data model: `product_warehouses` and `alerts` in [`database.md`](database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /products/:productId/warehouses/:warehouseId/replenishment` | `stock.read` in the warehouse | Parameters, stock (`onHand`, `reserved`, `available`) and open alert of a product in a warehouse. A product not yet enabled there answers the defaults. |
| `PUT /products/:productId/warehouses/:warehouseId/replenishment` | `replenishment.manage` in the warehouse | Set the manual parameters, the method and the lead time. |
| `GET /alerts?warehouseId=&productId=&status=&sort=&page=&pageSize=` | `alert.read` in the warehouse | Alerts: `{ items, total, page, pageSize }`. `sort`: `CREATED` (default, most recently raised first), `UPDATED` (most recently changed first, so an old alert that just got worse comes up) or `SEVERITY` (most severe first, then most recently changed). `pageSize` ≤ 100 (default 25). |
| `GET /alerts/:id` | `alert.read` in the warehouse | One alert; `404` if you cannot read it. |
| `PATCH /alerts/:id` `{ status: ATTENDED \| OPEN }` | `alert.resolve` in the warehouse | US-045: mark an alert in force as attended (records `attendedAt` and `attendedBy`) or as pending again. Same status: nothing changes. `404` if you cannot read it, `409 ALERT_CLOSED` once resolved. |

`PUT` body:

```json
{
  "safetyStock": 10, "reorderPoint": 30, "minStock": null, "maxStock": 120,
  "replenishmentMethod": "FORECAST_ROP", "leadTimeDays": 7
}
```

- Quantities are in the product's stock unit, not negative, up to 4 decimals. `minStock` and `maxStock` are optional; omitted or `null` clears them.
- `safetyStock ≤ reorderPoint` (unless the reorder point is 0), `minStock ≤ maxStock` and `reorderPoint ≤ maxStock`; otherwise `400 REPLENISHMENT_INVALID`.
- The product and the warehouse must exist and be active (`404 PRODUCT_NOT_FOUND`, `404 WAREHOUSE_NOT_FOUND`).
- `safetyStock` and `reorderPoint` are saved as the manual values (`manualSafetyStock`, `manualReorderPoint`); which values are in force follows from the method (below). The product is enabled in the warehouse if it was not.
- `replenishmentMethod`: `FIXED_ROP` or `FORECAST_ROP`; `leadTimeDays`: 1 to 365. Omitted = keep the current ones (`FIXED_ROP` and 7 for a product not yet enabled).
- The response adds `replenishmentMethod`, `leadTimeDays`, the manual values, `valueSource`, `baseForecastId`, `calculatedAt` and `calculationIssue`.

## Calculated reorder point (CU-11)

`safetyStock` and `reorderPoint` are the values **in force**, the ones alerts compare against. Where they come from depends on `replenishmentMethod`:

- `FIXED_ROP` (default): the manual values, `valueSource = MANUAL`.
- `FORECAST_ROP`: computed from the product-warehouse's current `OK` forecast ([`forecasting.md`](forecasting.md)) and its lead time, `valueSource = CALCULATED`, with `baseForecastId` (the forecast used) and `calculatedAt`. The manual values stay as the fallback.

Upper-band method: the forecast's calibrated total interval of the horizon (`total.estimate`, `total.upper`, H = horizon weeks × 7 days) is scaled to the lead time L in days. Expected demand scales linearly; the band, like the spread of a sum of independent periods, with the square root:

```text
expected      = estimate × L / H
safety stock  = (upper − estimate) × √(L / H)
reorder point = expected + safety stock
```

Both are rounded up to 4 decimals. The service level is the one the forecasting service calibrated its interval to; `product_warehouses.service_level` is not used yet. Example: 4 weeks with total 91 [68.8, 107.5] and L = 7 → expected 22.75, safety stock 8.25, reorder point 31.

When it cannot be computed, the manual values are in force (`valueSource = MANUAL`) and `calculationIssue` says why: `NO_FORECAST` (no current `OK` forecast: never forecast, declined by the service, or every run failed for it), `NO_INTERVAL` (the forecast has no horizon interval) or `NO_LEAD_TIME`.

It is recalculated, and the alert re-evaluated, after every forecast run (in its transaction, for the product-warehouses of the run) and on every `PUT`. A calculated reorder point may exceed `maxStock`; then the alert suggests ordering up to the reorder point.

## Alert rules (CU-12a)

- Alerts are evaluated per product and warehouse, in the same transaction as every registered movement, every `PUT` of the parameters, every stock request that reserves or releases stock, and every change of a product's or warehouse's `isActive` (archiving, reactivating, closing, reopening). All of them lock the product's row first, so two evaluations of the same product never race.
- The reorder point is compared against **available** stock: on hand minus the reservations of `IN_PROGRESS` stock requests of that warehouse that have not expired ([`stock-requests.md`](stock-requests.md)).
- Available ≤ reorder point, and no open alert of the product-warehouse: a `BELOW_ROP` alert opens (`OPEN`). At most one is open per product-warehouse and type (`alerts_open_key`), so it is never duplicated while the condition persists.
- Available ≤ reorder point, with an alert already open: the open alert is refreshed with the current `severity`, `availableQuantity`, `suggestedQuantity`, `reorderPoint`, `reorderPointSource` and `message` (e.g. it goes from `1` to `3` when the stock reaches 0, or back down when stock comes in but stays below the reorder point). `createdAt` keeps the date it was raised; `updatedAt` records when its values last changed. Nothing is written if nothing changed.
- Available > reorder point: the alert in force becomes `RESOLVED` with `resolvedAt`.
- An alert in force is `OPEN` (pending) or `ATTENDED` (someone took charge, US-045). Attended alerts follow every rule above: they are refreshed, never duplicated and resolved by the evaluation, keeping `attendedAt` and `attendedBy`. When the evaluation raises the severity of an attended alert, it goes back to `OPEN` and loses who attended it: what was done is no longer enough. Marking by hand takes the product's row lock too.
- A reorder point of `0` means none: no alert is raised, and an open one is resolved. Same for an inactive product, product-warehouse or warehouse.
- `resolution` says why it was resolved: `STOCK_RECOVERED` (available rose above the reorder point the alert last showed), `REORDER_POINT_CHANGED` (the point was lowered below the available stock), `NO_REORDER_POINT` (set to 0) or `INACTIVE` (the product, product-warehouse or warehouse was deactivated). Null while open, and for alerts resolved before the `alert_resolution` migration. Since a resolved alert keeps the values of its last evaluation, `REORDER_POINT_CHANGED` is what explains one that still reads below its reorder point.
- An open alert shows the values of the last evaluation; a resolved one keeps those it had when it was resolved: `availableQuantity`, `reorderPoint` and `reorderPointSource` (`MANUAL` or `CALCULATED`), plus a `message`.
- `severity`: `1` at or below the reorder point, `2` at or below the safety stock, `3` nothing available.
- `suggestedQuantity`: what brings available stock up to `maxStock`, or to the reorder point when there is no max stock.

## Not done yet

- Draft replenishment movement linked to the alert (`alerts.draft_movement_id`, `settings.replenishment_movement_type_id`): needs draft movements (CU-16).
- Dismissing an alert by hand with a reason (`DISMISSED`, `alert.resolve`).
- Notifications to the configured roles (`notification_rules`, S7).
- `STOCKOUT` and `OVERSTOCK` alert types; a stockout is a `BELOW_ROP` alert with severity 3.
- Using `service_level` in the calculation (needs the service's interval level or error spread).
- A form of the method for `MIN_MAX`; it behaves as `FIXED_ROP`.
