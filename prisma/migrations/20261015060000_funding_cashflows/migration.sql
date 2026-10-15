ALTER TABLE "Position" ADD COLUMN "fundingPolicy" JSONB, ADD COLUMN "fundingState" JSONB,
  ADD COLUMN "fundingAccrued" DECIMAL(38,18), ADD COLUMN "fundingRemaining" DECIMAL(38,18);
ALTER TABLE "Fill" ADD COLUMN "fundingAllocated" DECIMAL(38,18);
ALTER TABLE "ValidationRun" ADD COLUMN "fundingSnapshot" JSONB;
ALTER TABLE "ValidationTrade" ADD COLUMN funding DECIMAL(38,18);
CREATE TABLE "FundingHistorySnapshot" (
 id TEXT PRIMARY KEY,payload JSONB NOT NULL,"payloadHash" TEXT NOT NULL,"capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "FundingMarketState" (
 symbol TEXT PRIMARY KEY,"nextFundingAt" TIMESTAMPTZ(3) NOT NULL,"observedAt" TIMESTAMPTZ(3) NOT NULL,
 "checkedFrom" TIMESTAMPTZ(3) NOT NULL,"checkedThrough" TIMESTAMPTZ(3) NOT NULL,"snapshotId" TEXT NOT NULL REFERENCES "FundingHistorySnapshot"(id) ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "PositionFundingPayment" (
 id TEXT PRIMARY KEY,"positionId" TEXT NOT NULL REFERENCES "Position"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "workspaceId" TEXT NOT NULL,symbol TEXT NOT NULL,"settledAt" TIMESTAMPTZ(3) NOT NULL,quantity DECIMAL(38,18) NOT NULL,
 rate DECIMAL(38,18) NOT NULL,"markPrice" DECIMAL(38,18) NOT NULL,amount DECIMAL(38,18) NOT NULL,
 execution JSONB NOT NULL,"appliedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(quantity>0 AND "markPrice">0)
);
CREATE UNIQUE INDEX "PositionFundingPayment_positionId_settledAt_key" ON "PositionFundingPayment"("positionId","settledAt");
CREATE INDEX "PositionFundingPayment_workspaceId_settledAt_idx" ON "PositionFundingPayment"("workspaceId","settledAt");
ALTER TABLE "Position" DROP CONSTRAINT "Position_remaining_balance_check";
ALTER TABLE "Position" ADD CONSTRAINT "Position_remaining_balance_check" CHECK (
 ("remainingQuantity" IS NULL AND "remainingEntryFee" IS NULL) OR
 ("remainingQuantity" IS NOT NULL AND "remainingEntryFee" IS NOT NULL AND "remainingQuantity">=0 AND "remainingQuantity"<=quantity AND
 "remainingEntryFee">=0 AND "remainingEntryFee"<="entryFee" AND (status<>'CLOSED' OR "remainingQuantity"=0) AND
 (status<>'OPEN' OR "remainingQuantity">0 OR ("fundingPolicy" IS NOT NULL AND "exitState" IS NOT NULL)))
);
ALTER TABLE "Position" ADD CONSTRAINT "Position_funding_balance_check" CHECK (
 ("fundingPolicy" IS NULL AND "fundingState" IS NULL AND "fundingAccrued" IS NULL AND "fundingRemaining" IS NULL) OR
 ("fundingPolicy" IS NOT NULL AND "fundingState" IS NOT NULL AND "fundingAccrued" IS NOT NULL AND "fundingRemaining" IS NOT NULL
 AND "fundingPolicy"->>'version'='cryptoanal-funding@mark-open-v1' AND "exitPolicy"->>'fillModel'='l1-ioc@1'
 AND ("remainingQuantity"<>0 OR "fundingRemaining"=0))
);
