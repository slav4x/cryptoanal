ALTER TABLE "Position" ADD COLUMN "recoveryModel" TEXT;
CREATE TABLE "MarketStreamSegment" (
  id TEXT PRIMARY KEY,
  "writerId" TEXT NOT NULL,
  "previousStreamId" TEXT,
  cause TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "interruptedAt" TIMESTAMPTZ(3),
  "endedAt" TIMESTAMPTZ(3),
  "disconnectCode" INTEGER,
  "disconnectReason" TEXT,
  "firstEventId" BIGINT,
  "lastEventId" BIGINT,
  "firstObservedAt" TIMESTAMPTZ(3),
  "lastObservedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "MarketStreamSegment_startedAt_idx" ON "MarketStreamSegment"("startedAt");
