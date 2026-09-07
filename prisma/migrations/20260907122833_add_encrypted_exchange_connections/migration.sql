-- CreateEnum
CREATE TYPE "ExchangeConnectionStatus" AS ENUM ('UNVERIFIED', 'ACTIVE', 'INVALID');

-- CreateTable
CREATE TABLE "ExchangeConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "exchange" VARCHAR(40) NOT NULL DEFAULT 'bybit',
    "label" VARCHAR(80) NOT NULL,
    "environment" "TradingEnvironment" NOT NULL,
    "status" "ExchangeConnectionStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "encryptedApiKey" BYTEA NOT NULL,
    "encryptedApiSecret" BYTEA NOT NULL,
    "apiKeyHint" VARCHAR(16) NOT NULL,
    "encryptionKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "lastVerifiedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ExchangeConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExchangeConnection_workspaceId_revokedAt_createdAt_idx" ON "ExchangeConnection"("workspaceId", "revokedAt", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ExchangeConnection" ADD CONSTRAINT "ExchangeConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
