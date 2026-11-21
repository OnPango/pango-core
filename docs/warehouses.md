# Pango — Warehouses

CU-04 (US-17): the organization's warehouses, where stock is kept and movements are registered. Code: `src/warehouses/`. Data model: `warehouses` and `locations` in [`database.md`](database.md).

A warehouse is a storage warehouse (`WAREHOUSE`, bodega) or a point of sale (`STORE`, tienda). Each one is created with a **default location** (code `DEFAULT`, no level), so stock can be registered before any location hierarchy is defined (RN-002).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /warehouses?search=&type=&status=` | `warehouse.read` on the warehouse | Warehouses sorted by name. `search` matches code or name; `status` is `ACTIVE` (default), `INACTIVE` or `ALL`. |
| `GET /warehouses/:id` | `warehouse.read` on the warehouse | One warehouse; `404` if you cannot read it. |
| `POST /warehouses` `{ code, name, type, address?, holdsStock? }` | `warehouse.manage` | Register a warehouse and its default location in one transaction. |
| `PATCH /warehouses/:id` | `warehouse.manage` | Edit code, name, type, address or `holdsStock`; `isActive: false` closes it. |

`warehouse.read` is a warehouse-scoped permission: a user sees the warehouses whose role assignments grant it, or all of them with an assignment on every warehouse. Holders of `warehouse.manage` on every warehouse also see all of them.

## Rules

- Code (`409 WAREHOUSE_CODE_TAKEN`) and name (`409 WAREHOUSE_NAME_TAKEN`) are unique in the organization, ignoring case.
- `holdsStock` (default `true`) is `false` for a warehouse that never holds stock: its demand must not drive replenishment, so the forecasting service declines its products (`NO_FORECAST`, `non_stock_warehouse`, [`forecasting.md`](forecasting.md)).
- Warehouses are never deleted. Closing one (`isActive: false`) requires no stock on hand (`409 WAREHOUSE_HAS_STOCK`) and no transfers in transit to or from it (`409 WAREHOUSE_HAS_TRANSFERS_IN_TRANSIT`; [`movements.md`](movements.md)), and resolves the open alerts of its products there; reopening evaluates them again ([`replenishment.md`](replenishment.md)). Inactive warehouses cannot be used in new invitations or role assignments.

## Not done yet

- Defining location levels and locations, and assigning or relocating products (CU-04 A3/A4, S6–S7). The code `DEFAULT` is reserved for the default location.
- Occupancy (CU-07).
- Audit log of warehouse changes (CU-15).
