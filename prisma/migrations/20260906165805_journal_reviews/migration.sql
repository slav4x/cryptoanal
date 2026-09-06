-- CreateEnum
CREATE TYPE "JournalEntryKind" AS ENUM ('HYPOTHESIS', 'OBSERVATION', 'CONCLUSION', 'DECISION');

-- CreateEnum
CREATE TYPE "JournalLinkType" AS ENUM ('STRATEGY', 'STRATEGY_VERSION', 'EXECUTION_RUN', 'VALIDATION_RUN', 'TRADE', 'DECISION', 'SYMBOL');

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "JournalEntryKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "type" "JournalLinkType" NOT NULL,
    "strategyId" TEXT,
    "strategyVersionId" TEXT,
    "executionRunId" TEXT,
    "validationRunId" TEXT,
    "tradeId" TEXT,
    "decisionId" TEXT,
    "symbol" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "learnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextActions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewSessionEntry" (
    "reviewSessionId" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewSessionEntry_pkey" PRIMARY KEY ("reviewSessionId","journalEntryId")
);

-- CreateIndex
CREATE INDEX "JournalEntry_workspaceId_occurredAt_idx" ON "JournalEntry"("workspaceId", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "JournalEntry_workspaceId_kind_occurredAt_idx" ON "JournalEntry"("workspaceId", "kind", "occurredAt" DESC);

-- CreateIndex
CREATE INDEX "JournalEntry_tags_idx" ON "JournalEntry" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "JournalLink_workspaceId_type_idx" ON "JournalLink"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "JournalLink_journalEntryId_idx" ON "JournalLink"("journalEntryId");

-- CreateIndex
CREATE INDEX "JournalLink_strategyId_idx" ON "JournalLink"("strategyId");

-- CreateIndex
CREATE INDEX "JournalLink_strategyVersionId_idx" ON "JournalLink"("strategyVersionId");

-- CreateIndex
CREATE INDEX "JournalLink_executionRunId_idx" ON "JournalLink"("executionRunId");

-- CreateIndex
CREATE INDEX "JournalLink_validationRunId_idx" ON "JournalLink"("validationRunId");

-- CreateIndex
CREATE INDEX "JournalLink_tradeId_idx" ON "JournalLink"("tradeId");

-- CreateIndex
CREATE INDEX "JournalLink_decisionId_idx" ON "JournalLink"("decisionId");

-- CreateIndex
CREATE INDEX "JournalLink_symbol_idx" ON "JournalLink"("symbol");

-- CreateIndex
CREATE INDEX "ReviewSession_workspaceId_endsAt_idx" ON "ReviewSession"("workspaceId", "endsAt" DESC);

-- CreateIndex
CREATE INDEX "ReviewSession_tags_idx" ON "ReviewSession" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "ReviewSessionEntry_journalEntryId_idx" ON "ReviewSessionEntry"("journalEntryId");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_strategyVersionId_fkey" FOREIGN KEY ("strategyVersionId") REFERENCES "StrategyVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_executionRunId_fkey" FOREIGN KEY ("executionRunId") REFERENCES "ExecutionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_validationRunId_fkey" FOREIGN KEY ("validationRunId") REFERENCES "ValidationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_decisionId_fkey" FOREIGN KEY ("decisionId") REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLink" ADD CONSTRAINT "JournalLink_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSession" ADD CONSTRAINT "ReviewSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSessionEntry" ADD CONSTRAINT "ReviewSessionEntry_reviewSessionId_fkey" FOREIGN KEY ("reviewSessionId") REFERENCES "ReviewSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewSessionEntry" ADD CONSTRAINT "ReviewSessionEntry_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
