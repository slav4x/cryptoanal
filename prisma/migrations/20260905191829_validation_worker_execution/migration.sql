-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureMessage" TEXT,
ADD COLUMN     "lockedAt" TIMESTAMPTZ(3),
ADD COLUMN     "lockedBy" TEXT;
