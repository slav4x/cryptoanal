import "dotenv/config";
import { z } from "zod";

const booleanFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const serverConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
  DATABASE_URL: z.url(),
  DASHBOARD_ORIGIN: z.url().default("http://localhost:5173"),
  DEVELOPMENT_WORKSPACE_ID: z.string().min(1).default("development"),
  DEVELOPMENT_ACTOR_ID: z.string().min(1).default("development-operator"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  BYBIT_PUBLIC_BASE_URL: z.url().default("https://api.bybit.com"),
  MARKET_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
  CANDLE_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).default(60_000),
  DEV_ACCESS_ENABLED: booleanFromString,
  DEV_ACCESS_USERNAME: z.string().optional(),
  DEV_ACCESS_PASSWORD_HASH: z.string().optional(),
  DEV_ACCESS_COOKIE_SECRET: z.string().optional(),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = serverConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`Invalid server configuration: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
