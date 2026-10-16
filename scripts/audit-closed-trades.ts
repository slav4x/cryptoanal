import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { createPrismaClient } from "../packages/persistence/src/client";
import { PriceArchiveRepository } from "../packages/persistence/src/price-archive-repository";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { Prisma } from "../packages/persistence/src/generated/prisma/client";
import {
  tradeAcceptanceContract,
  classifyAcceptanceCohort,
  type AcceptanceBoundary,
} from "../packages/application/src/trade-acceptance";
import {
  auditClosedTrade,
  auditJson,
  auditObject,
  type ClosedTradeAuditSource,
} from "../apps/worker/src/closed-trade-audit";
import { captureAuditEvidence, readAuditEvidence } from "./lib/trade-audit-evidence";
import { researchReadOnlyUrl } from "./lib/research-readonly";

const args = process.argv.slice(2).filter((x) => x !== "--");
const root = fileURLToPath(new URL("../", import.meta.url));
const implementationFiles = [
  "scripts/audit-closed-trades.ts",
  "scripts/lib/trade-audit-evidence.ts",
  "scripts/lib/research-readonly.ts",
  "apps/worker/src/closed-trade-audit.ts",
  "apps/worker/src/runtime-trace-replay.ts",
  "apps/worker/src/liquidity-trace-replay.ts",
  "apps/worker/src/runtime-price-processor.ts",
  "apps/worker/src/runtime-recovery.ts",
  "apps/worker/src/causal-recovery.ts",
  "packages/application/src/trade-acceptance.ts",
  "packages/application/src/execution-engine.ts",
  "packages/application/src/execution-profit-protection.ts",
  "packages/application/src/execution-position-exit.ts",
  "packages/application/src/execution-entry-liquidity.ts",
  "packages/application/src/execution-market-data.ts",
  "packages/persistence/src/entry-execution-proof.ts",
  "packages/persistence/src/exit-trigger-proof.ts",
  "packages/persistence/src/liquidity-exit-proof.ts",
  "packages/persistence/src/liquidity-exit-model.ts",
  "packages/persistence/src/funding-proof.ts",
  "packages/persistence/src/price-archive-codec.ts",
];
const implementationHashes = async () =>
  Object.fromEntries(
    await Promise.all(
      implementationFiles.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(resolve(root, file)))
          .digest("hex"),
      ]),
    ),
  );
if (args[0] === "--replay" && args.length === 3) {
  const reportPath = resolve(args[1]!),
    id = args[2]!;
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (hashTracePayload(report.payload) !== report.hash)
    throw new Error("Trade audit report checksum mismatch");
  if (
    hashTracePayload(await implementationHashes()) !==
    hashTracePayload(report.payload.implementation)
  )
    throw new Error("Audit implementation changed; replay requires the pinned revision");
  const item = report.payload.trades.find((t: { positionId: string }) => t.positionId === id);
  if (!item?.evidence) throw new Error("Position evidence not found in report");
  const evidence = await readAuditEvidence(
    join(`${reportPath}.evidence`, hashTracePayload(id)),
    item.evidence.hash,
  );
  const result = await auditClosedTrade(evidence.source, evidence.loaders);
  if (hashTracePayload(auditJson(result)) !== item.resultHash)
    throw new Error("Offline audit result mismatch");
  console.log(
    JSON.stringify({
      matched: true,
      positionId: id,
      status: result.status,
      resultHash: item.resultHash,
    }),
  );
} else {
  const [workspaceId, baselinePath, destination, selectedId, ...extra] = args;
  if (!workspaceId || !baselinePath || !destination || extra.length || !process.env.DATABASE_URL)
    throw new Error(
      "Usage: pnpm runtime:audit-trades <workspace-id> <N01.json> <new-report.json> [position-id] | --replay <report.json> <position-id>",
    );
  const output = resolve(destination);
  try {
    await stat(output);
    throw new Error("Audit report already exists; use a new path");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8"));
  if (
    hashTracePayload(baseline.payload) !== baseline.hash ||
    hashTracePayload(baseline.payload.source) !== baseline.payload.sourceHash ||
    hashTracePayload(tradeAcceptanceContract) !== baseline.payload.contractHash ||
    baseline.payload.source.workspaceId !== workspaceId
  )
    throw new Error("N01 checksum, workspace or contract mismatch");
  const boundary = baseline.payload.derived.boundary as AcceptanceBoundary;
  if (
    boundary.asOf !== baseline.payload.source.asOf ||
    hashTracePayload([...boundary.knownTradeIds].sort()) !==
      hashTracePayload(baseline.payload.source.trades.map((t: { id: string }) => t.id).sort()) ||
    hashTracePayload([...boundary.knownPositionIds].sort()) !==
      hashTracePayload(baseline.payload.source.positions.map((p: { id: string }) => p.id).sort())
  )
    throw new Error("N01 cohort boundary mismatch");
  const implementation = await implementationHashes();
  await mkdir(dirname(output), { recursive: true });
  await mkdir(`${output}.evidence`);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const prisma = createPrismaClient(researchReadOnlyUrl(process.env.DATABASE_URL), {
    maxConnections: 2,
    applicationName: "closed-trade-audit",
    statementTimeoutMs: 20000,
  });
  const archive = new PriceArchiveRepository(prisma);
  const hashRows = async () => {
    const result: Record<string, Array<{ id: string; hash: string }>> = {};
    for (const table of [
      "Trade",
      "ValidationRun",
      "ExecutionRun",
      "PositionExecutionTrace",
    ] as const) {
      const projection =
        table === "ExecutionRun"
          ? "id,md5(context::text)"
          : table === "PositionExecutionTrace"
            ? '"positionId" AS id,"snapshotHash"'
            : "id,md5(to_jsonb(t)::text)";
      result[table] = await prisma.$queryRawUnsafe(
        `SELECT ${projection} AS hash FROM "${table}" t WHERE "workspaceId"=$1 ${table === "ValidationRun" ? "AND status='COMPLETED'" : ""} ORDER BY 1`,
        workspaceId,
      );
    }
    return result;
  };
  try {
    const [mode] = await prisma.$queryRaw<
      Array<{ default_transaction_read_only: string }>
    >`SHOW default_transaction_read_only`;
    if (mode?.default_transaction_read_only !== "on")
      throw new Error("Read-only connection is required");
    const [stamp] = await prisma.$queryRaw<
      Array<{ asOf: Date }>
    >`SELECT clock_timestamp() AS "asOf"`;
    const asOf = stamp!.asOf;
    const before = await hashRows();
    const cohort = await prisma.trade.findMany({
      where: {
        workspaceId,
        environment: "DRY_RUN",
        closedAt: { lte: asOf },
        ...(selectedId ? { positionId: selectedId } : {}),
      },
      orderBy: [{ closedAt: "asc" }, { id: "asc" }],
      select: { id: true, positionId: true },
    });
    if (selectedId && !cohort.length) throw new Error("Closed position not found in workspace");
    const results: Array<Record<string, unknown>> = [],
      errors: Array<{ positionId: string; error: string }> = [];
    for (const item of cohort) {
      try {
        const raw = await prisma.$transaction(
          (tx) =>
            tx.position.findFirstOrThrow({
              where: { id: item.positionId, workspaceId, environment: "DRY_RUN" },
              include: {
                trade: true,
                strategyVersion: true,
                executionRun: true,
                orders: {
                  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                  include: { fills: { orderBy: [{ filledAt: "asc" }, { id: "asc" }] } },
                },
                fundingPayments: { orderBy: [{ settledAt: "asc" }, { id: "asc" }] },
                decisions: {
                  where: { action: "OPEN" },
                  select: { id: true, decidedAt: true, factors: true },
                },
                executionTrace: { include: { records: { orderBy: { id: "asc" } } } },
              },
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 },
        );
        const signalId = auditObject(auditObject(raw.decisions[0]?.factors).runtimeSignal).id;
        const signals =
          typeof signalId === "string"
            ? await prisma.auditEvent.findMany({
                where: { workspaceId, resourceId: signalId, action: "runtime.signal.observed" },
                select: { id: true, metadata: true },
                orderBy: { createdAt: "asc" },
              })
            : [];
        const {
          trade,
          strategyVersion,
          executionRun,
          orders,
          fundingPayments,
          executionTrace,
          ...position
        } = raw;
        const source = auditJson({
          asOf: asOf.toISOString(),
          position,
          trade,
          config: strategyVersion.config,
          configHash: strategyVersion.configHash,
          run: {
            id: executionRun.id,
            strategyVersionId: executionRun.strategyVersionId,
            configHash: executionRun.configHash,
            contextHash: executionRun.contextHash,
            engineVersion: executionRun.engineVersion,
            executionPolicy: executionRun.executionPolicy,
          },
          orders,
          payments: fundingPayments,
          signals,
          entryDecisions: raw.decisions,
          trace: executionTrace,
        }) as ClosedTradeAuditSource;
        const evidence = await captureAuditEvidence(
          join(`${output}.evidence`, hashTracePayload(item.positionId)),
          source,
          {
            events: (cursor, through) => archive.after(position.symbol, cursor, through, 10000),
            funding: (id) =>
              prisma.fundingHistorySnapshot.findUnique({
                where: { id },
                select: { payload: true, payloadHash: true },
              }),
          },
        );
        const result = await auditClosedTrade(source, evidence.loaders);
        const receipt = await evidence.finish();
        const [fingerprint] = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
          'SELECT md5(coalesce("executionPolicy"::text,\'null\')) AS value FROM "Position" WHERE id=$1',
          position.id,
        );
        const group = classifyAcceptanceCohort(boundary, {
          executionRunId: position.executionRunId,
          strategyVersionId: position.strategyVersionId,
          configHash: strategyVersion.configHash,
          policyFingerprint: fingerprint!.value,
          id: position.id,
          tradeId: trade!.id,
          openedAt: position.openedAt.toISOString(),
          createdAt: position.createdAt.toISOString(),
        });
        results.push({
          ...(auditJson(result) as Record<string, unknown>),
          cohort: group,
          resultHash: hashTracePayload(auditJson(result)),
          evidence: receipt,
        });
        console.log(
          JSON.stringify({
            progress: results.length + errors.length,
            total: cohort.length,
            positionId: position.id,
            status: result.status,
            events: result.path.events,
          }),
        );
      } catch (error) {
        errors.push({
          positionId: item.positionId,
          error: error instanceof Error ? error.message : String(error),
        });
        console.log(
          JSON.stringify({
            progress: results.length + errors.length,
            total: cohort.length,
            positionId: item.positionId,
            status: "source-error",
          }),
        );
      }
      await setImmediate();
    }
    const after = await hashRows();
    const immutable = Object.fromEntries(
      Object.entries(before).map(([table, rows]) => {
        const current = new Map(after[table]!.map((r) => [r.id, r.hash]));
        return [
          table,
          { checked: rows.length, unchanged: rows.every((r) => current.get(r.id) === r.hash) },
        ];
      }),
    );
    const payload = {
      version: "cryptoanal-trade-audit-report@1",
      revision,
      implementation,
      workspaceId,
      asOf: asOf.toISOString(),
      baselineHash: baseline.hash,
      boundary,
      selectedPositionId: selectedId ?? null,
      readOnly: true,
      cohort,
      immutable,
      trades: results,
      errors,
      limitations: [
        "Case confirmation requires all original evidence; accounting-only success does not confirm full execution.",
        "Account admission/cash-equity snapshots are not inferred from final Trade or a signal-time context.",
        "Evidence replay uses saved inputs and captured price/funding pages; no working-database read is required.",
        "Missing/ambiguous original paths remain insufficient-data; a negative PnL alone is not an execution violation.",
      ],
    };
    const hash = hashTracePayload(payload);
    await writeFile(output, JSON.stringify({ payload, hash }, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({ output, hash, trades: results.length, errors: errors.length, immutable }),
    );
    if (
      errors.length ||
      Object.values(immutable).some((v) => !v.unchanged) ||
      results.some((r) => r.status === "violation")
    )
      process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
