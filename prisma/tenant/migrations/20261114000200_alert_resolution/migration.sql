-- Replenishment alerts (CU-12a): record why an alert was resolved, so a resolved
-- alert whose last values are still below its reorder point can be explained
-- (the reorder point changed, the product was archived...). Alerts resolved
-- before this migration keep a null reason.

-- CreateEnum
CREATE TYPE "alert_resolution" AS ENUM ('STOCK_RECOVERED', 'REORDER_POINT_CHANGED', 'NO_REORDER_POINT', 'INACTIVE');

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "resolution" "alert_resolution";
