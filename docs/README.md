# Pango Core documentation

## Implemented modules

| Guide | What it covers |
| --- | --- |
| [Authentication and access](modules/auth.md) | Sign-up, login, invitations, users and roles |
| [Product catalog](modules/catalog.md) | Products, categories and stock units |
| [Warehouses](modules/warehouses.md) | Warehouses, stores and default locations |
| [Inventory movements](modules/movements.md) | Receipts, issues, adjustments and transfers |
| [Stock](modules/stock.md) | Quantities by warehouse, location and lot |
| [Internal stock requests](modules/stock-requests.md) | Department requests, reservations and fulfillment |
| [Demand history](modules/demand.md) | Which movements count as demand and how demand is grouped |
| [Forecasting](modules/forecasting.md) | Forecast runs and integration with the Python service |
| [Replenishment](modules/replenishment.md) | Manual and calculated reorder points, stock alerts and their resolution |
| [Search](modules/search.md) | Cross-module search and access rules |
| [Dashboard](modules/dashboard.md) | Inventory indicators and alerts |

## Architecture and project

- [Database architecture](architecture/database.md) covers tenant isolation, schema conventions, migrations and provisioning.
- [Architecture workflow](project/architecture-workflow.md) defines roles, approvals and implementation review.
- [Project context](project/project-context.md) records decisions, previous work and open questions.

## Plans and templates

- [CU-11 · Calculated reorder point](plans/cu-11-reorder-point.md) records the design and validation of the implemented feature.
- [CU-17 · Kardex import](plans/cu-17-kardex-import.md) proposes the movement import workflow. The [standard Pango kardex template](templates/pango-standard-kardex-movement-history-import-v1.csv) defines the CSV format for importing inventory movement history.
- [Documentation layout](plans/documentation-layout.md) records the organization of these guides.
