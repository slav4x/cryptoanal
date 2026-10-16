import { resolve, join } from "node:path";
import { readMonitorJson } from "./lib/trade-audit-monitor";
const [store, ...extra] = process.argv.slice(2).filter((x) => x !== "--");
if (!store || extra.length) throw new Error("Usage: runtime:audit-status <store-dir>");
const heartbeat = await readMonitorJson<{
  observedAt: string;
  phase: string;
  root: string;
  error?: string | null;
}>(join(resolve(store), "heartbeat.json"));
const report = await readMonitorJson<{
  asOf: string;
  totals: unknown;
  source: unknown;
  oldestPendingAgeMs: number;
}>(join(resolve(store), heartbeat.root, "report.json"));
const ageMs = Math.max(0, Date.now() - Date.parse(heartbeat.observedAt));
console.log(
  JSON.stringify(
    {
      process: {
        phase: heartbeat.phase,
        fresh: ageMs <= 45000 && !["stopped", "failed"].includes(heartbeat.phase),
        heartbeatAgeMs: ageMs,
        error: heartbeat.error ?? null,
      },
      report,
    },
    null,
    2,
  ),
);
