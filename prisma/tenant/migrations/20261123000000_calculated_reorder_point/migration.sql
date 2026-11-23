-- AlterTable
ALTER TABLE "product_warehouses" ADD COLUMN     "calculated_at" TIMESTAMPTZ,
ADD COLUMN     "calculation_issue" VARCHAR(40),
ADD COLUMN     "manual_reorder_point" DECIMAL(14,4) NOT NULL DEFAULT 0,
ADD COLUMN     "manual_safety_stock" DECIMAL(14,4) NOT NULL DEFAULT 0;

-- Every value so far was set by hand: keep it as the manual fallback.
UPDATE "product_warehouses"
   SET "manual_safety_stock" = "safety_stock",
       "manual_reorder_point" = "reorder_point";
