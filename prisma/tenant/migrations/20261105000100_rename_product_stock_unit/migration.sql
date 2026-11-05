-- products.unit_of_measure_id → stock_unit_id: the unit every quantity of the
-- product is counted in, not to be confused with its physical data (cm, kg, l).
-- Index and foreign key are renamed to the names Prisma derives from the column.

-- RenameColumn
ALTER TABLE "products" RENAME COLUMN "unit_of_measure_id" TO "stock_unit_id";

-- RenameIndex
ALTER INDEX "products_unit_of_measure_id_idx" RENAME TO "products_stock_unit_id_idx";

-- RenameForeignKey
ALTER TABLE "products" RENAME CONSTRAINT "products_unit_of_measure_id_fkey" TO "products_stock_unit_id_fkey";
