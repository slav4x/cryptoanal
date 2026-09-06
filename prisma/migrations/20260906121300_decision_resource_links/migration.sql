-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "positionId" TEXT,
ADD COLUMN     "tradeId" TEXT;

-- CreateIndex
CREATE INDEX "Decision_positionId_idx" ON "Decision"("positionId");

-- CreateIndex
CREATE INDEX "Decision_tradeId_idx" ON "Decision"("tradeId");

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Decision" ADD CONSTRAINT "Decision_tradeId_fkey" FOREIGN KEY ("tradeId") REFERENCES "Trade"("id") ON DELETE SET NULL ON UPDATE CASCADE;
