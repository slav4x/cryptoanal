import type { CryptoAnalPrismaClient } from "./client";
import { Prisma } from "./generated/prisma/client";

export type SystemLogFilters = {
  startsAt: Date | null;
  level: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" | null;
  service: string | null;
  correlationId: string | null;
  query: string | null;
  cursor: string | null;
  limit: number;
};

export class SystemLogCursorNotFoundError extends Error {}

export class SystemLogRepository {
  public constructor(private readonly prisma: CryptoAnalPrismaClient) {}

  public async list(workspaceId: string, filters: SystemLogFilters) {
    const cursor = filters.cursor
      ? await this.prisma.systemLog.findFirst({
          where: { id: filters.cursor, workspaceId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (filters.cursor && !cursor) throw new SystemLogCursorNotFoundError();

    const summaryWhere = buildWhere(workspaceId, filters);
    const where: Prisma.SystemLogWhereInput = cursor
      ? {
          AND: [
            summaryWhere,
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : summaryWhere;

    const [rows, total, levelCounts, serviceGroups, services] = await Promise.all([
      this.prisma.systemLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: filters.limit + 1,
        select: {
          id: true,
          level: true,
          service: true,
          event: true,
          message: true,
          correlationId: true,
          metadata: true,
          createdAt: true,
        },
      }),
      this.prisma.systemLog.count({ where: summaryWhere }),
      this.prisma.systemLog.groupBy({
        by: ["level"],
        where: summaryWhere,
        _count: { _all: true },
      }),
      this.prisma.systemLog.groupBy({
        by: ["service"],
        where: summaryWhere,
        _count: { _all: true },
      }),
      this.prisma.systemLog.findMany({
        where: { workspaceId },
        distinct: ["service"],
        orderBy: { service: "asc" },
        select: { service: true },
      }),
    ]);
    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    return {
      items,
      total,
      counts: new Map(levelCounts.map((item) => [item.level, item._count._all])),
      serviceCount: serviceGroups.length,
      services: services.map((item) => item.service),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  public async write(input: {
    workspaceId: string;
    level: "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
    service: string;
    event: string;
    message: string;
    correlationId?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    return this.prisma.systemLog.create({
      data: {
        workspaceId: input.workspaceId,
        level: input.level,
        service: input.service.slice(0, 60),
        event: input.event.slice(0, 120),
        message: redactString(input.message).slice(0, 4_000),
        correlationId: input.correlationId?.slice(0, 120) ?? null,
        metadata: input.metadata ? sanitizeObject(input.metadata) : Prisma.JsonNull,
      },
    });
  }
}

export function redactSystemLogMetadata(value: Prisma.JsonValue): Record<string, unknown> | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return sanitizeObject(value as Record<string, unknown>);
}

function buildWhere(workspaceId: string, filters: SystemLogFilters): Prisma.SystemLogWhereInput {
  return {
    workspaceId,
    ...(filters.startsAt ? { createdAt: { gte: filters.startsAt } } : {}),
    ...(filters.level ? { level: filters.level } : {}),
    ...(filters.service ? { service: filters.service } : {}),
    ...(filters.correlationId ? { correlationId: filters.correlationId } : {}),
    ...(filters.query
      ? {
          OR: [
            { event: { contains: filters.query, mode: "insensitive" } },
            { message: { contains: filters.query, mode: "insensitive" } },
            { correlationId: { contains: filters.query, mode: "insensitive" } },
          ],
        }
      : {}),
  };
}

function sanitizeObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : sanitizeValue(item),
    ]),
  ) as Prisma.InputJsonObject;
}

function sanitizeValue(value: unknown): Prisma.InputJsonValue | null {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object") return sanitizeObject(value as Record<string, unknown>);
  return String(value);
}

function redactString(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/((?:password|secret|token|api[_-]?key)=)[^&\s]+/gi, "$1[REDACTED]");
}

const sensitiveKeyPattern =
  /authorization|cookie|password|secret|token|api[_-]?key|credential|private[_-]?key/i;
