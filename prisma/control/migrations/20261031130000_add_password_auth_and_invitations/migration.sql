-- CreateEnum
CREATE TYPE "account_token_purpose" AS ENUM ('EMAIL_VERIFICATION');

-- DropIndex
DROP INDEX "accounts_cognito_sub_key";

-- AlterTable
ALTER TABLE "accounts" DROP COLUMN "cognito_sub",
ADD COLUMN     "email_verified_at" TIMESTAMPTZ,
ADD COLUMN     "password_hash" VARCHAR(255);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" SERIAL NOT NULL,
    "organization_id" INTEGER NOT NULL,
    "email" VARCHAR(150) NOT NULL,
    "role_id" INTEGER NOT NULL,
    "warehouse_id" INTEGER,
    "invited_by_account_id" INTEGER NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "organization_id" INTEGER NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_tokens" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "purpose" "account_token_purpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_idx" ON "organization_invitations"("organization_id");

-- CreateIndex
CREATE INDEX "organization_invitations_invited_by_account_id_idx" ON "organization_invitations"("invited_by_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_account_id_organization_id_idx" ON "refresh_tokens"("account_id", "organization_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_organization_id_idx" ON "refresh_tokens"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_tokens_token_hash_key" ON "account_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "account_tokens_account_id_purpose_idx" ON "account_tokens"("account_id", "purpose");

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_account_id_fkey" FOREIGN KEY ("invited_by_account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_tokens" ADD CONSTRAINT "account_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: constraints Prisma cannot express

-- Existing accounts were created by the CLI (trusted); treat them as verified
UPDATE "accounts" SET "email_verified_at" = now();

-- One pending invitation per (organization, email)
CREATE UNIQUE INDEX "organization_invitations_pending_key"
    ON "organization_invitations"("organization_id", "email")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;

ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_email_lowercase_chk" CHECK ("email" = lower("email"));
