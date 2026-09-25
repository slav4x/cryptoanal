CREATE TYPE "DecisionMode" AS ENUM ('EXECUTION', 'SHADOW');
CREATE TYPE "DecisionProviderKind" AS ENUM ('RULE_BASED', 'ML', 'LLM');

CREATE TABLE "DecisionContextSnapshot" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "executionRunId" TEXT NOT NULL,
  "strategyVersionId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "featureSetVersion" TEXT NOT NULL,
  "contentHash" CHAR(64) NOT NULL,
  "availableAt" TIMESTAMPTZ(3) NOT NULL,
  "context" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionContextSnapshot_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Decision"
  ADD COLUMN "contextSnapshotId" TEXT,
  ADD COLUMN "mode" "DecisionMode" NOT NULL DEFAULT 'EXECUTION',
  ADD COLUMN "providerKind" "DecisionProviderKind" NOT NULL DEFAULT 'RULE_BASED',
  ADD COLUMN "providerId" TEXT NOT NULL DEFAULT 'rule-based',
  ADD COLUMN "providerVersion" TEXT NOT NULL DEFAULT 'execution-engine',
  ADD COLUMN "candidate" JSONB,
  ADD COLUMN "verdictReasonCode" TEXT,
  ADD COLUMN "latencyMs" INTEGER;

CREATE UNIQUE INDEX "DecisionContextSnapshot_executionRunId_symbol_contentHash_key"
  ON "DecisionContextSnapshot"("executionRunId", "symbol", "contentHash");
CREATE INDEX "DecisionContextSnapshot_workspaceId_availableAt_idx"
  ON "DecisionContextSnapshot"("workspaceId", "availableAt" DESC);
CREATE INDEX "DecisionContextSnapshot_workspaceId_symbol_availableAt_idx"
  ON "DecisionContextSnapshot"("workspaceId", "symbol", "availableAt" DESC);
CREATE INDEX "Decision_contextSnapshotId_idx" ON "Decision"("contextSnapshotId");
CREATE INDEX "Decision_workspaceId_mode_decidedAt_idx"
  ON "Decision"("workspaceId", "mode", "decidedAt");

ALTER TABLE "DecisionContextSnapshot"
  ADD CONSTRAINT "DecisionContextSnapshot_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DecisionContextSnapshot"
  ADD CONSTRAINT "DecisionContextSnapshot_executionRunId_fkey"
  FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionContextSnapshot"
  ADD CONSTRAINT "DecisionContextSnapshot_strategyVersionId_fkey"
  FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DecisionContextSnapshot"
  ADD CONSTRAINT "DecisionContextSnapshot_symbol_fkey"
  FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Decision"
  ADD CONSTRAINT "Decision_contextSnapshotId_fkey"
  FOREIGN KEY ("contextSnapshotId") REFERENCES "DecisionContextSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
