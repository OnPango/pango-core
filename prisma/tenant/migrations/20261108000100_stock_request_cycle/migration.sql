-- Stock requests (CU-08, CU-09):
-- - Status cycle of RF-REQ-003: PENDING → IN_PROGRESS → FULFILLED, or REJECTED with
--   a reason; CANCELLED by the requester. APPROVED becomes IN_PROGRESS, and PARTIAL
--   goes away (no partial fulfilment, RN-016).
-- - Request type (RF-REQ-007), rejection reason, notes and status history.
-- - settings.stock_request_movement_type_id: outbound type that fulfils internal
--   consumption requests ("Consumption issue", which counts as demand).
-- No stock requests existed before this migration, so `type` needs no default.

-- Status: recreate the type without PARTIAL (a value cannot be dropped in place).
CREATE TYPE "stock_request_status_new" AS ENUM ('PENDING', 'IN_PROGRESS', 'FULFILLED', 'REJECTED', 'CANCELLED');
ALTER TABLE "stock_requests" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "stock_requests" ALTER COLUMN "status" TYPE "stock_request_status_new"
    USING (CASE "status"::text WHEN 'APPROVED' THEN 'IN_PROGRESS' WHEN 'PARTIAL' THEN 'IN_PROGRESS' ELSE "status"::text END)::"stock_request_status_new";
DROP TYPE "stock_request_status";
ALTER TYPE "stock_request_status_new" RENAME TO "stock_request_status";
ALTER TABLE "stock_requests" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateEnum
CREATE TYPE "stock_request_type" AS ENUM ('INTERNAL_CONSUMPTION', 'INTERNAL_REPLENISHMENT', 'RETURN', 'INCIDENT');

-- AlterTable
ALTER TABLE "stock_requests" ADD COLUMN     "notes" TEXT,
ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "type" "stock_request_type" NOT NULL;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN     "stock_request_movement_type_id" INTEGER;

-- CreateTable
CREATE TABLE "stock_request_events" (
    "id" SERIAL NOT NULL,
    "stock_request_id" INTEGER NOT NULL,
    "status" "stock_request_status" NOT NULL,
    "changed_by_id" INTEGER NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_request_events_stock_request_id_idx" ON "stock_request_events"("stock_request_id");

-- CreateIndex
CREATE INDEX "stock_request_events_changed_by_id_idx" ON "stock_request_events"("changed_by_id");

-- CreateIndex
CREATE INDEX "settings_stock_request_movement_type_id_idx" ON "settings"("stock_request_movement_type_id");

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_stock_request_movement_type_id_fkey" FOREIGN KEY ("stock_request_movement_type_id") REFERENCES "movement_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_request_events" ADD CONSTRAINT "stock_request_events_stock_request_id_fkey" FOREIGN KEY ("stock_request_id") REFERENCES "stock_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_request_events" ADD CONSTRAINT "stock_request_events_changed_by_id_fkey" FOREIGN KEY ("changed_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Internal consumption requests are fulfilled with the base "Consumption issue" type.
UPDATE "settings" SET "stock_request_movement_type_id" = t."id"
FROM "movement_types" t WHERE t."name" = 'Consumption issue' AND t."is_base";
