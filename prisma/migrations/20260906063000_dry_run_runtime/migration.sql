-- DropIndex
DROP INDEX "Decision_correlationId_idx";

-- AlterTable
ALTER TABLE "Position"
ADD COLUMN "bestPrice" DECIMAL(38, 18) NOT NULL,
ADD COLUMN "entryFee" DECIMAL(38, 18) NOT NULL DEFAULT 0,
ADD COLUMN "entrySlippage" DECIMAL(38, 18) NOT NULL DEFAULT 0,
ADD COLUMN "stopPrice" DECIMAL(38, 18) NOT NULL,
ADD COLUMN "takePrice" DECIMAL(38, 18) NOT NULL,
ADD COLUMN "trailingPrice" DECIMAL(38, 18);

-- CreateTable
CREATE TABLE "RuntimeCursor" (
  "workspaceId" TEXT NOT NULL,
  "executionRunId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "lastEvaluatedAt" TIMESTAMPTZ(3),
  "pendingSignal" JSONB,
  "lastDecisionId" TEXT,
  "lastFailureCode" TEXT,
  "lastFailureMessage" TEXT,
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "RuntimeCursor_pkey" PRIMARY KEY ("executionRunId", "symbol")
);

-- CreateIndex
CREATE INDEX "RuntimeCursor_workspaceId_updatedAt_idx"
ON "RuntimeCursor"("workspaceId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Decision_workspaceId_correlationId_key"
ON "Decision"("workspaceId", "correlationId");

-- AddForeignKey
ALTER TABLE "RuntimeCursor"
ADD CONSTRAINT "RuntimeCursor_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeCursor"
ADD CONSTRAINT "RuntimeCursor_executionRunId_fkey"
FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeCursor"
ADD CONSTRAINT "RuntimeCursor_symbol_fkey"
FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol")
ON DELETE RESTRICT ON UPDATE CASCADE;
