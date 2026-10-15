import {
  makeExecutionPolicy,
  readExecutionPolicy,
  executionPolicyProfile,
  type ExecutionPolicySettings,
  type PinnedExecutionPolicy,
} from "../../application/src/execution-policy";
import { strategyConfigSchema } from "../../contracts/src/index";
import { hashTracePayload } from "./position-trace";
import type { Prisma } from "./generated/prisma/client";
import type { CryptoAnalPrismaClient } from "./client";
export function pinExecutionPolicy(
  payload: PinnedExecutionPolicy["payload"],
): PinnedExecutionPolicy {
  return {
    payload,
    hash: hashTracePayload(payload),
    profileHash: hashTracePayload(executionPolicyProfile(payload)),
  };
}
export function readPinnedExecutionPolicy(value: unknown): PinnedExecutionPolicy | null {
  if (value == null) return null;
  const saved = value as PinnedExecutionPolicy;
  const payload = readExecutionPolicy(saved.payload);
  if (
    saved.hash !== hashTracePayload(payload) ||
    saved.profileHash !== hashTracePayload(executionPolicyProfile(payload))
  )
    throw new Error("Execution policy checksum mismatch");
  return { ...saved, payload };
}
export class ExecutionPolicyRepository {
  constructor(private readonly prisma: CryptoAnalPrismaClient) {}
  async linkBaseline(executionRunId: string, validationRunId: string) {
    return this.prisma.$transaction(async (tx) => {
      const run = await tx.executionRun.findUniqueOrThrow({ where: { id: executionRunId } }),
        validation = await tx.validationRun.findUniqueOrThrow({ where: { id: validationRunId } });
      const a = readPinnedExecutionPolicy(run.executionPolicy),
        b = readPinnedExecutionPolicy(validation.executionPolicy);
      if (
        run.workspaceId !== validation.workspaceId ||
        run.strategyVersionId !== validation.strategyVersionId ||
        run.configHash !== validation.configHash ||
        validation.status !== "COMPLETED" ||
        !a ||
        !b ||
        a.profileHash !== b.profileHash
      )
        throw new Error("Execution baseline policy mismatch");
      await tx.executionPolicyBaseline.upsert({
        where: { executionRunId },
        create: { executionRunId, validationRunId },
        update: { validationRunId, capturedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: run.workspaceId,
          actorId: "worker",
          action: "execution.baseline.reference",
          resourceType: "execution-run",
          resourceId: run.id,
          outcome: "COMPLETED",
          requestId: `baseline:${run.id}:${validation.id}`,
          metadata: {
            validationRunId,
            verdict: validation.verdict,
            profileHash: a.profileHash,
            mode: "reference-only",
          },
        },
      });
    });
  }
  async pinRun(id: string, settings: ExecutionPolicySettings) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "ExecutionRun" WHERE id=${id} FOR UPDATE`;
      const run = await tx.executionRun.findUniqueOrThrow({
        where: { id },
        include: { strategyVersion: { select: { config: true } } },
      });
      const prior = readPinnedExecutionPolicy(run.executionPolicy);
      if (prior) return prior;
      const policy = pinExecutionPolicy(
        makeExecutionPolicy(
          strategyConfigSchema.parse(run.strategyVersion.config),
          settings,
          "public-trade-l1@1",
        ),
      );
      await tx.executionRun.update({
        where: { id },
        data: { executionPolicy: policy as unknown as Prisma.InputJsonValue },
      });
      await tx.auditEvent.create({
        data: {
          workspaceId: run.workspaceId,
          actorId: "worker",
          action: "execution.policy.pinned",
          resourceType: "execution-run",
          resourceId: id,
          outcome: "COMPLETED",
          requestId: `policy:${id}`,
          metadata: {
            hash: policy.hash,
            profileHash: policy.profileHash,
            capturedAt: policy.payload.capturedAt,
          },
        },
      });
      return policy;
    });
  }
  async pinValidation(input: {
    runId: string;
    jobId: string;
    workspaceId: string;
    workerId: string;
    settings: ExecutionPolicySettings;
    initialCapital: number;
  }) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM "ValidationRun" WHERE id=${input.runId} FOR UPDATE`;
      const lease = await tx.job.updateMany({
        where: {
          id: input.jobId,
          workspaceId: input.workspaceId,
          status: "RUNNING",
          lockedBy: input.workerId,
        },
        data: { lockedAt: new Date() },
      });
      if (lease.count !== 1) throw new Error("Execution policy lease lost");
      const run = await tx.validationRun.findFirstOrThrow({
        where: { id: input.runId, workspaceId: input.workspaceId, status: "RUNNING" },
        include: { strategyVersion: { select: { config: true } } },
      });
      const prior = readPinnedExecutionPolicy(run.executionPolicy);
      if (prior) return prior;
      const settings = {
        ...input.settings,
        accountSafety: { ...input.settings.accountSafety, initialBalance: input.initialCapital },
      };
      const policy = pinExecutionPolicy(
        makeExecutionPolicy(
          strategyConfigSchema.parse(run.strategyVersion.config),
          settings,
          "ohlc-adverse-first@1",
        ),
      );
      await tx.validationRun.update({
        where: { id: input.runId },
        data: { executionPolicy: policy as unknown as Prisma.InputJsonValue },
      });
      return policy;
    });
  }
}
