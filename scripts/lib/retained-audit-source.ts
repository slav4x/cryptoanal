import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "../../packages/persistence/src/generated/prisma/client";
import type { CryptoAnalPrismaClient } from "../../packages/persistence/src/client";
import { hashTracePayload } from "../../packages/persistence/src/position-trace";
import {
  tradeAcceptanceContract,
  type AcceptanceBoundary,
} from "../../packages/application/src/trade-acceptance";
import { auditJson, auditObject } from "../../apps/worker/src/closed-trade-audit";
import type { RetainedTradeAuditSource } from "../../apps/worker/src/retained-trade-audit";
import type { EvidenceManifest } from "./trade-audit-evidence";

const root = fileURLToPath(new URL("../../", import.meta.url));
export async function retainedAuditImplementation() {
  const original = await readFile(resolve(root, "scripts/audit-closed-trades.ts"), "utf8");
  const files = JSON.parse(
    original.match(/const implementationFiles = (\[[\s\S]*?\]);/)![1]!.replace(/,\s*\]$/, "]"),
  ) as string[];
  files.push(
    "apps/worker/src/retained-trade-audit.ts",
    "scripts/lib/retained-audit-source.ts",
    "scripts/lib/retained-audit-evidence.ts",
    "scripts/process-trade-audit.ts",
    "packages/persistence/src/runtime-account-proof.ts",
    "packages/application/src/execution-account.ts",
    "packages/application/src/execution-funding.ts",
    "packages/application/src/execution-instrument.ts",
    "packages/persistence/src/execution-policy-repository.ts",
    "packages/persistence/src/position-trace.ts",
    "packages/persistence/src/runtime-risk.ts",
    "packages/persistence/src/runtime-repository.ts",
    "packages/persistence/src/funding-repository.ts",
    "packages/persistence/src/liquidity-exit-repository.ts",
    "packages/persistence/src/price-archive-repository.ts",
    "packages/contracts/src/index.ts",
  );
  const hashes = Object.fromEntries(
    await Promise.all(
      [...new Set(files)].sort().map(async (f) => [
        f,
        createHash("sha256")
          .update(await readFile(resolve(root, f)))
          .digest("hex"),
      ]),
    ),
  );
  return { hash: hashTracePayload(hashes), files: hashes };
}
export async function readAcceptanceBaseline(path: string, workspaceId: string) {
  const baseline = JSON.parse(await readFile(path, "utf8"));
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
    throw new Error("N01 boundary mismatch");
  const groupsByPosition = Object.fromEntries(
    (
      baseline.payload.derived.groups as Array<{
        identity: Record<string, string>;
        positionIds: string[];
      }>
    ).flatMap((g) => g.positionIds.map((id) => [id, g.identity])),
  );
  return { hash: baseline.hash as string, boundary, groupsByPosition };
}
export async function captureRetainedAuditSource(
  prisma: CryptoAnalPrismaClient,
  workspaceId: string,
  positionId: string,
) {
  return prisma.$transaction(
    async (tx) => {
      const [stamp] = await tx.$queryRaw<Array<{ asOf: Date }>>`SELECT clock_timestamp() AS "asOf"`;
      const raw = await tx.position.findFirstOrThrow({
        where: { id: positionId, workspaceId, environment: "DRY_RUN", status: "CLOSED" },
        include: {
          trade: true,
          strategyVersion: true,
          executionRun: { include: { deployment: { select: { exchangeAccountId: true } } } },
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
      });
      const signalId = auditObject(auditObject(raw.decisions[0]?.factors).runtimeSignal).id;
      const signals =
        typeof signalId === "string"
          ? await tx.auditEvent.findMany({
              where: { workspaceId, resourceId: signalId, action: "runtime.signal.observed" },
              select: { id: true, metadata: true },
              orderBy: { createdAt: "asc" },
            })
          : [];
      const accountProofs = await tx.auditEvent.findMany({
        where: { workspaceId, resourceId: positionId, action: "runtime.account.proof" },
        select: { id: true, metadata: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 10001,
      });
      if (accountProofs.length > 10000) throw new Error("Account evidence row budget exceeded");
      const {
        trade,
        strategyVersion,
        executionRun,
        orders,
        fundingPayments,
        executionTrace,
        ...position
      } = raw;
      if (!trade) throw new Error("Closed position has no Trade");
      const [fingerprint] = await tx.$queryRaw<
        Array<{ value: string; model: string }>
      >`SELECT md5(coalesce(p."executionPolicy"::text,'null')) AS value,
        md5(jsonb_build_object('runEngine',er."engineVersion",'traceEngine',tr.snapshot->>'executionEngineVersion','positionExit',p."positionExitPolicy",'recovery',p."recoveryModel",'exit',p."exitPolicy",'funding',p."fundingPolicy",'instrumentRules',p."instrumentRules"-'observedAt','profitProtectionPolicyKey',p."profitProtection"->'policyKey')::text) AS model
        FROM "Position" p JOIN "ExecutionRun" er ON er.id=p."executionRunId" LEFT JOIN "PositionExecutionTrace" tr ON tr."positionId"=p.id WHERE p.id=${positionId}`;
      const source = auditJson({
        asOf: stamp!.asOf.toISOString(),
        accountId: executionRun.deployment.exchangeAccountId,
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
        accountProofs,
      }) as RetainedTradeAuditSource;
      return {
        source,
        policyFingerprint: fingerprint!.value,
        modelFingerprint: fingerprint!.model,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 },
  );
}

export async function verifyRetainedEvidence(root: string, manifestHash: string) {
  const { readAuditEvidence } = await import("./trade-audit-evidence");
  if (
    (await stat(resolve(root, "source.json"))).size > 32 * 1024 * 1024 ||
    (await stat(resolve(root, "manifest.json"))).size > 4 * 1024 * 1024
  )
    throw new Error("Retained evidence JSON byte budget exceeded");
  const { source, loaders } = await readAuditEvidence(root, manifestHash);
  const manifest = JSON.parse(
    await readFile(resolve(root, "manifest.json"), "utf8"),
  ) as EvidenceManifest;
  for (const page of manifest.pages)
    if (page.chunk) {
      const file = page.chunk.file;
      if (basename(file) !== file) throw new Error("Invalid evidence file path");
      if ((await stat(resolve(root, file))).size > 32 * 1024 * 1024 + 65536)
        throw new Error("Retained price page byte budget exceeded");
      const payload = await readFile(resolve(root, file));
      if (createHash("sha256").update(payload).digest("hex") !== page.chunk.sha256)
        throw new Error("Retained price archive checksum mismatch");
    }
  for (const f of manifest.funding)
    if (f.file) {
      if (
        basename(f.file) !== f.file ||
        (await stat(resolve(root, f.file))).size > 32 * 1024 * 1024
      )
        throw new Error("Retained funding byte budget exceeded");
      await loaders.funding(f.id);
    }
  return { source, loaders };
}
