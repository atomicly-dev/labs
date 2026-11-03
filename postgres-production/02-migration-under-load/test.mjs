// The shop is busy: 4 app connections place, read, and ship orders the whole time. A support
// session has had a transaction open on orders for a while, and keeps it open for 3 more seconds.
// Then migration.sql runs. The lab passes when no request waits more than 0.5 s for a lock, and the
// migration leaves a valid index on orders.shipped_on and a validated check constraint.

import pg from "pg";
import {
  DATABASE_URL,
  UNTRACKED,
  describeError,
  dropAddedIndexes,
  ms,
  readSqlFile,
  setUp,
  sleep,
} from "../lib/harness.mjs";

const SEED_ORDERS = 300_000;
const SEED_CONSTRAINTS = ["orders_status_check", "orders_payment_status_check"];
const OPEN_TRANSACTION_MS = 3_000; // How long the support session's transaction stays open.
const WAIT_LIMIT_MS = 500; // The longest a request may wait for a lock.
const RETRY_PAUSE_MS = 200; // Gives the requests that queued behind a failed try time to run.
const MAX_RETRIES = 100;
const POLL_MS = 10;
const APP_CONNECTIONS = 4;

export default {
  file: "migration.sql",
  lesson: "https://atomicly.dev/lessons/zero-downtime-migrations",

  async run({ file, db, connect, track }) {
    const read = await readSqlFile(file);
    if (read.problems) return read.problems;

    await setUp(db, async () => {
      await dropAddedIndexes(db, ["orders"]);
      const { rows } = await db.query(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'orders'::regclass AND contype = 'c' AND NOT conname = ANY ($1)`,
        [SEED_CONSTRAINTS],
      );
      for (const { conname } of rows) {
        await db.query(`ALTER TABLE orders DROP CONSTRAINT ${pg.escapeIdentifier(conname)}`);
      }
      await db.query("DELETE FROM order_items WHERE order_id > $1", [SEED_ORDERS]);
      await db.query("DELETE FROM orders WHERE id > $1", [SEED_ORDERS]);
    });

    // A support agent fixed an order in psql, in a transaction, and hasn't committed yet.
    const support = await connect("support session");
    await support.query("BEGIN");
    await support.query("UPDATE orders SET status = status WHERE id = 1");

    const traffic = startTraffic(track);
    const migration = await connect("migration");
    const watch = startWatching(db, traffic, migration.processID);

    await sleep(300);
    const supportDone = sleep(OPEN_TRANSACTION_MS).then(() => support.query("COMMIT"));
    watch.migration = runMigration(migration, read.statements);
    const outcome = await watch.migration.done;
    await supportDone;
    await sleep(300);
    await traffic.stop();
    await watch.stop();

    const problems = [];
    if (outcome.error) {
      const { statement, error } = outcome.error;
      problems.push(
        statement
          ? `migration.sql failed at line ${statement.line} (${statement.text}): ${describeError(error)}`
          : error.message,
      );
    }

    if (watch.longestWait > WAIT_LIMIT_MS) {
      problems.push(
        `While the migration ran, the app's requests waited up to ${ms(watch.longestWait)} for a lock on orders. ` +
          `Each request should wait ${ms(WAIT_LIMIT_MS)} at most.`,
      );
      for (const statement of watch.queuedBehind) {
        problems.push(
          `They queued behind migration.sql line ${statement.line} (${statement.text}).`,
        );
      }
    }
    const failed = traffic.requests.filter((request) => request.error);
    if (failed.length) {
      problems.push(
        `${failed.length} of the app's requests failed. The first, ${failed[0].kind}, with ${describeError(failed[0].error)}`,
      );
    }
    for (const statement of watch.builtWithShareLock) {
      problems.push(
        `migration.sql line ${statement.line} (${statement.text}) held a SHARE lock on orders while it ran. ` +
          "A SHARE lock blocks every INSERT and UPDATE on the table until the statement ends.",
      );
    }

    if (!outcome.error) problems.push(...(await checkSchema(db)));
    return problems;
  },
};

// The app: each connection places an order, reads an order, and ships one of the orders it
// placed, over and over. Each request's error, if it fails, goes in `requests`.
function startTraffic(track) {
  const pool = track(
    new pg.Pool({ connectionString: DATABASE_URL, max: APP_CONNECTIONS, application_name: "lab: app", options: UNTRACKED }),
  );
  const pids = new Set();
  pool.on("connect", (client) => pids.add(client.processID));
  const requests = [];
  let running = true;

  const timed = async (kind, request) => {
    try {
      await request();
      requests.push({ kind });
    } catch (error) {
      requests.push({ kind, error });
    }
  };

  const worker = async (n) => {
    const placed = [];
    for (let i = 0; running; i++) {
      await timed("a checkout", async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const { rows } = await client.query(
            "INSERT INTO orders (customer_id, status, ordered_on) VALUES ($1, 'paid', current_date) RETURNING id",
            [1 + ((n * 1000 + i * 37) % 50000)],
          );
          await client.query(
            "INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES ($1, $2, 1, 19.99)",
            [rows[0].id, 1 + (i % 500)],
          );
          await client.query("COMMIT");
          placed.push(rows[0].id);
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      });
      await timed("an order page", () =>
        pool.query("SELECT id, status, ordered_on, shipped_on FROM orders WHERE id = $1", [
          2 + ((n * 7919 + i * 101) % (SEED_ORDERS - 1)),
        ]),
      );
      if (placed.length > 1) {
        await timed("a shipping update", () =>
          pool.query("UPDATE orders SET status = 'shipped', shipped_on = current_date WHERE id = $1", [
            placed.shift(),
          ]),
        );
      }
      await sleep(5);
    }
  };
  const workers = Array.from({ length: APP_CONNECTIONS }, (_, n) => worker(n));

  return {
    pids,
    requests,
    async stop() {
      running = false;
      await Promise.all(workers);
    },
  };
}

// Runs the statements in order, in one session. A statement that fails with 55P03
// lock_not_available runs again after a short pause, the way a migration tool retries. When it
// was inside BEGIN ... COMMIT, the whole transaction runs again. Any other error stops the
// migration.
function runMigration(client, statements) {
  // running is the statement in progress, and seq counts the statements started, so the watcher
  // can tell when the statement changed while it looked.
  const state = { running: null, seq: 0 };
  const isBegin = (statement) => /^(BEGIN|START\s+TRANSACTION)\b/i.test(statement.text);
  const isEnd = (statement) => /^(COMMIT|END|ROLLBACK|ABORT)\b/i.test(statement.text);

  state.done = (async () => {
    let retries = 0;
    const retried = new Set();
    let transactionStart = null;
    for (let i = 0; i < statements.length; ) {
      const statement = statements[i];
      state.running = statement;
      state.seq++;
      try {
        await client.query(statement.sql);
        if (isBegin(statement)) transactionStart = i;
        else if (isEnd(statement)) transactionStart = null;
        i++;
      } catch (error) {
        if (error.code === "55P03" && retries < MAX_RETRIES) {
          retries++;
          retried.add(statement);
          if (transactionStart !== null) {
            await client.query("ROLLBACK");
            i = transactionStart;
            transactionStart = null;
          }
          await sleep(RETRY_PAUSE_MS);
          continue;
        }
        if (error.code === "42P07" && retried.has(statement)) {
          error.message +=
            ". An earlier try of this statement failed partway and left the index behind, INVALID";
        }
        return { error: { statement, error } };
      } finally {
        state.running = null;
      }
    }
    if (transactionStart !== null) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        error: {
          error: new Error(
            "migration.sql ended with its transaction still open, so the test rolled it back. End it with COMMIT.",
          ),
        },
      };
    }
    return {};
  })();
  return state;
}

// Every few milliseconds, it looks at what the app's sessions wait for, and which locks the
// migration holds on orders.
function startWatching(db, traffic, migrationPid) {
  const watch = { migration: null, longestWait: 0, queuedBehind: new Set(), builtWithShareLock: new Set() };
  const waits = new Map(); // pid -> { ms, behind: Set of statements }, for each app session waiting now
  const endWait = (pid) => {
    const wait = waits.get(pid);
    waits.delete(pid);
    watch.longestWait = Math.max(watch.longestWait, wait.ms);
    if (wait.ms > WAIT_LIMIT_MS) for (const statement of wait.behind) watch.queuedBehind.add(statement);
  };
  let running = true;
  let last = performance.now();
  const loop = (async () => {
    while (running) {
      const statement = watch.migration?.running;
      const seq = watch.migration?.seq;
      const { rows: waiting } = await db.query(
        `SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE pid = ANY ($1) AND wait_event_type = 'Lock'`,
        [[...traffic.pids]],
      );
      const { rows: held } = await db.query(
        `SELECT 1 FROM pg_locks
          WHERE pid = $1 AND relation = 'orders'::regclass AND mode = 'ShareLock' AND granted`,
        [migrationPid],
      );
      // A wait grows by the time since the last look, but by 50 ms at most, so a pause of the
      // whole machine (a busy laptop, a container VM) doesn't count as a wait for a lock.
      const now = performance.now();
      const step = Math.min(now - last, 50);
      last = now;
      const same = statement && watch.migration.seq === seq;
      for (const row of waiting) {
        const wait = waits.get(row.pid) ?? { ms: 0, behind: new Set() };
        wait.ms += step;
        if (same && row.blockers.includes(migrationPid)) wait.behind.add(statement);
        waits.set(row.pid, wait);
      }
      for (const pid of [...waits.keys()]) {
        if (!waiting.some((row) => row.pid === pid)) endWait(pid);
      }
      if (same && held.length) watch.builtWithShareLock.add(statement);
      await sleep(POLL_MS);
    }
    for (const pid of [...waits.keys()]) endWait(pid);
  })();
  watch.stop = async () => {
    running = false;
    await loop;
  };
  return watch;
}

async function checkSchema(db) {
  const problems = [];

  const { rows: indexes } = await db.query(
    `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_index AS i
       JOIN pg_class AS c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'orders'::regclass
        AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                            WHERE attrelid = 'orders'::regclass AND attname = 'shipped_on')`,
  );
  if (!indexes.some((index) => index.valid)) {
    const invalid = indexes.find((index) => !index.valid);
    problems.push(
      invalid
        ? `The index ${invalid.name} on orders (shipped_on) is INVALID: its CREATE INDEX CONCURRENTLY didn't finish. ` +
            "PostgreSQL keeps updating it, but no query uses it. Drop it and build it again."
        : "orders has no index on shipped_on.",
    );
  }

  const { rows: checks } = await db.query(
    `SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conrelid = 'orders'::regclass AND contype = 'c' AND NOT conname = ANY ($1)`,
    [SEED_CONSTRAINTS],
  );
  let rejected = false;
  await db.query("BEGIN");
  try {
    await db.query(
      "INSERT INTO orders (customer_id, status, ordered_on, shipped_on) VALUES (1, 'shipped', '2025-05-02', '2025-05-01')",
    );
  } catch (error) {
    rejected = error.code === "23514";
  } finally {
    await db.query("ROLLBACK");
  }
  if (!rejected) {
    problems.push("orders still accepts an order with shipped_on before ordered_on. Add the check constraint.");
  }
  for (const check of checks.filter((check) => !check.validated)) {
    problems.push(
      `The constraint ${check.name} is NOT VALID: PostgreSQL checks new rows, but hasn't checked the rows ` +
        "already in orders. Validate it.",
    );
  }
  return problems;
}
