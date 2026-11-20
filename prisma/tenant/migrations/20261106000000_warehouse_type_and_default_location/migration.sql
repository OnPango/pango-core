-- CU-04: warehouses are storage warehouses or stores, and each one has a default
-- location (RN-002). Locations now point to their warehouse directly, so the
-- default location needs no level and location codes are unique per warehouse.

-- CreateEnum
CREATE TYPE "warehouse_type" AS ENUM ('WAREHOUSE', 'STORE');

-- AlterTable
ALTER TABLE "warehouses" ADD COLUMN "type" "warehouse_type" NOT NULL DEFAULT 'WAREHOUSE',
ADD COLUMN "default_location_id" INTEGER;

-- AlterTable: add warehouse_id, filled from the location's level.
ALTER TABLE "locations" ADD COLUMN "warehouse_id" INTEGER;
UPDATE "locations" l SET "warehouse_id" = ll."warehouse_id"
FROM "location_levels" ll WHERE ll."id" = l."level_id";
ALTER TABLE "locations" ALTER COLUMN "warehouse_id" SET NOT NULL,
ALTER COLUMN "level_id" DROP NOT NULL;

-- DropIndex
DROP INDEX "locations_code_key";

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_default_location_id_key" ON "warehouses"("default_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "locations_warehouse_id_code_key" ON "locations"("warehouse_id", "code");

-- AddForeignKey
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_default_location_id_fkey" FOREIGN KEY ("default_location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locations" ADD CONSTRAINT "locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Data ────────────────────────────────────────────────────────────────────

-- Default location for the warehouses that already exist.
INSERT INTO "locations" ("warehouse_id", "code")
SELECT w."id", 'DEFAULT' FROM "warehouses" w
ON CONFLICT ("warehouse_id", "code") DO NOTHING;

UPDATE "warehouses" w SET "default_location_id" = l."id"
FROM "locations" l
WHERE l."warehouse_id" = w."id" AND l."code" = 'DEFAULT' AND w."default_location_id" IS NULL;
