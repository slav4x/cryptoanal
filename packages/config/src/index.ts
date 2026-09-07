import "dotenv/config";
import { z } from "zod";

const developmentAuthSecret = "cryptoanal-development-auth-secret-only";

const serverConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    DATABASE_URL: z.url(),
    DASHBOARD_ORIGIN: z.url().default("http://localhost:5173"),
    DEVELOPMENT_WORKSPACE_ID: z.string().min(1).default("development"),
    AUTH_SECRET: z.string().min(32).default(developmentAuthSecret),
    AUTH_SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24 * 7),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    BYBIT_PUBLIC_BASE_URL: z.url().default("https://api.bybit.com"),
    MARKET_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(30_000),
    CANDLE_POLL_INTERVAL_MS: z.coerce.number().int().min(15_000).default(60_000),
    ACCOUNT_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
    RUNTIME_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
    WATCHDOG_INTERVAL_MS: z.coerce.number().int().min(10_000).default(30_000),
    DRY_RUN_ACCOUNT_ID: z.string().min(1).default("development-dry-run"),
    DRY_RUN_INITIAL_BALANCE: z.coerce.number().nonnegative().default(10_000),
  })
  .superRefine((config, context) => {
    if (config.NODE_ENV === "production" && config.AUTH_SECRET === developmentAuthSecret) {
      context.addIssue({
        code: "custom",
        path: ["AUTH_SECRET"],
        message: "AUTH_SECRET must be explicitly configured in production",
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadServerConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = serverConfigSchema.safeParse(environment);

  if (!result.success) {
    throw new Error(`Invalid server configuration: ${z.prettifyError(result.error)}`);
  }

  return result.data;
}
