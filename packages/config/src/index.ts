import "dotenv/config";
import { z } from "zod";

const developmentAuthSecret = "cryptoanal-development-auth-secret-only";
const developmentExchangeCredentialsKey = "Y3J5cHRvYW5hbC1kZXYtY3JlZGVudGlhbHMta2V5ISE=";

const serverConfigSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3100),
    DATABASE_URL: z.url(),
    DASHBOARD_ORIGIN: z.url().default("http://localhost:5173"),
    DEVELOPMENT_WORKSPACE_ID: z.string().min(1).default("development"),
    AUTH_SECRET: z.string().min(32).default(developmentAuthSecret),
    EXCHANGE_CREDENTIALS_KEY: z
      .string()
      .refine((value) => {
        const decoded = Buffer.from(value, "base64");
        return decoded.length === 32 && decoded.toString("base64") === value;
      }, "EXCHANGE_CREDENTIALS_KEY must be a base64-encoded 32-byte key")
      .default(developmentExchangeCredentialsKey),
    AUTH_SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .default(24 * 7),
    AUTH_MAX_ACTIVE_SESSIONS: z.coerce.number().int().min(1).max(50).default(10),
    AUTH_RECOVERY_TTL_MINUTES: z.coerce
      .number()
      .int()
      .min(10)
      .max(24 * 60)
      .default(60),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    BYBIT_PUBLIC_BASE_URL: z.url().default("https://api.bybit.com"),
    BYBIT_DEMO_BASE_URL: z.url().default("https://api-demo.bybit.com"),
    BYBIT_LIVE_BASE_URL: z.url().default("https://api.bybit.com"),
    BYBIT_PRIVATE_REQUEST_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(30_000)
      .default(10_000),
    EXCHANGE_VERIFICATION_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    EXCHANGE_VERIFICATION_RETRY_MINUTES: z.coerce.number().int().min(1).max(1_440).default(15),
    EXCHANGE_VERIFICATION_LEASE_SECONDS: z.coerce.number().int().min(30).max(600).default(120),
    EXCHANGE_VERIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
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
    if (
      config.NODE_ENV === "production" &&
      config.EXCHANGE_CREDENTIALS_KEY === developmentExchangeCredentialsKey
    ) {
      context.addIssue({
        code: "custom",
        path: ["EXCHANGE_CREDENTIALS_KEY"],
        message: "EXCHANGE_CREDENTIALS_KEY must be explicitly configured in production",
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
