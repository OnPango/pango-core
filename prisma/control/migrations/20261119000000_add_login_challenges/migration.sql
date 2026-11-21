-- Two-step login: valid credentials open a challenge, completed with a code emailed to
-- the account. Only the SHA-256 of the challenge token and an HMAC of the code are stored.

-- CreateTable
CREATE TABLE "login_challenges" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "organization_id" INTEGER NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "send_count" SMALLINT NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "last_sent_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "login_challenges_token_hash_key" ON "login_challenges"("token_hash");

-- CreateIndex
CREATE INDEX "login_challenges_account_id_organization_id_idx" ON "login_challenges"("account_id", "organization_id");

-- CreateIndex
CREATE INDEX "login_challenges_organization_id_idx" ON "login_challenges"("organization_id");

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
