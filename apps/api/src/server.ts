import { loadServerConfig } from "@cryptoanal/config";
import { createPrismaClient } from "@cryptoanal/persistence";
import { createApp } from "./app";

const config = loadServerConfig();
const prisma = createPrismaClient(config.DATABASE_URL);
const app = await createApp({ config, prisma });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down API");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
