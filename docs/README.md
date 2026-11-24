# Pango Core documentation

## Implemented modules

| Guide | What it covers |
| --- | --- |
| [Authentication and access](modules/auth.md) | Sign-up, login, invitations, users and roles |
| [Product catalog](modules/catalog.md) | Products, categories and stock units |
| [Warehouses](modules/warehouses.md) | Warehouses, stores and default locations |
| [Inventory movements](modules/movements.md) | Receipts, issues, adjustments and transfers |
| [Movement history import](modules/movement-imports.md) | History before Pango, isolated from inventory, for demand and the forecast (CU-17) |
| [Stock](modules/stock.md) | Quantities by warehouse, location and lot |
| [Internal stock requests](modules/stock-requests.md) | Department requests, reservations and fulfillment |
| [Demand history](modules/demand.md) | Which movements count as demand and how demand is grouped |
| [Forecasting](modules/forecasting.md) | Forecast runs and integration with the Python service |
| [Replenishment](modules/replenishment.md) | Manual and calculated reorder points, stock alerts and their resolution |
| [Search](modules/search.md) | Cross-module search and access rules |
| [Dashboard](modules/dashboard.md) | Inventory indicators and alerts |

## Architecture and project

- [Database architecture](architecture/database.md) covers tenant isolation, schema conventions, migrations and provisioning.
- [Project context](project/project-context.md) records decisions, previous work and open questions.

## Plans and templates

- [CU-17 · Movement history import](plans/cu-17-movement-history-import.md): design and decisions.

- [Standard Pango kardex template](templates/pango-standard-kardex-movement-history-import-v1.csv): the CSV format for importing movement history ([guide](modules/movement-imports.md)).
