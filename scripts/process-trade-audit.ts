import { captureRetainedEvidence } from "./lib/retained-audit-evidence";
import "dotenv/config";
import { readFile, writeFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createPrismaClient } from "../packages/persistence/src/client";
import { PriceArchiveRepository } from "../packages/persistence/src/price-archive-repository";
import { hashTracePayload } from "../packages/persistence/src/position-trace";
import { classifyAcceptanceCohort } from "../packages/application/src/trade-acceptance";
import { auditJson } from "../apps/worker/src/closed-trade-audit";
import { auditRetainedTrade } from "../apps/worker/src/retained-trade-audit";
import { readAuditEvidence } from "./lib/trade-audit-evidence";
import { researchReadOnlyUrl } from "./lib/research-readonly";
import {
  captureRetainedAuditSource,
  readAcceptanceBaseline,
  retainedAuditImplementation,
} from "./lib/retained-audit-source";

const args = process.argv.slice(2).filter((x) => x !== "--");
if (args[0] === "--replay" && args.length === 2) {
  const root = resolve(args[1]!);
  if ((await stat(join(root, "result.json"))).size > 32 * 1024 * 1024)
    throw new Error("Retained result byte budget exceeded");
  const saved = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
  if (hashTracePayload(saved.payload) !== saved.hash)
    throw new Error("Retained result checksum mismatch");
  const implementation = await retainedAuditImplementation();
  if (implementation.hash !== saved.payload.implementation.hash)
    throw new Error("Retained audit implementation changed");
  const evidence = await readAuditEvidence(join(root, "evidence"), saved.payload.evidence.hash);
  const result = await auditRetainedTrade(evidence.source, evidence.loaders);
  if (hashTracePayload(auditJson(result)) !== saved.payload.resultHash)
    throw new Error("Retained replay result mismatch");
  console.log(
    JSON.stringify({
      matched: true,
      positionId: result.positionId,
      resultHash: saved.payload.resultHash,
      status: result.status,
    }),
  );
} else {
  const [workspaceId, baselinePath, destination, positionId, ...extra] = args;
  if (
    !workspaceId ||
    !baselinePath ||
    !destination ||
    !positionId ||
    extra.length ||
    !process.env.DATABASE_URL
  )
    throw new Error(
      "Usage: process-trade-audit <workspace> <N01.json> <new-attempt-dir> <position-id> | --replay <attempt-dir>",
    );
  const output = resolve(destination),
    baseline = await readAcceptanceBaseline(resolve(baselinePath), workspaceId),
    implementation = await retainedAuditImplementation();
  const prisma = createPrismaClient(researchReadOnlyUrl(process.env.DATABASE_URL), {
    maxConnections: 1,
    applicationName: "trade-audit-reader",
    statementTimeoutMs: 20000,
  });
  try {
    const [mode] = await prisma.$queryRaw<
      Array<{ default_transaction_read_only: string }>
    >`SHOW default_transaction_read_only`;
    if (mode?.default_transaction_read_only !== "on") throw new Error("Read-only source required");
    const { source, policyFingerprint, modelFingerprint } = await captureRetainedAuditSource(
      prisma,
      workspaceId,
      positionId,
    );
    const archive = new PriceArchiveRepository(prisma);
    const evidence = await captureRetainedEvidence(join(output, "evidence"), source, {
      events: async (cursor, through) => {
        await delay(10);
        return archive.after(source.position.symbol, cursor, through, 10000);
      },
      funding: (id) =>
        prisma.fundingHistorySnapshot.findUnique({
          where: { id },
          select: { payload: true, payloadHash: true },
        }),
    });
    const result = await auditRetainedTrade(source, evidence.loaders),
      receipt = await evidence.finish();
    const payload = {
      version: "cryptoanal-retained-result@1",
      baselineHash: baseline.hash,
      implementation,
      cohort: classifyAcceptanceCohort(baseline.boundary, {
        id: positionId,
        tradeId: source.trade.id,
        executionRunId: source.run.id,
        strategyVersionId: source.position.strategyVersionId,
        configHash: source.configHash,
        policyFingerprint,
        openedAt: source.position.openedAt,
        createdAt: source.position.createdAt,
      }),
      coverageGroup: {
        executionRunId: source.run.id,
        strategyVersionId: source.position.strategyVersionId,
        configHash: source.configHash,
        symbol: source.position.symbol,
        side: source.position.side,
        timeframe: result.identity.timeframe,
        policyFingerprint,
        modelFingerprint,
      },
      result,
      resultHash: hashTracePayload(auditJson(result)),
      evidence: receipt,
      completedAt: new Date().toISOString(),
    };
    const report = JSON.stringify({ payload, hash: hashTracePayload(payload) }) + "\n";
    if (Buffer.byteLength(report) > 32 * 1024 * 1024)
      throw new Error("Retained result byte budget exceeded");
    await writeFile(join(output, "result.json"), report, { mode: 0o600, flag: "wx" });
    console.log(
      JSON.stringify({
        tradeId: result.tradeId,
        status: result.status,
        resultHash: payload.resultHash,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}
