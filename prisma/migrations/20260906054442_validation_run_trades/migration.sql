-- CreateTable
CREATE TABLE "ValidationTrade" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "validationRunId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "side" "OrderSide" NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3) NOT NULL,
    "entryPrice" DECIMAL(38,18) NOT NULL,
    "exitPrice" DECIMAL(38,18) NOT NULL,
    "quantity" DECIMAL(38,18) NOT NULL,
    "netPnl" DECIMAL(38,18) NOT NULL,
    "fees" DECIMAL(38,18) NOT NULL,
    "exitReason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidationTrade_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValidationTrade_validationRunId_closedAt_idx" ON "ValidationTrade"("validationRunId", "closedAt" DESC);

-- CreateIndex
CREATE INDEX "ValidationTrade_workspaceId_symbol_closedAt_idx" ON "ValidationTrade"("workspaceId", "symbol", "closedAt" DESC);

-- AddForeignKey
ALTER TABLE "ValidationTrade" ADD CONSTRAINT "ValidationTrade_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationTrade" ADD CONSTRAINT "ValidationTrade_validationRunId_fkey" FOREIGN KEY ("validationRunId") REFERENCES "ValidationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ValidationTrade" ADD CONSTRAINT "ValidationTrade_symbol_fkey" FOREIGN KEY ("symbol") REFERENCES "MarketInstrument"("symbol") ON DELETE RESTRICT ON UPDATE CASCADE;
