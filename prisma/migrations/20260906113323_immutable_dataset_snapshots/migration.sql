-- AlterTable
ALTER TABLE "ValidationRun" ADD COLUMN     "datasetSnapshotId" TEXT;

-- CreateTable
CREATE TABLE "DatasetSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "exchange" TEXT NOT NULL,
    "instrumentType" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "symbols" JSONB NOT NULL,
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "candleCount" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetSnapshotCandle" (
    "datasetSnapshotId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "openTime" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volume" DECIMAL(38,8) NOT NULL,
    "turnover" DECIMAL(38,8) NOT NULL,

    CONSTRAINT "DatasetSnapshotCandle_pkey" PRIMARY KEY ("datasetSnapshotId","symbol","openTime")
);

-- CreateIndex
CREATE INDEX "DatasetSnapshot_workspaceId_createdAt_idx" ON "DatasetSnapshot"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DatasetSnapshot_workspaceId_contentHash_key" ON "DatasetSnapshot"("workspaceId", "contentHash");

-- CreateIndex
CREATE INDEX "DatasetSnapshotCandle_datasetSnapshotId_openTime_idx" ON "DatasetSnapshotCandle"("datasetSnapshotId", "openTime");

-- CreateIndex
CREATE INDEX "ValidationRun_datasetSnapshotId_idx" ON "ValidationRun"("datasetSnapshotId");

-- AddForeignKey
ALTER TABLE "ValidationRun" ADD CONSTRAINT "ValidationRun_datasetSnapshotId_fkey" FOREIGN KEY ("datasetSnapshotId") REFERENCES "DatasetSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetSnapshot" ADD CONSTRAINT "DatasetSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetSnapshotCandle" ADD CONSTRAINT "DatasetSnapshotCandle_datasetSnapshotId_fkey" FOREIGN KEY ("datasetSnapshotId") REFERENCES "DatasetSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetSnapshotCandle" ADD CONSTRAINT "DatasetSnapshotCandle_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
