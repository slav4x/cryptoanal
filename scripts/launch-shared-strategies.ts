import "dotenv/config";
import { randomUUID } from "node:crypto";
import { executionEngineVersion } from "../packages/application/src/index";
import {
  createPrismaClient,
  DeploymentRepository,
  StrategyRepository,
} from "../packages/persistence/src/index";
import { sharedStrategies } from "../prisma/fixtures/shared-strategies";

const workspaceId =
  readArgument("--workspace") ?? process.env.DEVELOPMENT_WORKSPACE_ID ?? "development";
const actorId = "system:shared-strategy-launch";
const prisma = createPrismaClient();
const strategyRepository = new StrategyRepository(prisma);
const deploymentRepository = new DeploymentRepository(prisma);

try {
  const exchangeConnection = await prisma.exchangeConnection.findFirst({
    where: { workspaceId, status: "ACTIVE", revokedAt: null },
    orderBy: { lastVerifiedAt: "desc" },
    select: { id: true },
  });
  if (!exchangeConnection) throw new Error("No active exchange connection found");

  const launchable = sharedStrategies.filter(
    (definition) => definition.reportedBacktest.verdict === "passed",
  );
  const results = [];

  for (const definition of launchable) {
    let strategy = await prisma.strategy.findUnique({
      where: { workspaceId_name: { workspaceId, name: definition.name } },
      select: {
        id: true,
        status: true,
        activeVersionId: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { id: true, configHash: true },
        },
      },
    });
    if (!strategy) throw new Error(`${definition.name}: import the strategy first`);
    const latestVersion = strategy.versions[0];
    if (!latestVersion) throw new Error(`${definition.name}: latest version not found`);

    const passedValidation = await prisma.validationRun.findFirst({
      where: {
        workspaceId,
        strategyId: strategy.id,
        strategyVersionId: latestVersion.id,
        configHash: latestVersion.configHash,
        status: "COMPLETED",
        verdict: "PASSED",
      },
      select: { id: true },
    });
    if (!passedValidation)
      throw new Error(`${definition.name}: latest version has no passed validation`);

    if (strategy.status === "VALIDATING") {
      await strategyRepository.transitionStatus({
        workspaceId,
        strategyId: strategy.id,
        actorId,
        requestId: randomUUID(),
        expectedStatus: "VALIDATING",
        targetStatus: "APPROVED",
        reason: "Shared strategy reproduced by local backtest",
      });
      strategy = { ...strategy, status: "APPROVED", activeVersionId: latestVersion.id };
    }
    if (strategy.status === "DEPLOYED") {
      results.push({ name: definition.name, state: "already-running" });
      continue;
    }
    if (strategy.status !== "APPROVED") {
      throw new Error(`${definition.name}: unexpected strategy status ${strategy.status}`);
    }

    let deployment = await prisma.deployment.findFirst({
      where: {
        workspaceId,
        strategyId: strategy.id,
        strategyVersionId: latestVersion.id,
        status: { in: ["READY", "RUNNING", "PAUSED"] },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, status: true },
    });
    if (!deployment) {
      const created = await deploymentRepository.create({
        workspaceId,
        strategyId: strategy.id,
        strategyVersionId: latestVersion.id,
        actorId,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        exchangeConnectionId: exchangeConnection.id,
        exchangeAccountId: `${workspaceId}-dry-run:strategy:${strategy.id}`,
      });
      deployment = { id: created.deployment.id, status: created.deployment.status };
    }

    if (deployment.status === "RUNNING") {
      results.push({ name: definition.name, state: "already-running" });
      continue;
    }
    if (deployment.status === "PAUSED") {
      results.push({ name: definition.name, state: "left-paused" });
      continue;
    }
    await deploymentRepository.applyCommand({
      workspaceId,
      deploymentId: deployment.id,
      actorId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
      command: "START",
      expectedStatus: "READY",
      reason: "Start locally reproduced shared strategy in dry-run",
      engineVersion: executionEngineVersion,
    });
    results.push({ name: definition.name, state: "started" });
  }

  const started = results.filter((result) => result.state === "started").length;
  console.log(`Shared strategies: ${started} started, ${results.length - started} unchanged.`);
  for (const result of results) console.log(`${result.state}\t${result.name}`);
} finally {
  await prisma.$disconnect();
}

function readArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
