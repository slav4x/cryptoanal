-- CreateEnum
CREATE TYPE "SystemLogLevel" AS ENUM ('DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateTable
CREATE TABLE "SystemLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "level" "SystemLogLevel" NOT NULL,
    "service" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "correlationId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemLog_workspaceId_createdAt_idx" ON "SystemLog"("workspaceId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SystemLog_workspaceId_level_createdAt_idx" ON "SystemLog"("workspaceId", "level", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SystemLog_workspaceId_service_createdAt_idx" ON "SystemLog"("workspaceId", "service", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SystemLog_workspaceId_correlationId_idx" ON "SystemLog"("workspaceId", "correlationId");

-- AddForeignKey
ALTER TABLE "SystemLog" ADD CONSTRAINT "SystemLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
