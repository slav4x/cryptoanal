ALTER TABLE "ExchangeConnection"
ADD COLUMN "credentialRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "lastVerificationAttemptAt" TIMESTAMPTZ(3),
ADD COLUMN "nextVerificationAt" TIMESTAMPTZ(3),
ADD COLUMN "verificationLeaseOwner" VARCHAR(120),
ADD COLUMN "verificationLeaseExpiresAt" TIMESTAMPTZ(3);

UPDATE "ExchangeConnection"
SET "lastVerificationAttemptAt" = "lastVerifiedAt",
    "nextVerificationAt" = COALESCE("lastVerifiedAt", CURRENT_TIMESTAMP)
WHERE "status" = 'ACTIVE' AND "revokedAt" IS NULL;

CREATE INDEX "ExchangeConnection_status_nextVerificationAt_verificationLeaseExpiresAt_idx"
ON "ExchangeConnection"("status", "nextVerificationAt", "verificationLeaseExpiresAt");
