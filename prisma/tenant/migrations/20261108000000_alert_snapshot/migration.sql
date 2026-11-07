-- Replenishment alerts (CU-12a): keep the values the alert was raised with, and
-- allow at most one OPEN alert per product-warehouse and type. No alerts were
-- generated before this migration, so the new columns need no default.

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "available_quantity" DECIMAL(14,4) NOT NULL,
ADD COLUMN     "reorder_point" DECIMAL(14,4) NOT NULL,
ADD COLUMN     "reorder_point_source" "value_source" NOT NULL;

CREATE UNIQUE INDEX "alerts_open_key" ON "alerts"("product_warehouse_id", "type") WHERE "status" = 'OPEN';
