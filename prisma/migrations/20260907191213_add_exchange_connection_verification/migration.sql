-- AlterTable
ALTER TABLE "ExchangeConnection" ADD COLUMN     "accountUid" VARCHAR(64),
ADD COLUMN     "ipBound" BOOLEAN,
ADD COLUMN     "lastVerificationCode" VARCHAR(80),
ADD COLUMN     "lastVerificationMessage" VARCHAR(300),
ADD COLUMN     "permissions" JSONB,
ADD COLUMN     "readOnly" BOOLEAN,
ADD COLUMN     "tradingPermission" BOOLEAN;
