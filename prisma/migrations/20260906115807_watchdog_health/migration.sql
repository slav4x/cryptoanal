-- CreateEnum
CREATE TYPE "HealthSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateTable
CREATE TABLE "WatchdogIncident" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "severity" "HealthSeverity" NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "firstObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "lastObservedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WatchdogIncident_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WatchdogIncident_workspaceId_status_severity_lastObservedAt_idx" ON "WatchdogIncident"("workspaceId", "status", "severity", "lastObservedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "WatchdogIncident_workspaceId_fingerprint_key" ON "WatchdogIncident"("workspaceId", "fingerprint");

-- AddForeignKey
ALTER TABLE "WatchdogIncident" ADD CONSTRAINT "WatchdogIncident_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
