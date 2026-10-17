import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { BoundedPgClient } from "./bounded-pg-client";

export type CryptoAnalPrismaClient = PrismaClient;

export function createPrismaClient(
  databaseUrl = process.env.DATABASE_URL,
  options?: {
    maxConnections: number;
    applicationName: string;
    statementTimeoutMs?: number;
    queryTimeoutMs?: number;
    idleTransactionTimeoutMs?: number;
  },
): PrismaClient {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    ...(options
      ? {
          max: options.maxConnections,
          application_name: options.applicationName,
          connectionTimeoutMillis: 2000,
          query_timeout: options.queryTimeoutMs ?? (options.statementTimeoutMs ?? 28000) + 2000,
          Client: BoundedPgClient,
          idle_in_transaction_session_timeout: options.idleTransactionTimeoutMs ?? 15000,
          ...(options.statementTimeoutMs ? { statement_timeout: options.statementTimeoutMs } : {}),
        }
      : {}),
  });
  return new PrismaClient({
    adapter,
    ...(options ? { transactionOptions: { maxWait: 1000, timeout: 10000 } } : {}),
  });
}
