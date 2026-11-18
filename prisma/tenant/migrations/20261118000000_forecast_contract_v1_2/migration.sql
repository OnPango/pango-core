-- Forecasting service contract v1.2:
-- - forecasts.status NO_FORECAST, with the service's `reason`: a series declined on
--   purpose (inactive, non-stock warehouse…), a decision kept and never retried.
-- - forecast_runs: PARTIAL status when some series failed, and a count of the
--   declined series.
-- - warehouses.holds_stock: administrator-managed; series of a warehouse that holds
--   no stock are declined as non_stock_warehouse.

ALTER TYPE "forecast_status" ADD VALUE 'NO_FORECAST';
ALTER TYPE "forecast_run_status" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "forecast_runs" ADD COLUMN     "series_no_forecast" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "forecasts" ADD COLUMN     "reason" VARCHAR(40);

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN     "holds_stock" BOOLEAN NOT NULL DEFAULT true;
