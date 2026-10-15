ALTER TABLE "Position" ADD COLUMN "entryExecution" JSONB;
ALTER TABLE "Order" ADD COLUMN "execution" JSONB;
ALTER TABLE "Order" ADD COLUMN "expiresAt" TIMESTAMPTZ(3);
CREATE INDEX "Order_status_expiresAt_idx" ON "Order"("status", "expiresAt");
ALTER TABLE "Fill" ADD COLUMN "execution" JSONB;
