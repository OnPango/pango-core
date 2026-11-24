# CU-11 · Calculated reorder point

## Architecture decision

**Design status** · Approved, as recorded in [Project Context](../project/project-context.md#decisions-taken-with-the-user).

A warehouse needs enough available stock to cover demand while it waits for replenishment. CU-10 already stores a weekly forecast and its calibrated interval for the entire horizon. CU-12 already evaluates alerts against the effective reorder point of each product in each warehouse.

For `FORECAST_ROP`, use the current `OK` forecast for that product and warehouse. Let `H` be the horizon of that forecast run in weeks multiplied by seven, and `L` the replenishment lead time in days. Use the forecast's total estimate and upper bound.

```text
expected demand = estimate × L / H
safety stock    = (upper − estimate) × √(L / H)
reorder point   = expected demand + safety stock
```

Keep decimal precision through the calculation, then round each of the two stored quantities up to four decimal places. For a 28-day forecast of 100 units with an upper bound of 120 and a seven-day lead time, expected demand is 25, safety stock is 10, and the reorder point is 35. This method scales the forecast's uncertainty to the lead time. Using a configurable service level would require the nominal coverage or error spread from the forecasting service.

Keep manual safety stock and reorder point separately. Both manual methods (`FIXED_ROP` and existing `MIN_MAX` rows) use those values. A row configured for forecasting also uses them whenever it lacks a current usable forecast, a total interval or a positive lead time. Keep its method set to `FORECAST_ROP` so it can resume calculation when the inputs become available.

## Implementation task for Claude

**Status** · Implemented in commit `1c07bfc` on `feature/reorder-point-calculation`. The user requested that the reviewed changes be committed and pushed.

The build and type-aware lint passed. The unit suite passed all 245 tests, and the e2e suite passed its single root-endpoint smoke test. Validation of migration, rollback and concurrent writes against PostgreSQL and a live forecasting-service run remains unconfirmed in this review.

**Objective.** Apply CU-11 through the existing replenishment and forecast endpoints so users can see which threshold is in force and why an alert opened or resolved.

**Scope.** Extend the tenant data model and migration, replenishment GET and PUT, forecast result persistence, alert evaluation, relevant tests, Swagger and the database, forecasting and replenishment guides.

**Technical constraints.** Reuse tenant isolation, warehouse permissions, decimal quantity semantics and the existing product row locks. For a forecast transaction, lock affected products in ascending ID order before deciding which rows currently use forecasting. Read the method, lead time and current forecast under that lock. Persist forecast results, effective thresholds and alert changes atomically. Keep the external service call outside the transaction.

**Dependencies.** CU-10 supplies current forecasts and their run horizons. CU-12 supplies available stock, alert severity and resolution rules. The design and its approval are recorded in [Project Context](../project/project-context.md). The discarded implementation is a historical reference.

**Acceptance criteria**

1. Existing manual settings survive tenant migration and provisioning. Existing PUT bodies still work. Optional method and lead-time fields preserve their stored values when omitted. New rows default to `FIXED_ROP` and seven days. Editing manual quantities while forecasting is active updates the fallback. Switching back to manual immediately restores it.
2. GET and PUT responses distinguish effective and manual quantities and report method, lead time and source. A calculated result identifies its base forecast. A fallback identifies the missing input. A legitimate zero-width interval gives zero safety stock.
3. A parameter change or a committed forecast run recalculates the affected forecasting rows and then evaluates their alerts. A replacement `OK` uses the new forecast. A `NO_FORECAST` retires the previous forecast and activates the fallback. A series-level `ERROR` retains the previous current forecast if present. A failed run that commits no results leaves thresholds and alerts intact.
4. Compare available stock (on hand less active reservations) with the effective threshold. At or below a positive point, open or refresh one alert. Above it, resolve the alert. Preserve the existing zero-threshold and inactive-item rules. The suggested quantity is the positive shortfall to the greater of the point and the configured maximum, using the point when the maximum is absent.
5. Repeated evaluation with identical inputs preserves the alert identity and avoids redundant updates. Concurrent parameter edits, forecast completion and stock movements produce values consistent with the committed inputs. A change for one warehouse leaves the same product's settings in other warehouses intact.

**Validation requirements.** Report commands, outcomes and evidence against the criteria. Cover the worked example, upward rounding, a lead time longer than the horizon, manual restoration, each fallback and forecast outcome, and equality at the alert threshold. Exercise migration with preexisting manual data and fresh tenant provisioning. Exercise transaction rollback and competing writes on PostgreSQL. Use a controlled forecast response for repeatable integration checks and distinguish any live Python-service run in the report. Run the project build and relevant test suites.

**Out of scope.** Connection-pool changes, service-level calibration, a new min/max algorithm, changes to the Python contract, scheduled forecasting and automatic purchase orders.
