-- CU-17: movement history import. Imported history is isolated from inventory.

-- CreateEnum
CREATE TYPE "movement_import_status" AS ENUM ('RECEIVING', 'VALIDATED', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "movement_import_row_status" AS ENUM ('PENDING', 'VALID', 'INVALID', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "movement_import_issue_severity" AS ENUM ('ERROR', 'WARNING');

-- CreateEnum
CREATE TYPE "historical_movement_leg" AS ENUM ('LINE', 'DISPATCH', 'RECEIPT');

-- DropIndex

-- DropIndex

-- CreateTable
CREATE TABLE "movement_imports" (
    "id" SERIAL NOT NULL,
    "source_namespace" VARCHAR(60) NOT NULL,
    "file_name" VARCHAR(255),
    "status" "movement_import_status" NOT NULL DEFAULT 'RECEIVING',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "valid_row_count" INTEGER NOT NULL DEFAULT 0,
    "invalid_row_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_row_count" INTEGER NOT NULL DEFAULT 0,
    "issue_counts" JSONB NOT NULL DEFAULT '{}',
    "uploaded_by_id" INTEGER NOT NULL,
    "confirmed_at" TIMESTAMPTZ,
    "saved_count" INTEGER,
    "skipped_count" INTEGER,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movement_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement_import_rows" (
    "id" SERIAL NOT NULL,
    "import_id" INTEGER NOT NULL,
    "row_number" INTEGER NOT NULL,
    "status" "movement_import_row_status" NOT NULL DEFAULT 'PENDING',
    "source" JSONB NOT NULL,
    "external_movement_id" VARCHAR(60),
    "line_number" INTEGER,
    "leg" "historical_movement_leg",
    "movement_code" VARCHAR(30),
    "movement_type_id" INTEGER,
    "business_date" DATE,
    "warehouse_id" INTEGER,
    "product_id" INTEGER,
    "location_code" VARCHAR(40),
    "lot_code" VARCHAR(40),
    "quantity_in" DECIMAL(14,4),
    "quantity_out" DECIMAL(14,4),
    "balance_after" DECIMAL(14,4),
    "running_balance" DECIMAL(14,4),
    "demand_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(14,4),
    "document_ref" VARCHAR(60),

    CONSTRAINT "movement_import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement_import_issues" (
    "id" SERIAL NOT NULL,
    "import_id" INTEGER NOT NULL,
    "row_number" INTEGER,
    "field" VARCHAR(40),
    "severity" "movement_import_issue_severity" NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "message" VARCHAR(300) NOT NULL,
    "value" VARCHAR(200),

    CONSTRAINT "movement_import_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "historical_movements" (
    "id" SERIAL NOT NULL,
    "import_id" INTEGER NOT NULL,
    "source_row_number" INTEGER NOT NULL,
    "source_namespace" VARCHAR(60) NOT NULL,
    "external_movement_id" VARCHAR(60) NOT NULL,
    "line_number" INTEGER NOT NULL,
    "leg" "historical_movement_leg" NOT NULL,
    "movement_code" VARCHAR(30) NOT NULL,
    "movement_type_id" INTEGER NOT NULL,
    "business_date" DATE NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "product_id" INTEGER NOT NULL,
    "location_code" VARCHAR(40),
    "lot_code" VARCHAR(40),
    "quantity_in" DECIMAL(14,4),
    "quantity_out" DECIMAL(14,4),
    "balance_after" DECIMAL(14,4),
    "running_balance" DECIMAL(14,4),
    "demand_quantity" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "unit_cost" DECIMAL(14,4),
    "document_ref" VARCHAR(60),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "movement_imports_uploaded_by_id_idx" ON "movement_imports"("uploaded_by_id");

-- CreateIndex
CREATE UNIQUE INDEX "movement_import_rows_import_id_row_number_key" ON "movement_import_rows"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "movement_import_issues_import_id_row_number_idx" ON "movement_import_issues"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "historical_movements_product_id_warehouse_id_business_date_idx" ON "historical_movements"("product_id", "warehouse_id", "business_date");

-- CreateIndex
CREATE INDEX "historical_movements_warehouse_id_idx" ON "historical_movements"("warehouse_id");

-- CreateIndex
CREATE INDEX "historical_movements_import_id_idx" ON "historical_movements"("import_id");

-- CreateIndex
CREATE INDEX "historical_movements_movement_type_id_idx" ON "historical_movements"("movement_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "historical_movements_source_namespace_external_movement_id__key" ON "historical_movements"("source_namespace", "external_movement_id", "line_number", "leg");

-- AddForeignKey
ALTER TABLE "movement_imports" ADD CONSTRAINT "movement_imports_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_import_rows" ADD CONSTRAINT "movement_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "movement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "movement_import_issues" ADD CONSTRAINT "movement_import_issues_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "movement_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_movements" ADD CONSTRAINT "historical_movements_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "movement_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_movements" ADD CONSTRAINT "historical_movements_movement_type_id_fkey" FOREIGN KEY ("movement_type_id") REFERENCES "movement_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_movements" ADD CONSTRAINT "historical_movements_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historical_movements" ADD CONSTRAINT "historical_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Importing movement history: Owner and Admin by default (not Operator).
INSERT INTO "permissions" ("code", "module", "scope", "description")
VALUES ('movement.import', 'movement', 'WAREHOUSE', 'Import movement history from a kardex');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE r."name" IN ('Owner', 'Admin') AND p."code" = 'movement.import'
ON CONFLICT DO NOTHING;
