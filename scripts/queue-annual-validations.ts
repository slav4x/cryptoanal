import "dotenv/config";
import { createHash } from "node:crypto";
import {
  validationEngineVersion,
  validationDatasetSource,
} from "../packages/application/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import { createPrismaClient, ValidationRepository } from "../packages/persistence/src/index";

const workspaceId = process.env.DEVELOPMENT_WORKSPACE_ID ?? "development";
const actorId = "system:annual-validation";
const startDate = "2025-09-01";
const endDate = "2026-08-31";
const prisma = createPrismaClient();
const repository = new ValidationRepository(prisma);

try {
  const strategies = await prisma.strategy.findMany({
    where: {
      workspaceId,
      status: "DEPLOYED",
      activeVersionId: { not: null },
      deployments: { some: { status: "RUNNING" } },
    },
    select: {
      id: true,
      name: true,
      activeVersion: { select: { id: true, configHash: true, config: true } },
      versions: { orderBy: { version: "desc" }, take: 1, select: { id: true } },
    },
    orderBy: { name: "asc" },
  });
  if (strategies.length === 0) throw new Error("No running strategies found");

  for (const strategy of strategies) {
    const version = strategy.activeVersion;
    if (!version || version.id !== strategy.versions[0]?.id) {
      throw new Error(`${strategy.name}: active version is not the latest version`);
    }
    const config = strategyConfigSchema.parse(version.config);
    const dataset = {
      startDate,
      endDate,
      symbols: config.universe.symbols,
      timeframe: config.universe.timeframe,
    };
    const datasetHash = createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
    const keyHash = createHash("sha256")
      .update(`annual-backtest:${version.id}:${startDate}:${endDate}:${validationEngineVersion}`)
      .digest("hex");
    const idempotencyKey = `${keyHash.slice(0, 8)}-${keyHash.slice(8, 12)}-5${keyHash.slice(13, 16)}-a${keyHash.slice(17, 20)}-${keyHash.slice(20, 32)}`;
    const snapshot = await repository.findHistoricalDatasetSnapshot({
      workspaceId,
      source: validationDatasetSource,
      exchange: "bybit",
      instrumentType: "linear-perpetual",
      timeframe: dataset.timeframe,
      symbols: dataset.symbols,
      startsAt: new Date(`${startDate}T00:00:00.000Z`),
      endDayStartsAt: new Date(`${endDate}T00:00:00.000Z`),
      endDayEndsAt: new Date(`${endDate}T23:59:59.999Z`),
    });
    const queued = await repository.queue({
      workspaceId,
      strategyId: strategy.id,
      strategyVersionId: version.id,
      actorId,
      requestId: idempotencyKey,
      kind: "BACKTEST",
      datasetId: snapshot
        ? `dataset-snapshot:${snapshot.id}`
        : `market-candles-request:${datasetHash}`,
      datasetSnapshotId: snapshot?.id ?? null,
      datasetAsOf: snapshot?.endsAt ?? new Date(),
      engineVersion: validationEngineVersion,
      configHash: version.configHash,
      input: {
        kind: "backtest",
        dataset,
        initialCapital: "10000",
        walkForward: null,
      },
      idempotencyKey,
    });
    console.log(`${queued.replayed ? "existing" : "queued"}\t${queued.run.id}\t${strategy.name}`);
  }
} finally {
  await prisma.$disconnect();
}
