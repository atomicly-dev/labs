// Runs a lab: it loads the module you edit, and the lab's test drives it like an app would, with
// pg pools and many requests at once. Then the test reports what went wrong.
//
// The harness keeps track of every pool the test makes. When the lab ends, it closes each pool's
// connections, even the ones a bug never gave back, so a stuck lab can't hang the next one.

import pg from "pg";
import { DATABASE_URL, PGBOUNCER_URL } from "./urls.mjs";

export { DATABASE_URL, PGBOUNCER_URL };

const LAB_TIMEOUT_MS = 15_000;

/**
 * @typedef {object} LabContext
 * @property {Record<string, unknown>} app The module you edit.
 * @property {pg.Client} db A connection to PostgreSQL for the test's own queries.
 * @property {(pool: pg.Pool) => pg.Pool} track Makes the harness close the pool when the lab ends.
 */

/**
 * @typedef {object} Lab
 * @property {string} file The module the learner edits, relative to the lab's folder.
 * @property {string} lesson
 * @property {string[]} exports The functions the module must export.
 * @property {(ctx: LabContext) => Promise<string[]>} run
 *   Drives the module. Returns what went wrong, or an empty list when the lab passes.
 */

export class HarnessError extends Error {}

/**
 * Runs the lab once. Returns { ok, problems }.
 * @param {Lab} lab
 * @param {URL} moduleFile
 */
export async function runLab(lab, moduleFile) {
  let app;
  try {
    app = await import(moduleFile.href);
  } catch (error) {
    if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes(moduleFile.pathname)) {
      throw new HarnessError(`Can't find ${moduleFile.pathname}.`);
    }
    return { ok: false, problems: [`${fileName(moduleFile)} doesn't load: ${error.message}`] };
  }
  const missing = lab.exports.filter((name) => typeof app[name] !== "function");
  if (missing.length) {
    return {
      ok: false,
      problems: missing.map((name) => `${fileName(moduleFile)} doesn't export a function called ${name}.`),
    };
  }

  const db = await connect(DATABASE_URL, "PostgreSQL");
  await connect(PGBOUNCER_URL, "PgBouncer").then((client) => client.end());
  const pools = [];
  const track = (pool) => {
    const clients = new Set();
    // A connection that the harness closes, or that the server ends, emits an error. The request
    // that used it reports the error already, so the harness only keeps it from crashing Node.
    pool.on("error", () => {});
    pool.on("connect", (client) => {
      clients.add(client);
      client.on("error", () => {});
      client.on("end", () => clients.delete(client));
    });
    pools.push({ pool, clients });
    return pool;
  };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve([`The lab didn't finish within ${LAB_TIMEOUT_MS / 1000} seconds.`]),
      LAB_TIMEOUT_MS,
    );
  });
  try {
    const problems = await Promise.race([lab.run({ app, db, track }), timeout]);
    return { ok: problems.length === 0, problems };
  } finally {
    clearTimeout(timer);
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

async function connect(url, server) {
  const client = new pg.Client({ connectionString: url, application_name: "lab: test" });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    throw new HarnessError(
      `Can't connect to ${server} at ${url.replace(/:[^:@/]*@/, ":***@")} (${error.message}).\n` +
        "Start it with `docker compose up -d --wait` in postgres-pooling, then run the test again.",
    );
  }
  return client;
}

function fileName(url) {
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
  "53300": "too_many_connections",
  "57014": "query_canceled",
  "22P02": "invalid_text_representation",
  "42704": "undefined_object",
};

/** An error as one line: its code, when PostgreSQL sent one, and its message. */
export function describeError(error) {
  const code = error.code && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
  return code ? `${code}${CODE_NAMES[code] ? ` ${CODE_NAMES[code]}` : ""}: ${error.message}` : error.message;
}
