import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { loadServerConfig } from "../packages/config/src/index";
import {
  strategyConfigSchema,
  validationExecutionInputSchema,
  validationMetricsSchema,
} from "../packages/contracts/src/index";
import {
  runValidationEngine,
  validationEngineVersion,
  metricProvenanceSchemaVersion,
  enabledFundingPolicy,
  validateFundingDataset,
  type ExecutionFundingDataset,
} from "../packages/application/src/index";
import {
  createPrismaClient,
  ValidationRepository,
  FundingRepository,
  ExecutionPolicyRepository,
  hashTracePayload,
  readPinnedExecutionPolicy,
} from "../packages/persistence/src/index";
import type { Prisma } from "../packages/persistence/src/generated/prisma/client";
import { BybitPublicMarketClient } from "../packages/exchange-bybit/src/index";
import { executionPolicySettingsFromConfig } from "../apps/worker/src/execution-policy-settings";
const output = process.argv.slice(2).filter((a) => a !== "--")[0];
if (!output) throw new Error("Usage: pnpm runtime:revalidate-policy <report.json>");
const config = loadServerConfig(),
  prisma = createPrismaClient(config.DATABASE_URL),
  repo = new ValidationRepository(prisma),
  policyRepo = new ExecutionPolicyRepository(prisma),
  fundRepo = new FundingRepository(prisma);
const market = new BybitPublicMarketClient(config.BYBIT_PUBLIC_BASE_URL, config.BYBIT_PROXY_URL),
  settings = executionPolicySettingsFromConfig(config),
  owner = `policy-revalidation:${randomUUID()}`;
const datasets = new Map<string, Awaited<ReturnType<ValidationRepository["getDatasetSnapshot"]>>>(),
  histories = new Map<string, ExecutionFundingDataset>();
const report: Array<Record<string, unknown>> = [];
const json = (v: unknown) => v as Prisma.InputJsonValue;
try {
  const runs = await prisma.executionRun.findMany({
    where: {
      status: "RUNNING",
      environment: "DRY_RUN",
      deployment: { status: { in: ["RUNNING", "PAUSED"] } },
    },
    orderBy: { id: "asc" },
    include: {
      strategyVersion: { select: { config: true } },
      policyBaseline: { include: { validationRun: true } },
    },
  });
  for (const run of runs) {
    let jobId: string | null = null,
      newId: string | null = null;
    try {
      const sourceId = (run.context as { validation?: { runId?: string } }).validation?.runId;
      if (!sourceId) throw new Error("No source baseline");
      const source = await prisma.validationRun.findUniqueOrThrow({ where: { id: sourceId } });
      if (!source.datasetSnapshotId) throw new Error("Source baseline has no retained dataset");
      const runtimePolicy = await policyRepo.pinRun(run.id, settings),
        existing = run.policyBaseline?.validationRun;
      if (
        existing?.engineVersion === validationEngineVersion &&
        readPinnedExecutionPolicy(existing.executionPolicy)?.profileHash ===
          runtimePolicy.profileHash
      ) {
        report.push({
          executionRunId: run.id,
          sourceRunId: sourceId,
          validationRunId: existing.id,
          status: "reused",
          verdict: existing.verdict,
        });
        continue;
      }
      const key = `${run.workspaceId}:${source.datasetSnapshotId}`;
      let dataset = datasets.get(key);
      if (!dataset) {
        dataset = await repo.getDatasetSnapshot(run.workspaceId, source.datasetSnapshotId);
        datasets.set(key, dataset);
      }
      if (!dataset) throw new Error("Source snapshot missing");
      const strategy = strategyConfigSchema.parse(run.strategyVersion.config),
        initialCapital = runtimePolicy.payload.settings.accountSafety.initialBalance;
      const input = {
        ...validationExecutionInputSchema.parse(source.input),
        initialCapital: String(initialCapital),
      };
      const created = await prisma.$transaction(async (tx) => {
        const validation = await tx.validationRun.create({
          data: {
            workspaceId: run.workspaceId,
            strategyId: source.strategyId,
            strategyVersionId: run.strategyVersionId,
            kind: source.kind,
            status: "RUNNING",
            datasetId: source.datasetId,
            datasetSnapshotId: dataset!.id,
            datasetAsOf: dataset!.endsAt,
            engineVersion: validationEngineVersion,
            configHash: run.configHash,
            input: json(input),
            createdByActorId: owner,
            startedAt: new Date(),
          },
        });
        if (source.kind === "HOLDOUT") throw new Error("Holdout unsupported");
        const job = await tx.job.create({
          data: {
            workspaceId: run.workspaceId,
            kind: source.kind,
            status: "RUNNING",
            input: { validationRunId: validation.id },
            idempotencyKey: randomUUID(),
            lockedBy: owner,
            lockedAt: new Date(),
            startedAt: new Date(),
            createdByActorId: owner,
          },
        });
        return { validation, job };
      });
      jobId = created.job.id;
      newId = created.validation.id;
      const lease = { workspaceId: run.workspaceId, runId: newId, jobId, workerId: owner };
      const instruments = await repo.pinInstrumentRules({
        ...lease,
        symbols: dataset.symbols as string[],
      });
      const interval =
        { "5m": 5, "15m": 15, "30m": 30, "1h": 60, "4h": 240 }[strategy.universe.timeframe] * 60000;
      const throughAt = new Date(+dataset.endsAt + interval),
        startsAt = dataset.startsAt,
        symbols = dataset.symbols as string[];
      const historyKey = hashTracePayload({
        symbols,
        startsAt: startsAt.toISOString(),
        throughAt: throughAt.toISOString(),
      });
      let funding = histories.get(historyKey);
      if (!funding && existing?.datasetSnapshotId === dataset.id) {
        const retained = await repo.getFundingSnapshot(run.workspaceId, existing.id);
        if (retained) {
          validateFundingDataset(retained.payload, symbols, startsAt, throughAt);
          funding = retained.payload;
          histories.set(historyKey, funding);
        }
      }
      if (!funding) {
        const events: ExecutionFundingDataset["events"] = [];
        for (const symbol of symbols) {
          events.push(
            ...(await market.getLinearFundingHistory(
              symbol,
              startsAt,
              throughAt,
              AbortSignal.timeout(120000),
            )),
          );
          if (!(await repo.updateProgress(jobId, owner, 50)))
            throw new Error("Revalidation lease lost");
        }
        funding = {
          version: 1,
          policy: enabledFundingPolicy,
          symbols,
          startsAt: startsAt.toISOString(),
          throughAt: throughAt.toISOString(),
          coverage: "complete",
          events,
        };
        histories.set(historyKey, funding);
        await fundRepo.saveHistory(funding);
      }
      const fundingSnapshot = await repo.pinFundingSnapshot({ ...lease, data: funding });
      const policy = await policyRepo.pinValidation({
        ...lease,
        settings: runtimePolicy.payload.settings,
        initialCapital,
      });
      const result = runValidationEngine({
        config: strategy,
        executionPolicy: policy.payload,
        instrumentRules: instruments.instruments,
        funding,
        candles: dataset.candles.map((c) => ({
          ...c,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          turnover: Number(c.turnover),
        })),
        initialCapital,
        kind: input.kind === "walk-forward" ? "walk-forward" : "backtest",
        walkForward: input.walkForward,
      });
      const metrics = validationMetricsSchema.parse({
        ...result.metrics,
        gateReasons: result.gateReasons,
        provenance: {
          schemaVersion: metricProvenanceSchemaVersion,
          environment: input.kind,
          exchange: dataset.exchange,
          source: dataset.source,
          instrumentType: dataset.instrumentType,
          datasetVersion: `dataset-snapshot@${dataset.schemaVersion}`,
          datasetId: dataset.id,
          datasetHash: dataset.contentHash,
          configVersion: `strategy-config@${strategy.schemaVersion}`,
          configHash: run.configHash,
          engineVersion: validationEngineVersion,
          asOf: dataset.endsAt.toISOString(),
          freshness: "immutable",
          fundingPolicy: { ...enabledFundingPolicy, snapshotHash: fundingSnapshot.hash },
          executionPolicy: {
            ...policy.payload,
            hash: policy.hash,
            profileHash: policy.profileHash,
          },
          instrumentRules: {
            mode: "fixed-snapshot-scenario",
            observedAt: instruments.capturedAt,
            symbols,
          },
          symbols,
          timeframe: strategy.universe.timeframe,
          startDate: input.dataset.startDate,
          endDate: input.dataset.endDate,
          candleCount: dataset.candleCount,
        },
      });
      await repo.complete({
        ...lease,
        engineVersion: validationEngineVersion,
        datasetSnapshotId: dataset.id,
        metrics: json(metrics),
        verdict: ({ passed: "PASSED", warning: "WARNING", failed: "FAILED" } as const)[
          result.verdict
        ],
        trades: result.trades.map((t) => ({
          symbol: t.symbol,
          side: t.side === "long" ? "BUY" : "SELL",
          openedAt: new Date(t.openedAt),
          closedAt: new Date(t.closedAt),
          entryPrice: String(t.entryPrice),
          exitPrice: String(t.exitPrice),
          quantity: String(t.quantity),
          netPnl: String(t.netPnl),
          fees: String(t.fees),
          funding: String(t.funding ?? 0),
          exitReason: t.exitReason,
        })),
      });
      await policyRepo.linkBaseline(run.id, newId);
      const item = {
        executionRunId: run.id,
        sourceRunId: sourceId,
        validationRunId: newId,
        status: "created",
        verdict: result.verdict,
        trades: result.metrics.trades,
        netPnl: result.metrics.netPnl,
        funding: result.metrics.totalFunding ?? 0,
        sourceDatasetHash: dataset.contentHash,
        policyHash: policy.hash,
        profileHash: policy.profileHash,
        comparison: "scenario-only",
        gateReasons: result.gateReasons,
      };
      report.push(item);
      console.log(JSON.stringify(item));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown revalidation error";
      if (newId && jobId)
        await prisma.$transaction([
          prisma.validationRun.updateMany({
            where: { id: newId, status: "RUNNING" },
            data: {
              status: "FAILED",
              verdict: "FAILED",
              failureCode: "POLICY_REVALIDATION_FAILED",
              failureMessage: message.slice(0, 500),
              completedAt: new Date(),
            },
          }),
          prisma.job.updateMany({
            where: { id: jobId, status: "RUNNING", lockedBy: owner },
            data: {
              status: "FAILED",
              failureCode: "POLICY_REVALIDATION_FAILED",
              failureMessage: message.slice(0, 500),
              completedAt: new Date(),
              lockedBy: null,
              lockedAt: null,
            },
          }),
        ]);
      report.push({ executionRunId: run.id, validationRunId: newId, status: "error", message });
      console.log(JSON.stringify(report.at(-1)));
    }
  }
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        asOf: new Date().toISOString(),
        engineVersion: validationEngineVersion,
        mode: "reference-only",
        oldResultsUnchanged: true,
        report,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (report.some((r) => r.status === "error")) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
