# Pango — Demand forecasting

CU-10 (US-38, US-39): forecast runs through the external forecasting service (Python / FastAPI), following its contract v1.2 (`POST /v1/forecasts`; the contract lives in the `pango-prediction` repository, `docs/contract-v1.md`). Core reads the database, applies the demand rules and stores the results; the service builds the weekly series, profiles them and forecasts. Code: `src/forecasting/`. Data model: `forecast_runs`, `forecasts` and `forecast_periods` in [`database.md`](database.md).

## Endpoints

| Endpoint | Access | Purpose |
|---|---|---|
| `POST /forecast-runs` `{ warehouseId?, productId? }` | `forecast.run` | Start a run; answers `202` with the run `RUNNING`. |
| `GET /forecast-runs?page=&pageSize=` | `forecast.read` | Runs, most recent first. |
| `GET /forecast-runs/:id` | `forecast.read` | One run: status, per-series counts, policy and service versions. |
| `GET /products/:id/forecasts?warehouseId=&page=&pageSize=` | `forecast.read` in the warehouses read | Forecasts of a product, newest first; a warehouse where you lack the permission answers `404 WAREHOUSE_NOT_FOUND`. |

## A run

1. `POST /forecast-runs` checks the service is configured (`503 FORECAST_SERVICE_NOT_CONFIGURED`) and that no other run is `RUNNING` (`409 FORECAST_RUN_IN_PROGRESS`; a run `RUNNING` for over an hour is marked `FAILED` as interrupted).
2. It picks the active product-warehouses of active products and warehouses (optionally one warehouse or product) and builds one series per product-warehouse (`series_id` = `product_warehouses.id`). Series without demand and without stock changes are left out; if none is left, `400 NOTHING_TO_FORECAST`.
3. It creates the run (`RUNNING`, `WEEKLY`, horizon `FORECAST_HORIZON`, `history_end`) and answers `202`. The rest happens in the background: poll `GET /forecast-runs/:id`.
4. The series go to the service in batches of `FORECAST_MAX_SERIES`, each with its own `request_id` (`<run request id>-<batch>`). A batch that fails to connect, times out or gets a 5xx is retried once with the same `request_id` and payload; a 4xx is not retried.
5. When every batch answered, all the results are stored in one transaction and the run becomes `COMPLETED`, or `PARTIAL` when some series failed (`seriesError`). If any call fails (unreachable, timeout, non-2xx), the run becomes `FAILED` with `errorMessage` and **nothing is stored** (CU-10 E2); start another run to retry.

## What Core sends

- `history_end`: the last complete Sunday in `settings.time_zone` (on Monday, the day before). Nothing after it is sent.
- `demand`: per local day, the gross demand of the day (the shared demand rule of [`demand.md`](demand.md): sales and internal consumption, with or without a stock request). Only days with demand; quantities are never negative.
- `stock`: per local day, the closing stock of the days it changed, rebuilt from every confirmed (and voided) movement of the product in the warehouse, so it starts with the first stock that arrived. Negative stock (allowed by `settings.allow_negative_stock`) is sent as 0, a stockout.
- `warehouses`: every warehouse of the run with `holds_stock` (`warehouses.holds_stock`, set by the administrator). The service declines the series of a warehouse that holds no stock.
- `metadata` per series, for traceability: `sku`, `category`, `stock_unit`, `warehouse_code`, `warehouse_type`, `lead_time_days`.
- `contract_version` is `1.2`; `frequency` is always `WEEKLY` (the only one the service supports), whatever `settings.forecast_granularity` says. No `calendar` is sent yet, and no series is `history_only`.

## What Core stores

One `forecasts` row per series sent, never overwriting earlier ones (RF-PRED-004). An `ERROR` keeps the previous current forecast:

- `OK`: model name and version, demand class, the calibrated total interval of the horizon, one `forecast_periods` row per week (estimate, lower, upper), the profile, warnings and business days per week. It becomes `isCurrent` for its product-warehouse, and the previous current one stops being so.
- `NO_FORECAST`: the service declined the series on purpose, with its `reason` (`inactive`, `non_stock_warehouse`, `history_only`, `sold_to_order`, `no_active_warehouse`). It is a decision, not a failure: it is counted in `seriesNoForecast`, not retried, and the previous current forecast stops being current.
- `ERROR`: the service's code and message (e.g. `INSUFFICIENT_HISTORY`), and the profile when the service got that far. A missing result is stored as `MISSING_RESULT`, and an `ok` result with malformed periods (not `0 ≤ lower ≤ estimate ≤ upper`) as `INVALID_RESPONSE`, so one bad series never fails the run.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FORECAST_SERVICE_URL` | — | Base URL of the service. |
| `FORECAST_SERVICE_TOKEN` | — | Service credential, sent as `Authorization: Bearer`. Never an end-user JWT. |
| `FORECAST_TIMEOUT_MS` | `120000` | Timeout of each call. |
| `FORECAST_MAX_SERIES` | `500` | Series per call (the service's `MAX_SERIES_PER_REQUEST`). |
| `FORECAST_HORIZON` | `4` | Weeks forecast; must equal the horizon of the service's policy, or the service refuses the request. |

## Not done yet

- Calendar of closed dates (`calendar.closed_dates`, `closed_dates_by_warehouse`): there is no table for them yet.
- Forecast evaluation (`POST /v1/forecast-evaluations`) after the horizon has elapsed, and its metrics.
- Calculated safety stock and reorder point from the forecast (CU-11, US-40).
- Scheduled runs; runs are started by hand.
- History imported from the organization's previous system (T-01, CU-17).
