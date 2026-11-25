-- Inventory import (docs/modules/inventary.md): staging of an import's batches,
-- rows and issues, and the link from opening movements to their import.

-- CreateEnum
CREATE TYPE "inventory_import_status" AS ENUM ('RECEIVING', 'READY', 'INVALID', 'COMPLETED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "inventory_import_row_status" AS ENUM ('PENDING', 'VALID', 'INVALID', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "inventory_import_issue_severity" AS ENUM ('ERROR', 'WARNING');

-- AlterTable
ALTER TABLE "movements" ADD COLUMN     "inventory_import_id" INTEGER;

-- CreateTable
CREATE TABLE "inventory_imports" (
    "id" SERIAL NOT NULL,
    "client_request_id" UUID NOT NULL,
    "created_by_id" INTEGER NOT NULL,
    "status" "inventory_import_status" NOT NULL DEFAULT 'RECEIVING',
    "schema_version" SMALLINT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "sheet_name" VARCHAR(100) NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "received_rows" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "mapping" JSONB NOT NULL,
    "request_fingerprint" CHAR(64) NOT NULL,
    "summary" JSONB,
    "validation_fingerprint" CHAR(64),
    "result" JSONB,
    "last_activity_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_import_batches" (
    "import_id" INTEGER NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "received_rows_after" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_import_batches_pkey" PRIMARY KEY ("import_id","batch_number")
);

-- CreateTable
CREATE TABLE "inventory_import_rows" (
    "import_id" INTEGER NOT NULL,
    "row_number" INTEGER NOT NULL,
    "batch_number" INTEGER NOT NULL,
    "values" JSONB NOT NULL,
    "status" "inventory_import_row_status" NOT NULL DEFAULT 'PENDING',
    "preview" JSONB,
    "issue_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "inventory_import_rows_pkey" PRIMARY KEY ("import_id","row_number")
);

-- CreateTable
CREATE TABLE "inventory_import_issues" (
    "id" SERIAL NOT NULL,
    "import_id" INTEGER NOT NULL,
    "row_number" INTEGER,
    "field" VARCHAR(40),
    "severity" "inventory_import_issue_severity" NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "message" VARCHAR(300) NOT NULL,
    "value" VARCHAR(200),

    CONSTRAINT "inventory_import_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_imports_created_by_id_client_request_id_key" ON "inventory_imports"("created_by_id", "client_request_id");

-- CreateIndex
CREATE INDEX "inventory_import_rows_import_id_status_idx" ON "inventory_import_rows"("import_id", "status");

-- CreateIndex
CREATE INDEX "inventory_import_issues_import_id_row_number_idx" ON "inventory_import_issues"("import_id", "row_number");

-- CreateIndex
CREATE INDEX "movements_inventory_import_id_idx" ON "movements"("inventory_import_id");

-- AddForeignKey
ALTER TABLE "movements" ADD CONSTRAINT "movements_inventory_import_id_fkey" FOREIGN KEY ("inventory_import_id") REFERENCES "inventory_imports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_import_batches" ADD CONSTRAINT "inventory_import_batches_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "inventory_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_import_rows" ADD CONSTRAINT "inventory_import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "inventory_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_import_issues" ADD CONSTRAINT "inventory_import_issues_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "inventory_imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written: constraints Prisma cannot express ───────────────────────

-- At most one open import per organization (the schema is the organization).
CREATE UNIQUE INDEX "inventory_imports_open_key" ON "inventory_imports" ((true))
WHERE "status" IN ('RECEIVING', 'READY', 'INVALID');

ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_counts_chk"
CHECK ("schema_version" >= 1 AND "total_rows" > 0 AND "revision" >= 0
       AND "received_rows" BETWEEN 0 AND "total_rows");

ALTER TABLE "inventory_import_batches" ADD CONSTRAINT "inventory_import_batches_counts_chk"
CHECK ("batch_number" >= 1 AND "row_count" > 0 AND "received_rows_after" >= "row_count");

-- Row 1 of the file is the header.
ALTER TABLE "inventory_import_rows" ADD CONSTRAINT "inventory_import_rows_row_number_chk"
CHECK ("row_number" >= 2 AND "batch_number" >= 1 AND "issue_count" >= 0);
