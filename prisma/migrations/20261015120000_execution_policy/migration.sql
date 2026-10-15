ALTER TABLE "ExecutionRun" ADD COLUMN "executionPolicy" JSONB;
ALTER TABLE "Position" ADD COLUMN "executionPolicy" JSONB;
ALTER TABLE "ValidationRun" ADD COLUMN "executionPolicy" JSONB;
CREATE TABLE "ExecutionPolicyBaseline" (
 "executionRunId" TEXT PRIMARY KEY REFERENCES "ExecutionRun"(id) ON DELETE CASCADE ON UPDATE CASCADE,
 "validationRunId" TEXT NOT NULL REFERENCES "ValidationRun"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ExecutionPolicyBaseline_validationRunId_idx" ON "ExecutionPolicyBaseline"("validationRunId");
