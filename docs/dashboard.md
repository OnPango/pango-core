# Pango — Dashboard

US-047: the figures of the dashboard (a single page), one endpoint per block. Code: `src/dashboard/`. Read-only; no tables of its own.

Every endpoint takes `warehouseId` (optional). Without it, each figure covers the warehouses where the user holds the read permission of its module (all of them with an assignment on every warehouse). A `warehouseId` the user cannot read answers zeros, not an error, so the endpoint never reveals whether that warehouse exists. Money is in `settings.currency` (`currency` in the body); dates follow `settings.time_zone`.

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /dashboard/summary?warehouseId=` | Any member; each block needs its own permission | Key figures with their value one month earlier, the alerts in force and the latest movements. A block the user cannot read is `null`. |
| `GET /dashboard/inventory-level?warehouseId=&days=` | `stock.read` (low stock also `alert.read`) | Products with stock and in low stock at the end of each day (`days` 7 or 30) or week (90). |
| `GET /dashboard/inventory?warehouseId=` | `stock.read` | Value per top-level category, excess, idle stock and expiring lots. |
| `GET /dashboard/alerts?warehouseId=&months=` | `alert.read` | Alerts in force per warehouse and severity, and the monthly trend (`months` 1–12, default 6, current month included). |

## Summary

Every figure has `current` and `previous`: its value at the same moment one calendar month earlier (`comparedTo`).

| Figure | Permission | Rule |
|---|---|---|
| `products` | `catalog.read` | Active products; with `warehouseId`, those active in that warehouse. A month ago: the ones created by then (archiving is not dated, so it is not undone). |
| `stockValue` | `stock.read` | Σ on hand × the product's average cost; negative balances count as 0. A month ago: today's on hand minus what entered and plus what left since, at today's average cost (past costs are not kept). |
| `lowStock` | `alert.read` | Products with an alert in force (pending or attended) in any warehouse, each counted once, and how many of them have a critical one (severity 3). A month ago: alerts raised by then and not resolved yet. Exact. |
| `pendingRequests` | `stock_request.read` | Stock requests `PENDING` or `IN_PROGRESS` of the warehouses. A month ago: requests created by then and not yet fulfilled, rejected or cancelled (from their events). Exact. |
| `lowStockItems` | `alert.read` | Up to 8 alerts in force, most severe first, with `daysOfCover`: available ÷ the daily demand of the current OK forecast (its total estimate over weeks × 7 or months × 30 days); null without a forecast. `total` counts every alert in force. |
| `recentActivity` | `movement.read` | The 8 latest movements that are not drafts: type, warehouse (on transfers, origin and destination), product of line 1 with its SKU, line count and who registered it. |

## Inventory level

One point per local day (`days` 7 or 30) or per week, Monday to Sunday (`days` 90; the current week ends today). At the end of each period:

- `inStock`: products with on hand > 0 in some warehouse that are not in low stock.
- `lowStock`: products with a `BELOW_ROP` alert in force (raised by then and not resolved yet) in some warehouse; null without `alert.read`.

Each product counts once across the warehouses (or in the one asked for).

Past on hand is today's on hand minus the net movements after the period: a destination adds (a received transfer, what it received), an origin removes (a transfer in transit already left).

## Inventory

- **Value:** the total, and per top-level category (the root of each product's category), highest first, with the product-warehouses that have stock.
- **Excess:** active product-warehouses whose available stock exceeds a limit: the max stock or, without one, 12 weeks of the current forecast's daily demand. Without either there is nothing to compare with, so the item is not listed. `value` = excess × average cost. Up to 10, highest value first; `total` and `value` cover all of them.
- **Idle:** stock on hand whose first confirmed movement in the warehouse is older than 90 days and that has not left it in 90 days (an outbound movement, or a transfer from there). Up to 10, highest value first.
- **Expiring lots:** lots with stock that expire within 30 days, expired ones included (`expired`), earliest first. Up to 10; `total` counts all.

## Alerts

- **By severity:** alerts in force per warehouse: `critical` (3), `high` (2), `medium` (1). Warehouses with more critical alerts first.
- **Monthly:** per local month, how many alerts were raised (`created_at`), marked attended (`attended_at`) and resolved (`resolved_at`). Every month of the window is present, zeros included. Putting an attended alert back to pending clears `attended_at`, so the attended count only keeps those still marked.

## Not done yet

- Demand and stock request tabs: demand per product, department and period; most requested products; departments that consume most; average attention time.
- Forecast tab: demand against the forecast, error per item, state of the last run.
- Dashboards configured per role.
- A history of alert status changes, for an exact attended count.
