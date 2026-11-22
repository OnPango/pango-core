-- US-045: an alert can be marked attended (and back to pending) by hand.
-- An attended alert stays in force: the evaluation refreshes and resolves it, and
-- puts it back to OPEN when its severity rises.

-- AlterEnum
ALTER TYPE "alert_status" ADD VALUE 'ATTENDED' BEFORE 'RESOLVED';

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "attended_at" TIMESTAMPTZ,
ADD COLUMN     "attended_by_id" INTEGER;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_attended_by_id_fkey" FOREIGN KEY ("attended_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- At most one alert in force (pending or attended) per product-warehouse and type.
-- Written by exclusion: a new enum value cannot be used in the transaction that
-- adds it, and provisioning applies every migration in one transaction.
DROP INDEX "alerts_open_key";
CREATE UNIQUE INDEX "alerts_open_key" ON "alerts"("product_warehouse_id", "type") WHERE "status" NOT IN ('RESOLVED', 'DISMISSED');
