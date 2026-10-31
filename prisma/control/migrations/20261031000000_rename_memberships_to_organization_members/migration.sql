-- Rename memberships to organization_members, keeping data. Constraint and index
-- names follow Prisma's defaults for the new table name.
ALTER TABLE "memberships" RENAME TO "organization_members";

ALTER TABLE "organization_members" RENAME CONSTRAINT "memberships_pkey" TO "organization_members_pkey";
ALTER TABLE "organization_members" RENAME CONSTRAINT "memberships_account_id_fkey" TO "organization_members_account_id_fkey";
ALTER TABLE "organization_members" RENAME CONSTRAINT "memberships_organization_id_fkey" TO "organization_members_organization_id_fkey";

ALTER INDEX "memberships_organization_id_idx" RENAME TO "organization_members_organization_id_idx";
