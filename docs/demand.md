# Pango — Demand history

CU-10 A1 / US-37 (RF-PRED-001): demand of a product per period, the input of the demand forecast (CU-10) and of the calculated reorder point (CU-11). Code: `src/demand/`.

## Endpoint

| Endpoint | Access | Purpose |
|---|---|---|
| `GET /products/:id/demand?warehouseId=&granularity=&from=&to=` | `forecast.read` in the warehouses read | Demand per period, oldest first. |

- `warehouseId` limits it to one warehouse; without `forecast.read` there it answers `404 WAREHOUSE_NOT_FOUND`. Omitted, it sums every warehouse where you hold `forecast.read` (all of them for the Owner).
- `granularity` (`WEEKLY` / `MONTHLY`) defaults to `settings.forecast_granularity`. Weeks start on Monday. Periods are computed in `settings.time_zone`, so a sale at 23:00 on Sunday in Bogotá belongs to that week.
- `from` and `to` are ISO 8601 dates, snapped to their periods (`from` to the start of its period; `to` includes its whole period). `from` defaults to the period of the product's first demand, `to` to today. `from` after `to` answers `400 RANGE_INVALID`, and more than 520 periods `400 RANGE_TOO_LARGE`.

Response:

```json
{
  "product": { "id": 1, "sku": "TOR-001", "name": "Hex bolt", "unit": "EA" },
  "warehouse": { "id": 1, "name": "North" },
  "granularity": "WEEKLY",
  "timeZone": "America/Bogota",
  "from": "2026-10-05",
  "to": "2026-11-08",
  "total": 20,
  "periods": [
    { "periodStart": "2026-10-05", "quantity": 10 },
    { "periodStart": "2026-10-12", "quantity": 0 }
  ],
  "notice": null
}
```

- Every period of the range is listed; periods without demand are `0`, never a gap.
- A product without any demand answers `periods: []`, `from`/`to` null and `notice: "NO_HISTORY"`, not an error. With history but none in the range, the periods are all `0` and `notice` is null.
- `warehouse` is null when the series sums several warehouses.

## What counts as demand

`CONFIRMED` outbound movements whose type has `counts_as_demand`, in the product's stock unit, by the warehouse of the line's origin location:

- Sales ("Sales issue"), registered with `POST /movements`.
- Internal consumption ("Consumption issue"), registered by hand with `POST /movements` or by fulfilling a stock request (US-013). The second also carries the requesting department.

Inbound movements, adjustments and transfers never count. The series is computed on each request from `movements` and `movement_lines` (no stored table).

## Not done yet

- The history imported from the organization's previous system (T-01, CU-17): there is no table for it yet.
- The calculated reorder point (CU-11). The forecast (CU-10) sends the same demand, per day ([`forecasting.md`](forecasting.md)).
