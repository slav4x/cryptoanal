CREATE TABLE "PasswordRecoveryToken" (
    "id" TEXT NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordRecoveryToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordRecoveryToken_tokenHash_key"
ON "PasswordRecoveryToken"("tokenHash");

CREATE INDEX "PasswordRecoveryToken_userId_expiresAt_idx"
ON "PasswordRecoveryToken"("userId", "expiresAt");

ALTER TABLE "PasswordRecoveryToken"
ADD CONSTRAINT "PasswordRecoveryToken_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
