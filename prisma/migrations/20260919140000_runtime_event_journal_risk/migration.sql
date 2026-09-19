ALTER TABLE "Position" ADD COLUMN "priceEventId" BIGINT, ADD COLUMN "priceStreamId" TEXT, ADD COLUMN "managedThroughAt" TIMESTAMPTZ(3);
UPDATE "Position" SET "managedThroughAt" = "updatedAt" WHERE "status" = 'OPEN';
ALTER TABLE "WorkspaceSettings" ADD COLUMN "runtimeKillSwitch" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "runtimeKillReason" TEXT, ADD COLUMN "runtimeKillVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "MarketPriceEvent" (
  "id" BIGSERIAL PRIMARY KEY, "eventKey" TEXT NOT NULL UNIQUE, "symbol" TEXT NOT NULL,
  "price" DECIMAL(38,18) NOT NULL, "observedAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "streamId" TEXT NOT NULL
);
CREATE INDEX "MarketPriceEvent_symbol_id_idx" ON "MarketPriceEvent"("symbol", "id");
CREATE INDEX "MarketPriceEvent_observedAt_idx" ON "MarketPriceEvent"("observedAt");
CREATE TABLE "MarketStreamLease" ("id" TEXT PRIMARY KEY, "owner" TEXT NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL);
CREATE TABLE "RuntimeRiskDay" (
  "workspaceId" TEXT NOT NULL, "exchangeAccountId" TEXT NOT NULL, "day" TEXT NOT NULL,
  "haltReason" TEXT NOT NULL, "haltedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("workspaceId", "exchangeAccountId", "day"),
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE
);
