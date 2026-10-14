ALTER TABLE "MarketInstrument"
  ADD COLUMN "maxOrderQty" DECIMAL(38,18),
  ADD COLUMN "maxMarketOrderQty" DECIMAL(38,18),
  ADD COLUMN "minPrice" DECIMAL(38,18),
  ADD COLUMN "maxPrice" DECIMAL(38,18);
ALTER TABLE "Position" ADD COLUMN "instrumentRules" JSONB;
ALTER TABLE "ValidationRun" ADD COLUMN "executionRules" JSONB;
