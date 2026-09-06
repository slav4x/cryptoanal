/*
  Warnings:

  - Added the required column `context` to the `ExecutionRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contextHash` to the `ExecutionRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `createdByActorId` to the `ExecutionRun` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ExecutionRun" ADD COLUMN     "context" JSONB NOT NULL,
ADD COLUMN     "contextHash" TEXT NOT NULL,
ADD COLUMN     "createdByActorId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "CommandReceipt" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommandReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommandReceipt_workspaceId_resourceType_resourceId_createdA_idx" ON "CommandReceipt"("workspaceId", "resourceType", "resourceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommandReceipt_workspaceId_idempotencyKey_key" ON "CommandReceipt"("workspaceId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "CommandReceipt" ADD CONSTRAINT "CommandReceipt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
