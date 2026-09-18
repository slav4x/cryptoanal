DROP INDEX "MarketInstrument_exchange_enabled_idx";

ALTER TABLE "MarketInstrument"
ADD COLUMN "contractType" TEXT,
ADD COLUMN "metadataSyncedAt" TIMESTAMPTZ(3),
ADD COLUMN "minNotional" DECIMAL(38,18),
ADD COLUMN "minOrderQty" DECIMAL(38,18),
ADD COLUMN "qtyStep" DECIMAL(38,18),
ADD COLUMN "settleAsset" TEXT,
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'Trading',
ADD COLUMN "tickSize" DECIMAL(38,18);

CREATE TABLE "WorkspaceMarket" (
    "workspaceId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "addedByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMarket_pkey" PRIMARY KEY ("workspaceId", "symbol")
);

INSERT INTO "WorkspaceMarket" ("workspaceId", "symbol", "position", "addedByActorId")
SELECT
    workspace.id,
    instrument.symbol,
    (ROW_NUMBER() OVER (PARTITION BY workspace.id ORDER BY instrument.symbol) - 1)::INTEGER,
    'system:migration'
FROM "Workspace" workspace
CROSS JOIN "MarketInstrument" instrument
WHERE instrument.enabled = true;

CREATE INDEX "WorkspaceMarket_workspaceId_position_idx"
ON "WorkspaceMarket"("workspaceId", "position");

CREATE INDEX "WorkspaceMarket_symbol_idx" ON "WorkspaceMarket"("symbol");

CREATE INDEX "MarketInstrument_exchange_status_enabled_idx"
ON "MarketInstrument"("exchange", "status", "enabled");

CREATE UNIQUE INDEX "MarketInstrument_exchange_instrumentType_symbol_key"
ON "MarketInstrument"("exchange", "instrumentType", "symbol");

ALTER TABLE "WorkspaceMarket"
ADD CONSTRAINT "WorkspaceMarket_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkspaceMarket"
ADD CONSTRAINT "WorkspaceMarket_symbol_fkey"
FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
