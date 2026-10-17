import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, connect, type Socket, type AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { test, type TestContext } from "node:test";
import { Client } from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import { createPrismaClient } from "../packages/persistence/src/client";
import { runRuntimeLane } from "../apps/worker/src/runtime-lane";

const databaseUrl = process.env.RUNTIME_TEST_DATABASE_URL;
if (databaseUrl && !/^\/cryptoanal_runtime_test_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname))
  throw new Error("Use a dedicated cryptoanal_runtime_test_* database");

async function responseProxy(
  t: TestContext,
  drop: (text: string) => boolean,
  max = 1,
  options: { preserveServerOnDisconnect?: boolean; idleTransactionTimeoutMs?: number } = {},
) {
  const target = new URL(databaseUrl!);
  const sockets = new Set<Socket>();
  let withheldBytes = 0,
    connections = 0;
  const server = createServer((incoming) => {
    connections++;
    const outgoing = connect(Number(target.port) || 5432, target.hostname);
    sockets.add(incoming);
    sockets.add(outgoing);
    let blocked = false,
      tail = Buffer.alloc(0);
    incoming.on("data", (data) => {
      const bytes = typeof data === "string" ? Buffer.from(data) : data;
      tail = Buffer.concat([tail, bytes]).subarray(-8192);
      if (!blocked && drop(tail.toString())) blocked = true;
      outgoing.write(data);
    });
    outgoing.on("data", (data) => {
      if (blocked) withheldBytes += data.length;
      else incoming.write(data);
    });
    incoming.on("error", () => {});
    outgoing.on("error", () => {});
    incoming.on("close", () => {
      sockets.delete(incoming);
      if (!options.preserveServerOnDisconnect) outgoing.destroy();
    });
    outgoing.on("close", () => {
      sockets.delete(outgoing);
      incoming.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(target);
  url.hostname = "127.0.0.1";
  url.port = String((server.address() as AddressInfo).port);
  const db = createPrismaClient(url.toString(), {
    maxConnections: max,
    applicationName: "cryptoanal-test-response-timeout",
    statementTimeoutMs: 100,
    queryTimeoutMs: 250,
    idleTransactionTimeoutMs: options.idleTransactionTimeoutMs ?? 15000,
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await db.$disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await db.$queryRaw`SELECT 1`;
  return { db, withheld: () => withheldBytes, connections: () => connections };
}

const transportFailure = (error: unknown) =>
  /read timeout|connection|transaction.*closed/i.test(String(error));

test(
  "database response loss releases runtime work without a worker restart",
  {
    skip: !databaseUrl,
    timeout: 20000,
  },
  async (t) => {
    const control = new Client({ connectionString: databaseUrl!, query_timeout: 3000 });
    await control.connect();
    const table = `transport_${randomUUID().replaceAll("-", "")}`;
    await control.query(`CREATE TABLE "${table}" (id text PRIMARY KEY)`);
    t.after(async () => {
      await control.query(`DROP TABLE "${table}"`);
      await control.end();
    });
    const samples: Record<string, number> = {};

    await t.test(
      "a lost read response closes its session and a fresh connection progresses",
      async (t) => {
        let armed = false;
        const x = await responseProxy(t, (text) => armed && text.includes("n04_read_marker"));
        const [before] = await x.db.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        armed = true;
        const started = performance.now();
        await assert.rejects(x.db.$queryRaw`SELECT 42 AS n04_read_marker`, transportFailure);
        samples.readFailureMs = performance.now() - started;
        assert.ok(samples.readFailureMs < 2000);
        assert.ok(x.withheld() > 0, "the server response must actually have reached the proxy");
        armed = false;
        const [after] = await x.db.$queryRaw<
          Array<{ pid: number }>
        >`SELECT pg_backend_pid() AS pid`;
        assert.notEqual(after!.pid, before!.pid);
        assert.equal(x.connections(), 2);
      },
    );

    await t.test(
      "response loss inside a transaction rolls back before the caller retries",
      async (t) => {
        const x = await responseProxy(t, (text) => text.includes("n04_transaction_marker"));
        const started = performance.now();
        await assert.rejects(
          x.db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`INSERT INTO "${table}" (id) VALUES ('rolled-back')`);
            await tx.$queryRaw`SELECT 1 AS n04_transaction_marker`;
          }),
          transportFailure,
        );
        samples.transactionFailureMs = performance.now() - started;
        assert.ok(samples.transactionFailureMs < 2000);
        assert.equal(
          (await control.query(`SELECT * FROM "${table}" WHERE id='rolled-back'`)).rowCount,
          0,
        );
        await x.db.$executeRawUnsafe(`INSERT INTO "${table}" (id) VALUES ('rolled-back')`);
        assert.equal(
          (await control.query(`SELECT * FROM "${table}" WHERE id='rolled-back'`)).rowCount,
          1,
        );
      },
    );

    await t.test(
      "a lost COMMIT response stays uncertain and does not automatically repeat the write",
      async (t) => {
        let armed = true;
        const x = await responseProxy(t, (text) => {
          if (armed && text.includes("COMMIT")) {
            armed = false;
            return true;
          }
          return false;
        });
        await assert.rejects(
          x.db.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`INSERT INTO "${table}" (id) VALUES ('committed-once')`);
          }),
          transportFailure,
        );
        assert.ok(x.withheld() > 0);
        assert.equal(
          (await control.query(`SELECT * FROM "${table}" WHERE id='committed-once'`)).rowCount,
          1,
        );
        assert.equal(
          await x.db.$executeRawUnsafe(
            `INSERT INTO "${table}" (id) VALUES ('committed-once') ON CONFLICT DO NOTHING`,
          ),
          0,
        );
        assert.ok(x.connections() >= 2);
      },
    );

    await t.test(
      "a lost client disconnect cannot leave a server transaction holding its risk lock",
      async (t) => {
        const x = await responseProxy(t, (text) => text.includes("n04_idle_marker"), 1, {
          preserveServerOnDisconnect: true,
          idleTransactionTimeoutMs: 700,
        });
        const [setting] = await x.db.$queryRaw<
          Array<{ value: string }>
        >`SELECT current_setting('idle_in_transaction_session_timeout') AS value`;
        assert.equal(setting!.value, "700ms");
        const key = `n04-idle-${randomUUID()}`;
        const started = performance.now();
        await assert.rejects(
          x.db.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
            await tx.$queryRaw`SELECT 1 AS n04_idle_marker`;
          }),
          transportFailure,
        );
        assert.ok(x.withheld() > 0);
        const locked = async () =>
          (
            await control.query<{ locked: boolean }>(
              "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
              [key],
            )
          ).rows[0]!.locked;
        let acquired = await locked();
        assert.equal(
          acquired,
          false,
          "server session is still holding the lock after local timeout",
        );
        while (!acquired && performance.now() - started < 2500) {
          await sleep(20);
          acquired = await locked();
        }
        try {
          assert.equal(
            acquired,
            true,
            "server idle deadline must release the abandoned transaction",
          );
        } finally {
          if (acquired) await control.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
        }
        samples.abandonedServerTransactionMs = performance.now() - started;
        assert.equal(
          (await x.db.$queryRaw<Array<{ value: number }>>`SELECT 1 AS value`)[0]!.value,
          1,
        );
      },
    );

    await t.test(
      "a server SQL error can recover at a savepoint on the same connection",
      async (t) => {
        const x = await responseProxy(t, () => false);
        await x.db.$transaction(async (tx) => {
          const [before] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          await tx.$executeRaw`SAVEPOINT healthy`;
          await assert.rejects(tx.$queryRaw`SELECT 1 / 0`);
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT healthy`;
          const [after] = await tx.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pg_backend_pid() AS pid`;
          assert.equal(before!.pid, after!.pid);
        });
        assert.equal(x.connections(), 1);
      },
    );

    await t.test(
      "all occupied position slots fail visibly and the next position runs",
      async (t) => {
        const x = await responseProxy(t, (text) => text.includes("n04_lane_marker"), 4);
        const errors: number[] = [],
          success: number[] = [];
        let stopped = false;
        const started = performance.now();
        await runRuntimeLane({
          stopping: () => stopped,
          concurrency: 4,
          intervalMs: 1,
          load: async () => [1, 2, 3, 4, 5],
          process: async (item) => {
            if (item <= 4) await x.db.$queryRaw`SELECT 1 AS n04_lane_marker`;
            else {
              await x.db.$queryRaw`SELECT 1`;
              success.push(item);
            }
          },
          onError: (error, item) => {
            assert.ok(transportFailure(error));
            errors.push(item!);
          },
          wait: async () => {
            stopped = true;
          },
        });
        samples.allSlotsRecoveryMs = performance.now() - started;
        assert.deepEqual(errors.sort(), [1, 2, 3, 4]);
        assert.deepEqual(success, [5]);
        assert.ok(samples.allSlotsRecoveryMs < 2000);
      },
    );

    if (process.env.RUNTIME_TRANSPORT_REPORT)
      await writeFile(
        process.env.RUNTIME_TRANSPORT_REPORT,
        JSON.stringify(
          {
            asOf: new Date().toISOString(),
            queryTimeoutMs: 250,
            serverStatementTimeoutMs: 100,
            samples,
            fault: "completed server responses withheld by a local TCP proxy",
            historicalCause: "not established by this constructed fault",
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
  },
);
