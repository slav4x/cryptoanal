-- AlterTable
ALTER TABLE "ExchangeConnection" ALTER COLUMN "encryptedApiKey" DROP NOT NULL,
ALTER COLUMN "encryptedApiSecret" DROP NOT NULL;
