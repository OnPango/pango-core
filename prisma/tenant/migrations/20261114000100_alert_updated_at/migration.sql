-- Replenishment alerts (CU-12a): an open BELOW_ROP alert is refreshed on every
-- evaluation (severity, available stock, suggested quantity, reorder point and
-- message), so record when it last changed. Existing alerts have not changed
-- since they were raised (or resolved).

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "alerts" SET "updated_at" = COALESCE("resolved_at", "created_at");

