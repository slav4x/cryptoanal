CREATE TABLE "MarketPriceArchiveChunk" (
  "firstEventId" BIGINT PRIMARY KEY,
  "lastEventId" BIGINT NOT NULL,
  "symbol" TEXT NOT NULL,
  "startsAt" TIMESTAMPTZ(3) NOT NULL,
  "endsAt" TIMESTAMPTZ(3) NOT NULL,
  "eventCount" INTEGER NOT NULL CHECK ("eventCount" > 0),
  "payload" BYTEA NOT NULL,
  "sha256" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("lastEventId" >= "firstEventId")
);
CREATE INDEX "MarketPriceArchiveChunk_symbol_firstEventId_idx" ON "MarketPriceArchiveChunk"("symbol", "firstEventId");
CREATE INDEX "MarketPriceArchiveChunk_symbol_lastEventId_idx" ON "MarketPriceArchiveChunk"("symbol", "lastEventId");

CREATE TABLE "PositionExecutionTrace" (
  "positionId" TEXT PRIMARY KEY REFERENCES "Position"("id") ON DELETE CASCADE,
  "workspaceId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "startEventId" BIGINT NOT NULL,
  "endEventId" BIGINT,
  "fullFromEntry" BOOLEAN NOT NULL,
  "eventCount" BIGINT DEFAULT 0,
  "policyHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "snapshotHash" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "closedAt" TIMESTAMPTZ(3),
  "retainUntil" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PositionExecutionTrace_symbol_startEventId_idx" ON "PositionExecutionTrace"("symbol", "startEventId");
CREATE INDEX "PositionExecutionTrace_workspaceId_startedAt_idx" ON "PositionExecutionTrace"("workspaceId", "startedAt");
CREATE INDEX "PositionExecutionTrace_retainUntil_idx" ON "PositionExecutionTrace"("retainUntil");

CREATE TABLE "PositionTraceRecord" (
  "id" BIGSERIAL PRIMARY KEY,
  "positionId" TEXT NOT NULL REFERENCES "PositionExecutionTrace"("positionId") ON DELETE CASCADE,
  "runtimeVersion" INTEGER NOT NULL,
  "eventId" BIGINT,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PositionTraceRecord_positionId_runtimeVersion_kind_key" ON "PositionTraceRecord"("positionId", "runtimeVersion", "kind");
CREATE INDEX "PositionTraceRecord_positionId_id_idx" ON "PositionTraceRecord"("positionId", "id");
