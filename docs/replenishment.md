# Pango — Replenishment parameters and stock alerts

US-16 (manual safety stock and reorder point) and CU-12 / CU-12a (US-43, US-44): replenishment parameters per product and warehouse, and the alerts raised when available stock reaches the reorder point. Code: `src/replenishment/`. Data model: `product_warehouses` and `alerts` in [`database.md`](database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /products/:productId/warehouses/:warehouseId/replenishment` | `stock.read` in the warehouse | Parameters, stock (`onHand`, `reserved`, `available`) and open alert of a product in a warehouse. A product not yet enabled there answers the defaults. |
| `PUT /products/:productId/warehouses/:warehouseId/replenishment` | `replenishment.manage` in the warehouse | Set the parameters by hand. |
| `GET /alerts?warehouseId=&productId=&status=&page=&pageSize=` | `alert.read` in the warehouse | Alerts, most recent first: `{ items, total, page, pageSize }`. `pageSize` ≤ 100 (default 25). |
| `GET /alerts/:id` | `alert.read` in the warehouse | One alert; `404` if you cannot read it. |

`PUT` body:

```json
{ "safetyStock": 10, "reorderPoint": 30, "minStock": null, "maxStock": 120 }
```

- Quantities are in the product's stock unit, not negative, up to 4 decimals. `minStock` and `maxStock` are optional; omitted or `null` clears them.
- `safetyStock ≤ reorderPoint` (unless the reorder point is 0), `minStock ≤ maxStock` and `reorderPoint ≤ maxStock`; otherwise `400 REPLENISHMENT_INVALID`.
- The product and the warehouse must exist and be active (`404 PRODUCT_NOT_FOUND`, `404 WAREHOUSE_NOT_FOUND`).
- The values are saved as `MANUAL` (`valueSource`), replacing calculated ones, and the product is enabled in the warehouse if it was not.

## Alert rules (CU-12a)

- Alerts are evaluated per product and warehouse, in the same transaction as every registered movement, every `PUT` of the parameters, and every stock request that reserves or releases stock. All of them lock the product's row first, so two evaluations of the same product never race.
- The reorder point is compared against **available** stock: on hand minus the reservations of `IN_PROGRESS` stock requests of that warehouse that have not expired ([`stock-requests.md`](stock-requests.md)).
- Available ≤ reorder point, and no open alert of the product-warehouse: a `BELOW_ROP` alert opens (`OPEN`). At most one is open per product-warehouse and type (`alerts_open_key`), so it is never duplicated while the condition persists.
- Available > reorder point: the open alert becomes `RESOLVED` with `resolvedAt`.
- A reorder point of `0` means none: no alert is raised, and an open one is resolved. Same for an inactive product or product-warehouse.
- The alert keeps the values it was raised with: `availableQuantity`, `reorderPoint` and `reorderPointSource` (`MANUAL` or `CALCULATED`), plus a `message`.
- `severity`: `1` at or below the reorder point, `2` at or below the safety stock, `3` nothing available.
- `suggestedQuantity`: what brings available stock up to `maxStock`, or to the reorder point when there is no max stock.

## Not done yet

- Draft replenishment movement linked to the alert (`alerts.draft_movement_id`, `settings.replenishment_movement_type_id`): needs draft movements (CU-16).
- Marking an alert as attended or dismissed by hand (`alert.resolve`, S6).
- Notifications to the configured roles (`notification_rules`, S7).
- `STOCKOUT` and `OVERSTOCK` alert types; a stockout is a `BELOW_ROP` alert with severity 3.
- Calculated reorder point from the forecast (CU-11, US-40).
