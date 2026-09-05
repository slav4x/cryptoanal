-- CreateTable
CREATE TABLE "MarketCandle" (
    "symbol" TEXT NOT NULL,
    "interval" TEXT NOT NULL,
    "openTime" TIMESTAMPTZ(3) NOT NULL,
    "open" DECIMAL(38,18) NOT NULL,
    "high" DECIMAL(38,18) NOT NULL,
    "low" DECIMAL(38,18) NOT NULL,
    "close" DECIMAL(38,18) NOT NULL,
    "volume" DECIMAL(38,8) NOT NULL,
    "turnover" DECIMAL(38,8) NOT NULL,

    CONSTRAINT "MarketCandle_pkey" PRIMARY KEY ("symbol","interval","openTime")
);

-- CreateIndex
CREATE INDEX "MarketCandle_symbol_interval_openTime_idx" ON "MarketCandle"("symbol", "interval", "openTime" DESC);

-- AddForeignKey
ALTER TABLE "MarketCandle" ADD CONSTRAINT "MarketCandle_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol") ON DELETE CASCADE ON UPDATE CASCADE;
