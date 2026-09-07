import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function dockerText(arguments_, options = {}) {
  const result = await execFileAsync("docker", arguments_, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  });
  return result.stdout.trim();
}

export async function waitForPostgres(container, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await dockerText([
        "exec",
        container,
        "sh",
        "-lc",
        'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
      ]);
      return;
    } catch {
      await delay(500);
    }
  }
  throw new Error(`PostgreSQL in ${container} did not become ready within ${timeoutMs}ms.`);
}

export async function postgresText(container, sql) {
  return dockerText([
    "exec",
    container,
    "sh",
    "-lc",
    `psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc ${shellQuote(sql)}`,
  ]);
}

export async function postgresJson(container, sql) {
  const output = await postgresText(container, sql);
  return output ? JSON.parse(output) : null;
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
