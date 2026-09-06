-- CreateEnum
CREATE TYPE "MarketRegime" AS ENUM ('BULL', 'BEAR', 'NEUTRAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TradingSession" AS ENUM ('ASIA', 'EUROPE', 'US', 'OFF_HOURS', 'UNKNOWN');

-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "entryRegime" "MarketRegime" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "entrySession" "TradingSession" NOT NULL DEFAULT 'UNKNOWN';

-- AlterTable
ALTER TABLE "Trade" ADD COLUMN     "entryRegime" "MarketRegime" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "entrySession" "TradingSession" NOT NULL DEFAULT 'UNKNOWN';
