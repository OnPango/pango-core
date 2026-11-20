-- Forecast tables aligned with the forecasting service contract v1 (CU-10):
-- - forecast_runs: request_id, history_end, who started it, per-series counts,
--   policy and service versions, and why a run failed.
-- - forecasts: one row per series of a run, OK or ERROR. The model is free text
--   (the service picks it by policy); demand classes gain INSUFFICIENT and
--   NOT_CLASSIFIABLE; the horizon total interval, profile, warnings and business
--   days are kept. Error metrics move to the later evaluation step.
-- No forecast runs existed before this migration, so the new required columns
-- need no default.

-- CreateEnum
CREATE TYPE "forecast_status" AS ENUM ('OK', 'ERROR');

-- AlterEnum
ALTER TYPE "demand_class" ADD VALUE 'INSUFFICIENT';
ALTER TYPE "demand_class" ADD VALUE 'NOT_CLASSIFIABLE';

-- AlterTable
ALTER TABLE "forecast_runs" ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "history_end" DATE NOT NULL,
ADD COLUMN     "policy_version" VARCHAR(60),
ADD COLUMN     "request_id" VARCHAR(64) NOT NULL,
ADD COLUMN     "series_error" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "series_ok" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "series_total" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "service_version" VARCHAR(30),
ADD COLUMN     "started_by_id" INTEGER;

-- AlterTable
ALTER TABLE "forecasts" DROP COLUMN "error_metric",
DROP COLUMN "error_value",
DROP COLUMN "model",
ADD COLUMN     "error_code" VARCHAR(40),
ADD COLUMN     "error_message" TEXT,
ADD COLUMN     "horizon_business_days" JSONB,
ADD COLUMN     "model_name" VARCHAR(60),
ADD COLUMN     "model_version" VARCHAR(60),
ADD COLUMN     "profile" JSONB,
ADD COLUMN     "status" "forecast_status" NOT NULL,
ADD COLUMN     "total_estimate" DECIMAL(14,4),
ADD COLUMN     "total_lower" DECIMAL(14,4),
ADD COLUMN     "total_upper" DECIMAL(14,4),
ADD COLUMN     "warnings" JSONB,
ALTER COLUMN "demand_class" DROP NOT NULL;

-- DropEnum
DROP TYPE "forecast_model";

-- CreateIndex
CREATE UNIQUE INDEX "forecast_runs_request_id_key" ON "forecast_runs"("request_id");

-- CreateIndex
CREATE INDEX "forecast_runs_started_by_id_idx" ON "forecast_runs"("started_by_id");

-- AddForeignKey
ALTER TABLE "forecast_runs" ADD CONSTRAINT "forecast_runs_started_by_id_fkey" FOREIGN KEY ("started_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
