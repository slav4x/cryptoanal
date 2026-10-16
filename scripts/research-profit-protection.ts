import "dotenv/config";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  createPrismaClient,
  PriceArchiveRepository,
  ValidationRepository,
  hashTracePayload,
  readPinnedExecutionPolicy,
} from "../packages/persistence/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  executionInitialRiskDistance,
  type ExecutionCandle,
  type ExecutionPosition,
  type ExecutionSettlement,
} from "../packages/application/src/execution-engine";
import { readExecutionInstrumentRules } from "../packages/application/src/execution-instrument";
import { validationEngineVersion } from "../packages/application/src/validation-engine";
import { createTradeExcursions } from "../packages/application/src/trade-excursions";
import {
  protectionStudyCandidates,
  protectionStudyProtocol,
  protectionStudyVersion,
  runProtectionStudy,
  comparePairedProtectionExits,
} from "../packages/application/src/protection-study";
import { replayRuntimeTrace } from "../apps/worker/src/runtime-trace-replay";
import { researchReadOnlyUrl } from "./lib/research-readonly";

const [workspaceId, destination, ...extra] = process.argv.slice(2).filter((a) => a !== "--");
if (!workspaceId || !destination || extra.length || !process.env.DATABASE_URL)
  throw new Error("Usage: pnpm runtime:research-protection <workspace-id> <new-report.json>");
const output = resolve(destination);
const root = fileURLToPath(new URL("../", import.meta.url));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceFiles = [
  "scripts/research-profit-protection.ts",
  "scripts/lib/research-readonly.ts",
  "packages/application/src/trade-excursions.ts",
  "packages/application/src/protection-study.ts",
  "packages/application/src/execution-engine.ts",
  "packages/application/src/execution-policy-simulation.ts",
  "packages/application/src/execution-profit-protection.ts",
];
const implementation = Object.fromEntries(
  await Promise.all(
    sourceFiles.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(resolve(root, path)))
        .digest("hex"),
    ]),
  ),
);
try {
  await stat(output);
  throw new Error("Research output already exists; use a new path");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const prisma = createPrismaClient(researchReadOnlyUrl(process.env.DATABASE_URL), {
  maxConnections: 2,
  applicationName: "protection-research",
  statementTimeoutMs: 30000,
});
const archive = new PriceArchiveRepository(prisma),
  repo = new ValidationRepository(prisma);
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v)));
async function hashes() {
  const tables = ["Trade", "ValidationRun", "ExecutionRun", "PositionExecutionTrace"] as const;
  const result: Record<string, Array<{ id: string; hash: string }>> = {};
  for (const table of tables) {
    const select =
      table === "ExecutionRun"
        ? "id,md5(context::text)"
        : table === "PositionExecutionTrace"
          ? '"positionId" AS id,"snapshotHash"'
          : "id,md5(to_jsonb(t)::text)";
    result[table] = await prisma.$queryRawUnsafe(
      `SELECT ${select} AS hash FROM "${table}" t WHERE "workspaceId"=$1 ${table === "ValidationRun" ? "AND status='COMPLETED'" : ""} ORDER BY 1`,
      workspaceId,
    );
  }
  return result;
}
type TradeMeasurement = {
  tradeId: string;
  positionId: string;
  executionRunId: string;
  strategyVersionId: string;
  configHash: string;
  strategy: string;
  symbol: string;
  side: "long" | "short";
  timeframe: string;
  openedAt: string;
  closedAt: string;
  holdingMs: number;
  netPnl: number;
  fees: number;
  funding: number;
  exitReason: string;
  models: {
    traceEngine: string | null;
    runEngine: string;
    exit: string;
    executionPolicyHash: string | null;
    funding: string;
    recovery: string | null;
    positionExit: string;
  };
  quality: string;
  issues: string[];
  excursions: ReturnType<ReturnType<typeof createTradeExcursions>["finish"]> | null;
  trace?: {
    snapshotHash: string;
    replay: string;
    continuity: string;
    events: number;
    fullFromEntry: boolean;
    streamChanges: number;
    riskBasis: string;
  };
  error?: string;
};
const errors: Array<{ resource: string; message: string }> = [];
try {
  const [mode] = await prisma.$queryRaw<
    Array<{ default_transaction_read_only: string }>
  >`SHOW default_transaction_read_only`;
  if (mode?.default_transaction_read_only !== "on")
    throw new Error("Read-only research connection is required");
  const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  const asOf = clock!.now,
    before = await hashes();
  const positions = await prisma.position.findMany({
    where: { workspaceId, environment: "DRY_RUN", trade: { closedAt: { lte: asOf } } },
    orderBy: [{ openedAt: "asc" }, { id: "asc" }],
    include: {
      trade: true,
      strategyVersion: { include: { strategy: { select: { name: true } } } },
      executionRun: { select: { engineVersion: true } },
      executionTrace: true,
    },
  });
  const measurements: TradeMeasurement[] = [];
  for (const p of positions) {
    const trade = p.trade!,
      config = strategyConfigSchema.parse(p.strategyVersion.config),
      trace = p.executionTrace;
    const base = {
      tradeId: trade.id,
      positionId: p.id,
      executionRunId: p.executionRunId,
      strategyVersionId: p.strategyVersionId,
      configHash: p.strategyVersion.configHash,
      strategy: p.strategyVersion.strategy.name,
      symbol: p.symbol,
      side: p.side === "BUY" ? ("long" as const) : ("short" as const),
      timeframe: config.universe.timeframe,
      openedAt: trade.openedAt.toISOString(),
      closedAt: trade.closedAt.toISOString(),
      holdingMs: +trade.closedAt - +trade.openedAt,
      netPnl: Number(trade.netPnl),
      fees: Number(trade.fees),
      funding: Number(trade.funding),
      exitReason: trade.exitReason,
      models: {
        traceEngine:
          (trace?.snapshot as { executionEngineVersion?: string } | undefined)
            ?.executionEngineVersion ?? null,
        runEngine: p.executionRun.engineVersion,
        exit: (p.exitPolicy as { version?: string } | null)?.version ?? "legacy",
        executionPolicyHash: (p.executionPolicy as { hash?: string } | null)?.hash ?? null,
        funding: (p.fundingPolicy as { version?: string } | null)?.version ?? "disabled",
        recovery: p.recoveryModel,
        positionExit: (p.positionExitPolicy as { version?: string } | null)?.version ?? "legacy",
      },
    };
    if (!trace) {
      measurements.push({
        ...base,
        excursions: null,
        quality: "unavailable",
        issues: ["NO_RETAINED_TRACE"],
      });
      continue;
    }
    try {
      if (trace.retainUntil && trace.retainUntil <= asOf)
        throw new Error("Trace retention expired");
      const records = await prisma.positionTraceRecord.findMany({
        where: { positionId: p.id },
        orderBy: { id: "asc" },
      });
      const replay = await replayRuntimeTrace({
        snapshot: trace.snapshot,
        snapshotHash: trace.snapshotHash,
        fullFromEntry: trace.fullFromEntry,
        startEventId: trace.startEventId,
        endEventId: trace.endEventId ?? p.priceEventId ?? trace.startEventId,
        expectedEventCount: trace.eventCount,
        records,
        loadEvents: (cursor, through) => archive.after(p.symbol, cursor, through, 10000),
        loadFundingSnapshot: (id) =>
          prisma.fundingHistorySnapshot.findUnique({
            where: { id },
            select: { payload: true, payloadHash: true },
          }),
        trade: {
          exitReason: trade.exitReason,
          closedAt: trade.closedAt,
          averageExitPrice: trade.averageExitPrice.toFixed(),
          grossPnl: trade.grossPnl.toFixed(),
          netPnl: trade.netPnl.toFixed(),
          fees: trade.fees.toFixed(),
          slippage: trade.slippage.toFixed(),
          funding: trade.funding.toFixed(),
        },
      });
      const riskBasis = {
        entryPrice: Number(p.entryPrice),
        side: base.side,
        ...(p.instrumentRules
          ? { instrumentRules: readExecutionInstrumentRules(p.instrumentRules)! }
          : {}),
      } as ExecutionPosition;
      const observer = createTradeExcursions({
        side: base.side,
        entryPrice: Number(p.entryPrice),
        initialRiskDistance: Number(executionInitialRiskDistance(riskBasis, config)),
        openedAt: p.openedAt,
        throughAt: trade.closedAt,
      });
      let cursor = trace.startEventId - 1n;
      const end = trace.endEventId ?? p.priceEventId ?? trace.startEventId;
      let stream: string | null = null,
        streamChanges = 0;
      for (;;) {
        const events = await archive.after(p.symbol, cursor, end, 10000);
        if (!events.length) break;
        for (const event of events) {
          if (stream !== null && stream !== event.streamId) streamChanges++;
          stream = event.streamId;
          observer.observe({ price: Number(event.price), observedAt: event.observedAt });
        }
        cursor = events.at(-1)!.id;
        if (cursor >= end) break;
      }
      const issues = [
        ...(!trace.fullFromEntry ? ["MISSING_ENTRY_PREFIX"] : []),
        ...(replay.status !== "matched" ? ["ORIGINAL_REPLAY_NOT_MATCHED"] : []),
        ...(replay.continuity !== "continuous" ? ["RECOVERY_OR_PRICE_GAP"] : []),
        ...(streamChanges ? ["STREAM_BOUNDARY"] : []),
        ...(cursor < end ? ["MISSING_JOURNAL_TAIL"] : []),
      ];
      const excursions = observer.finish(
        Number(trade.averageExitPrice),
        issues.length === 0,
        issues,
      );
      measurements.push({
        ...base,
        quality: excursions.quality,
        issues: excursions.issues,
        excursions,
        trace: {
          snapshotHash: trace.snapshotHash,
          replay: replay.status,
          continuity: replay.continuity,
          events: replay.events,
          fullFromEntry: trace.fullFromEntry,
          streamChanges,
          riskBasis: p.instrumentRules ? "pinned-initial-stop@1" : "legacy-config-initial-stop@1",
        },
      });
      console.log(`Measured ${p.id}: ${excursions.quality}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      measurements.push({
        ...base,
        quality: "unavailable",
        issues: ["TRACE_VERIFICATION_FAILED"],
        excursions: null,
        error: message,
      });
      errors.push({ resource: p.id, message });
    }
  }
  const groups = new Map<string, typeof measurements>();
  for (const row of measurements) {
    const key = JSON.stringify([
      row.strategyVersionId,
      row.executionRunId,
      row.symbol,
      row.side,
      row.timeframe,
      row.models,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const profiles = await prisma.executionRun.findMany({
    where: { workspaceId, status: "RUNNING", environment: "DRY_RUN" },
    orderBy: { id: "asc" },
    include: {
      strategyVersion: { include: { strategy: { select: { name: true } } } },
      policyBaseline: { include: { validationRun: true } },
    },
  });
  const datasets = new Map<
    string,
    { candles: ExecutionCandle[]; id: string; contentHash: string; startsAt: Date; endsAt: Date }
  >();
  const studies = [];
  for (const profile of profiles) {
    try {
      const baseline = profile.policyBaseline?.validationRun;
      if (!baseline?.datasetSnapshotId) throw new Error("Retained baseline dataset is required");
      const original = readPinnedExecutionPolicy(baseline.executionPolicy),
        live = readPinnedExecutionPolicy(profile.executionPolicy);
      if (!original || !live || original.profileHash !== live.profileHash)
        throw new Error("Baseline and runtime policy mismatch");
      let data = datasets.get(baseline.datasetSnapshotId);
      if (!data) {
        const retained = await repo.getDatasetSnapshot(workspaceId, baseline.datasetSnapshotId);
        if (!retained) throw new Error("Dataset snapshot is missing");
        data = {
          id: retained.id,
          contentHash: retained.contentHash,
          startsAt: retained.startsAt,
          endsAt: retained.endsAt,
          candles: retained.candles.map((c) => ({
            symbol: c.symbol,
            openTime: c.openTime,
            open: Number(c.open),
            high: Number(c.high),
            low: Number(c.low),
            close: Number(c.close),
            turnover: Number(c.turnover),
          })),
        };
        datasets.set(data.id, data);
      }
      const rules = baseline.executionRules as unknown as {
        payload: {
          instruments: NonNullable<Parameters<typeof runProtectionStudy>[0]["instrumentRules"]>;
        };
        hash: string;
      };
      if (!rules || hashTracePayload(rules.payload) !== rules.hash)
        throw new Error("Instrument scenario checksum mismatch");
      const funding = await repo.getFundingSnapshot(workspaceId, baseline.id);
      if (!funding) throw new Error("Retained funding snapshot is required");
      console.log(
        `Research ${profile.strategyVersion.strategy.name}: ${data.candles.length} candles`,
      );
      const result = runProtectionStudy({
        executionPolicy: original.payload,
        initialCapital: original.payload.settings.accountSafety.initialBalance,
        candles: data.candles,
        instrumentRules: rules.payload.instruments,
        funding: funding.payload,
      });
      const subgroupKeys = [
        ...new Set(
          [...result.holdoutTrades, ...result.baselineHoldoutTrades].map((t) =>
            JSON.stringify([t.symbol, t.side]),
          ),
        ),
      ];
      const subgroups = subgroupKeys.map((key) => {
        const filter = (t: ExecutionSettlement) => JSON.stringify([t.symbol, t.side]) === key;
        const current = result.baselineHoldoutTrades.filter(filter),
          candidate = result.holdoutTrades.filter(filter);
        const summary = (trades: ExecutionSettlement[]) => ({
          trades: trades.length,
          netPnl: trades.reduce((n, t) => n + t.netPnl, 0),
          fees: trades.reduce((n, t) => n + t.fees, 0),
          funding: trades.reduce((n, t) => n + (t.funding ?? 0), 0),
        });
        const liveTraces = measurements.filter(
          (m) =>
            m.strategyVersionId === profile.strategyVersionId &&
            JSON.stringify([m.symbol, m.side]) === key &&
            m.quality === "complete-observed-path",
        ).length;
        return {
          symbol: JSON.parse(key)[0] as string,
          side: JSON.parse(key)[1] as string,
          timeframe: original.payload.strategy.universe.timeframe,
          current: summary(current),
          candidate: summary(candidate),
          pairing: comparePairedProtectionExits(current, candidate),
          completeCurrentRuntimeTraces: liveTraces,
          sufficientHoldoutTrades:
            Math.min(current.length, candidate.length) >=
            protectionStudyProtocol.minimumTrades.holdout,
          drawdownScope: "parent-virtual-account-only",
        };
      });
      const { holdoutTrades, baselineHoldoutTrades, ...summary } = result;
      studies.push({
        executionRunId: profile.id,
        strategyVersionId: profile.strategyVersionId,
        strategy: profile.strategyVersion.strategy.name,
        configHash: profile.configHash,
        sources: {
          validationRunId: baseline.id,
          originalEngineVersion: baseline.engineVersion,
          datasetId: data.id,
          datasetHash: data.contentHash,
          fundingHash: funding.hash,
          instrumentRulesHash: rules.hash,
          originalPolicyHash: original.hash,
          runtimePolicyHash: live.hash,
        },
        ...summary,
        holdoutTrades,
        baselineHoldoutTrades,
        subgroups,
        decision: {
          action: "retain-current",
          applied: false,
          acceptedParameters: live.payload.settings.profitProtection,
          acceptedStrategyVersionId: profile.strategyVersionId,
          acceptedValidationRunId: baseline.id,
          reasons: [
            ...result.statisticalProblems,
            "PREVIOUSLY_USED_HISTORICAL_DATA",
            "NO_INDEPENDENT_FORWARD_CANDIDATE_L1_SAMPLE",
            ...(subgroups.some((g) => !g.sufficientHoldoutTrades)
              ? ["PER_SYMBOL_SIDE_SAMPLE_INSUFFICIENT"]
              : []),
          ],
        },
      });
      console.log(
        `Research completed: ${profile.strategyVersion.strategy.name}, training choice=${result.selected}, retain-current`,
      );
      await setImmediate();
    } catch (error) {
      errors.push({
        resource: profile.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const after = await hashes();
  const immutable = Object.fromEntries(
    Object.entries(before).map(([table, rows]) => {
      const current = new Map(after[table]!.map((r) => [r.id, r.hash]));
      return [
        table,
        { checked: rows.length, unchanged: rows.every((r) => current.get(r.id) === r.hash) },
      ];
    }),
  );
  if (Object.values(immutable).some((v) => !v.unchanged))
    errors.push({
      resource: "source-cohort",
      message: "Source records changed while research was running",
    });
  const counts = measurements.reduce<Record<string, number>>((r, row) => {
    r[row.quality] = (r[row.quality] ?? 0) + 1;
    return r;
  }, {});
  const distribution = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b),
      n = sorted.length;
    return {
      count: n,
      median: n ? (sorted[Math.floor((n - 1) / 2)]! + sorted[Math.ceil((n - 1) / 2)]!) / 2 : null,
      p90: n ? sorted[Math.ceil(n * 0.9) - 1]! : null,
    };
  };
  const payload = json({
    version: protectionStudyVersion,
    revision,
    implementation,
    asOf: asOf.toISOString(),
    generatedAt: new Date().toISOString(),
    workspaceId,
    engineVersion: validationEngineVersion,
    readOnly: mode.default_transaction_read_only,
    protocol: protectionStudyProtocol,
    candidates: protectionStudyCandidates,
    protocolHash: hashTracePayload({
      protocol: protectionStudyProtocol,
      candidates: protectionStudyCandidates,
    }),
    sourceCohortHash: hashTracePayload(before),
    immutable,
    counts,
    trades: measurements,
    tradeGroups: [...groups.values()].map((rows) => ({
      completeMetrics: {
        mfeR: distribution(
          rows
            .filter((r) => r.quality === "complete-observed-path")
            .map((r) => r.excursions!.mfeR!),
        ),
        maeR: distribution(
          rows
            .filter((r) => r.quality === "complete-observed-path")
            .map((r) => r.excursions!.maeR!),
        ),
        givebackAtExitR: distribution(
          rows
            .filter((r) => r.quality === "complete-observed-path")
            .map((r) => r.excursions!.givebackAtExitR!),
        ),
      },
      holdingMs: distribution(rows.map((r) => r.holdingMs)),
      strategyVersionId: rows[0]!.strategyVersionId,
      executionRunId: rows[0]!.executionRunId,
      strategy: rows[0]!.strategy,
      symbol: rows[0]!.symbol,
      side: rows[0]!.side,
      timeframe: rows[0]!.timeframe,
      models: rows[0]!.models,
      trades: rows.length,
      completeObserved: rows.filter((r) => r.quality === "complete-observed-path").length,
      observedLowerBounds: rows.filter((r) => r.quality === "observed-lower-bound").length,
      unavailable: rows.filter((r) => r.quality === "unavailable").length,
    })),
    studies,
    errors,
    limitations: [
      "No runtime, strategy, Trade or completed validation writes",
      "No aggregate real portfolio PnL across virtual strategy accounts",
      "Historical holdout was not unseen by previous strategy selection",
      "No variant is applied from OHLC-only evidence",
      "Legacy missing path metrics stay unavailable",
      "Open positions are not counted as closed independent trials",
    ],
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ payload, hash: hashTracePayload(payload) }, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify(
      {
        output,
        hash: hashTracePayload(payload),
        trades: measurements.length,
        counts,
        strategies: studies.length,
        errors,
        immutable,
      },
      null,
      2,
    ),
  );
  if (errors.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
