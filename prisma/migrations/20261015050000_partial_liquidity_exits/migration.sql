ALTER TABLE "Position" ADD COLUMN "remainingQuantity" DECIMAL(38,18);
ALTER TABLE "Position" ADD COLUMN "remainingEntryFee" DECIMAL(38,18);
ALTER TABLE "Position" ADD COLUMN "exitState" JSONB;
ALTER TABLE "Fill" ADD COLUMN "realizedGrossPnl" DECIMAL(38,18);
ALTER TABLE "Fill" ADD COLUMN "realizedNetPnl" DECIMAL(38,18);
ALTER TABLE "Fill" ADD COLUMN "entryFeeAllocated" DECIMAL(38,18);
ALTER TABLE "Position" ADD CONSTRAINT "Position_remaining_balance_check" CHECK (
  ("remainingQuantity" IS NULL AND "remainingEntryFee" IS NULL) OR
  ("remainingQuantity" IS NOT NULL AND "remainingEntryFee" IS NOT NULL AND
   "remainingQuantity" >= 0 AND "remainingQuantity" <= quantity AND
   "remainingEntryFee" >= 0 AND "remainingEntryFee" <= "entryFee" AND
   (status <> 'CLOSED' OR "remainingQuantity" = 0) AND
   (status <> 'OPEN' OR "remainingQuantity" > 0))
);
ALTER TABLE "Fill" ADD CONSTRAINT "Fill_realized_cash_check" CHECK (
  ("realizedGrossPnl" IS NULL AND "realizedNetPnl" IS NULL AND "entryFeeAllocated" IS NULL) OR
  ("realizedGrossPnl" IS NOT NULL AND "realizedNetPnl" IS NOT NULL AND "entryFeeAllocated" IS NOT NULL AND
   "entryFeeAllocated" >= 0 AND "realizedNetPnl" = "realizedGrossPnl" - fee - "entryFeeAllocated")
);
CREATE INDEX "Fill_workspaceId_filledAt_idx" ON "Fill"("workspaceId", "filledAt");
