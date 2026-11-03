// Runs a lab. Each lab's test.mjs drives the file you edit the way production would: it runs an
// app's workload, a migration next to live traffic, or webhook deliveries, then checks the result.
//
// The harness keeps track of every connection and pool the test opens. When the lab ends, it
// closes them all, even ones stuck behind a lock, so a stuck lab can't hang the next one.

import { access, readFile } from "node:fs/promises";
import pg from "pg";
import { describe, parseSqlFile } from "./sql-file.mjs";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5442/shop";

// A connection option that keeps a session's queries out of pg_stat_statements. The tests use it
// on every connection except lab 01's app, so lab 01's numbers show only the app's queries.
export const UNTRACKED = "-c pg_stat_statements.track=none";

const LAB_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} LabContext
 * @property {URL} file The file the learner edits, or the solution.
 * @property {pg.Client} db A connection for the test's own queries.
 * @property {(name: string) => Promise<pg.Client>} connect Opens another connection, named
 *   `lab: <name>` in pg_stat_activity. Neither shows up in pg_stat_statements.
 * @property {(pool: pg.Pool) => pg.Pool} track Makes the harness close the pool when the lab ends.
 */

/**
 * @typedef {object} Lab
 * @property {string} file The file the learner edits, relative to the lab's folder. The solution
 *   is solution.sql or solution.mjs, with the same extension.
 * @property {string} lesson
 * @property {(ctx: LabContext) => Promise<string[]>} run
 *   Drives the file. Returns what went wrong, or an empty list when the lab passes.
 */

export class HarnessError extends Error {}

/**
 * Runs the lab once. Returns { ok, problems }.
 * @param {Lab} lab
 * @param {URL} file
 */
export async function runLab(lab, file) {
  try {
    await access(file);
  } catch {
    throw new HarnessError(`Can't find ${file.pathname}.`);
  }

  const clients = new Set();
  const pools = [];
  const connect = async (name) => {
    const client = await open(name);
    clients.add(client);
    return client;
  };
  const track = (pool) => {
    const poolClients = new Set();
    // A connection that the harness closes, or that the server ends, emits an error. The request
    // that used it reports the error already, so the harness only keeps it from crashing Node.
    pool.on("error", () => {});
    pool.on("connect", (client) => {
      poolClients.add(client);
      client.on("error", () => {});
      client.on("end", () => poolClients.delete(client));
    });
    pools.push({ pool, clients: poolClients });
    return pool;
  };

  const db = await open("test");

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve([`The lab didn't finish within ${LAB_TIMEOUT_MS / 1000} seconds.`]),
      LAB_TIMEOUT_MS,
    );
  });
  try {
    const problems = await Promise.race([lab.run({ file, db, connect, track }), timeout]);
    return { ok: problems.length === 0, problems };
  } finally {
    clearTimeout(timer);
    // End every other session on the server side first: a session that waits for a lock doesn't
    // read a polite goodbye from its client.
    const pids = [
      ...[...clients].map((client) => client.processID),
      ...pools.flatMap(({ clients }) => [...clients].map((client) => client.processID)),
    ].filter(Boolean);
    await db
      .query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [pids])
      .catch(() => {});
    await Promise.all([...clients].map((client) => client.end().catch(() => {})));
    await Promise.all(pools.map(closePool));
    await db.end().catch(() => {});
  }
}

// pool.end() waits for every client to come back, and a leaked client never does. So the harness
// ends each connection itself, then gives pool.end() a moment.
async function closePool({ pool, clients }) {
  await Promise.all([...clients].map((client) => client.end().catch(() => {})));
  await Promise.race([pool.end().catch(() => {}), sleep(500)]);
}

async function open(name) {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    application_name: `lab: ${name}`,
    options: UNTRACKED,
  });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    throw new HarnessError(
      `Can't connect to PostgreSQL at ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")} (${error.message}).\n` +
        "Start it with `docker compose up -d --wait` in postgres-production, then run the test again.",
    );
  }
  return client;
}

/**
 * Reads a SQL file into statements, each with its line number.
 * Returns { statements } or { problems } when the file is empty or can't be read.
 * @returns {Promise<{ statements?: { sql: string, line: number, text: string }[], problems?: string[] }>}
 */
export async function readSqlFile(file) {
  const name = fileName(file);
  let parsed;
  try {
    parsed = parseSqlFile(await readFile(file, "utf8"));
  } catch (error) {
    return { problems: [`${name}, ${error.message}`] };
  }
  const statements = [];
  for (const statement of parsed) {
    const variable = statement.parts.find((part) => part.kind === "var");
    if (statement.gset || variable) {
      return {
        problems: [
          `${name}, line ${statement.line}: the test runs plain SQL, without psql variables or \\gset.`,
        ],
      };
    }
    const sql = statement.parts.map((part) => part.text).join("").trim();
    statements.push({ sql, line: statement.line, text: describe(statement) });
  }
  if (statements.length === 0) return { problems: [`${name} has no SQL in it.`] };
  return { statements };
}

/**
 * Imports the module you edit and checks its exports.
 * Returns { app } or { problems } when it doesn't load.
 */
export async function loadModule(file, exports) {
  let app;
  try {
    app = await import(file.href);
  } catch (error) {
    return { problems: [`${fileName(file)} doesn't load: ${error.message}`] };
  }
  const missing = exports.filter((name) => typeof app[name] !== "function");
  if (missing.length) {
    return {
      problems: missing.map((name) => `${fileName(file)} doesn't export a function called ${name}.`),
    };
  }
  return { app };
}

/**
 * Drops each index on the tables that no constraint owns, so indexes from an earlier run, or
 * from psql, don't change the next run. Primary keys and unique constraints stay.
 */
export async function dropAddedIndexes(db, tables) {
  const { rows } = await db.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_index AS i
       JOIN pg_class AS c ON c.oid = i.indexrelid
       JOIN pg_namespace AS n ON n.oid = c.relnamespace
      WHERE i.indrelid = ANY ($1::regclass[])
        AND NOT EXISTS (SELECT FROM pg_constraint WHERE conindid = i.indexrelid)`,
    [tables],
  );
  for (const { name } of rows) await db.query(`DROP INDEX ${name}`);
}

/** Runs the lab's setup SQL, with a message that helps when it can't. */
export async function setUp(db, run) {
  try {
    await db.query("SET lock_timeout = '5s'");
    await run();
    await db.query("RESET lock_timeout");
  } catch (error) {
    throw new HarnessError(
      `The test couldn't put the lab's tables back to the start: ${error.message}\n` +
        (error.code === "55P03"
          ? "Another session holds a lock on them. If you have a transaction open in psql, end it with ROLLBACK or COMMIT."
          : "If you changed the tables by hand, run `npm run reset`."),
    );
  }
}

export function fileName(url) {
  return url.pathname.split("/").at(-1);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Settles with the promise's outcome, or with { timedOut: true } after ms.
 * @returns {Promise<{ value?: unknown, error?: any, timedOut?: boolean }>}
 */
export async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const CODE_NAMES = {
  "23505": "unique_violation",
  "23514": "check_violation",
  "25001": "active_sql_transaction",
  "25P02": "in_failed_sql_transaction",
  "40P01": "deadlock_detected",
  "42P07": "duplicate_table",
  "55P03": "lock_not_available",
  "57014": "query_canceled",
};

/** An error as one line: its code, when PostgreSQL sent one, and its message. */
export function describeError(error) {
  const code = error.code && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  return code ? `${code}${CODE_NAMES[code] ? ` ${CODE_NAMES[code]}` : ""}: ${error.message}` : error.message;
}

/** Milliseconds as text: "840 ms" or "2.3 s". */
export function ms(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
}
