import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import { validationEngineVersion } from "../packages/application/src/index";
import { strategyConfigSchema } from "../packages/contracts/src/index";
import {
  createPrismaClient,
  StrategyRepository,
  ValidationRepository,
} from "../packages/persistence/src/index";
import { sharedStrategies } from "../prisma/fixtures/shared-strategies";

const workspaceId =
  readArgument("--workspace") ?? process.env.DEVELOPMENT_WORKSPACE_ID ?? "development";
const queueValidations = process.argv.includes("--queue-validations");
const actorId = "system:shared-strategy-import";
const prisma = createPrismaClient();
const strategyRepository = new StrategyRepository(prisma);
const validationRepository = new ValidationRepository(prisma);

try {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new Error(`Workspace ${workspaceId} not found. Run pnpm db:seed first.`);

  const results = [];
  for (const definition of sharedStrategies) {
    const config = strategyConfigSchema.parse(definition.config);
    const configHash = sha256(JSON.stringify(config));
    const existing = await prisma.strategy.findUnique({
      where: { workspaceId_name: { workspaceId, name: definition.name } },
      select: {
        id: true,
        status: true,
        createdByActorId: true,
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { id: true, version: true, configHash: true },
        },
      },
    });

    let strategyId: string;
    let strategyVersionId: string;
    let status: string;
    let imported: "created" | "updated" | "unchanged";
    if (existing) {
      const latestVersion = existing.versions[0];
      if (!latestVersion) throw new Error(`${definition.name}: existing strategy has no version`);
      strategyId = existing.id;
      if (latestVersion.configHash !== configHash) {
        if (existing.createdByActorId !== actorId) {
          throw new Error(`${definition.name}: unmanaged strategy has a different configuration`);
        }
        const version = await prisma.$transaction(async (transaction) => {
          const created = await transaction.strategyVersion.create({
            data: {
              workspaceId,
              strategyId: existing.id,
              version: latestVersion.version + 1,
              configSchemaVersion: config.schemaVersion,
              config,
              configHash,
              changeSummary: "Reconstructed from shared backtest metrics",
              createdByActorId: actorId,
            },
            select: { id: true },
          });
          await transaction.strategy.update({
            where: { id: existing.id },
            data: { status: "DRAFT", activeVersionId: null, updatedByActorId: actorId },
          });
          return created;
        });
        strategyVersionId = version.id;
        status = "DRAFT";
        imported = "updated";
      } else {
        strategyVersionId = latestVersion.id;
        status = existing.status;
        imported = "unchanged";
      }
    } else {
      const created = await strategyRepository.createWithInitialVersion({
        workspaceId,
        actorId,
        symbols: config.universe.symbols,
        name: definition.name,
        description: definition.description,
        configSchemaVersion: config.schemaVersion,
        config,
        configHash,
      });
      strategyId = created.strategy.id;
      strategyVersionId = created.version.id;
      status = created.strategy.status;
      imported = "created";
    }

    let validation = "not-requested";
    if (queueValidations) {
      if (status !== "DRAFT") {
        validation = `skipped:${status.toLowerCase()}`;
      } else {
        const dataset = {
          startDate: definition.reportedBacktest.startDate,
          endDate: definition.reportedBacktest.endDate,
          symbols: config.universe.symbols,
          timeframe: config.universe.timeframe,
        };
        await validationRepository.queue({
          workspaceId,
          strategyId,
          strategyVersionId,
          actorId,
          requestId: randomUUID(),
          kind: "BACKTEST",
          datasetId: `market-candles-request:${sha256(JSON.stringify(dataset))}`,
          datasetSnapshotId: null,
          datasetAsOf: new Date(),
          engineVersion: validationEngineVersion,
          configHash,
          input: {
            kind: "backtest",
            dataset,
            initialCapital: definition.reportedBacktest.initialCapital,
            walkForward: null,
          },
          idempotencyKey: randomUUID(),
        });
        validation = "queued";
      }
    }

    results.push({ name: definition.name, imported, validation });
  }

  const created = results.filter((result) => result.imported === "created").length;
  const updated = results.filter((result) => result.imported === "updated").length;
  const queued = results.filter((result) => result.validation === "queued").length;
  console.log(
    `Shared strategies: ${created} created, ${updated} updated, ${results.length - created - updated} unchanged, ${queued} validations queued.`,
  );
  for (const result of results) {
    console.log(`${result.imported}\t${result.validation}\t${result.name}`);
  }
} finally {
  await prisma.$disconnect();
}

function readArgument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
