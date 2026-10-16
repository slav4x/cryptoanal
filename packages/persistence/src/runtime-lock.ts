import { Prisma } from "./generated/prisma/client";
import { setTimeout as delay } from "node:timers/promises";

export class RuntimeLockBusyError extends Error {
  public constructor(public readonly scope: string) {
    super(`Runtime lock busy: ${scope}`);
  }
}
export async function withRuntimeLockRetry<T>(work: () => Promise<T>, enabled: boolean) {
  const deadline = performance.now() + 250;
  let attempt = 0;
  for (;;) {
    try {
      return await work();
    } catch (error) {
      if (!enabled || !(error instanceof RuntimeLockBusyError) || performance.now() >= deadline)
        throw error;
      await delay(Math.min(8 + ((attempt++ * 11) % 17), Math.max(0, deadline - performance.now())));
    }
  }
}
export async function lockRuntimeScope(
  tx: Prisma.TransactionClient,
  scope: string,
  nonBlocking = false,
) {
  if (nonBlocking) {
    const [result] = await tx.$queryRaw<Array<{ locked: boolean }>>(
      Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${scope})) AS locked`,
    );
    if (!result?.locked) throw new RuntimeLockBusyError(scope);
  } else {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${scope}))`);
  }
}
