-- CreateEnum
CREATE TYPE "PlaybookStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "PlaybookStatus" NOT NULL DEFAULT 'ACTIVE',
    "marketConditions" TEXT NOT NULL,
    "entryRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exitRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "riskRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invalidationRules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checklist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdByActorId" TEXT NOT NULL,
    "updatedByActorId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Playbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybookStrategy" (
    "playbookId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaybookStrategy_pkey" PRIMARY KEY ("playbookId","strategyId")
);

-- CreateTable
CREATE TABLE "PlaybookTrade" (
    "playbookId" TEXT NOT NULL,
    "tradeId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlaybookTrade_pkey" PRIMARY KEY ("playbookId","tradeId")
);

-- CreateIndex
CREATE INDEX "Playbook_workspaceId_status_updatedAt_idx" ON "Playbook"("workspaceId", "status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "Playbook_tags_idx" ON "Playbook" USING GIN ("tags");

-- CreateIndex
CREATE UNIQUE INDEX "Playbook_workspaceId_name_key" ON "Playbook"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "PlaybookStrategy_strategyId_idx" ON "PlaybookStrategy"("strategyId");

-- CreateIndex
CREATE INDEX "PlaybookTrade_tradeId_idx" ON "PlaybookTrade"("tradeId");

-- AddForeignKey
ALTER TABLE "Playbook" ADD CONSTRAINT "Playbook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookStrategy" ADD CONSTRAINT "PlaybookStrategy_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "Playbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookStrategy" ADD CONSTRAINT "PlaybookStrategy_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "Strategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookTrade" ADD CONSTRAINT "PlaybookTrade_playbookId_fkey" FOREIGN KEY ("playbookId") REFERENCES "Playbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaybookTrade" ADD CONSTRAINT "PlaybookTrade_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE CASCADE ON UPDATE CASCADE;
