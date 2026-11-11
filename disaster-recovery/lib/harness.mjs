// Runs a lab. Each lab's test.mjs drives the file you edit the way an incident would: it sets up
// production's backups and the mistake, runs your restore on the new server beside production,
// then checks the restored server.
//
// The harness keeps track of every connection the test opens, and closes them when the lab ends,
// pass or fail.

import { access } from "node:fs/promises";
import pg from "pg";
import { exec } from "./compose.mjs";

/** Production, which archives its WAL, and the new server beside it, where you restore. */
export const PRODUCTION_URL =
  process.env.PRODUCTION_URL ?? "postgres://postgres:postgres@127.0.0.1:5446/shop";
export const RESTORED_URL =
  process.env.RESTORED_URL ?? "postgres://postgres:postgres@127.0.0.1:5447/shop";

/** The restored server's log, in the restore container. */
export const RESTORED_LOG = "/var/lib/postgresql/restore.log";

const LAB_TIMEOUT_MS = 60_000;
const START_HINT = "Start them with `docker compose up -d --wait` in disaster-recovery, then run the test again.";

/**
 * @typedef {object} LabContext
 * @property {string} lab The lab's folder name, such as 01-point-in-time-restore.
 * @property {string} fileName The file the test runs: the one you edit, or the solution.
 * @property {pg.Client} production A connection to production.
 * @property {(name: string) => Promise<pg.Client | null>} connectRestored Connects to the restored
 *   server, or returns null when nothing answers. The harness closes it when the lab ends.
 */

/**
 * @typedef {object} Lab
 * @property {string} file The file the learner edits, relative to the lab's folder. The solution
 *   is solution.sh, with the same extension.
 * @property {string} lesson
 * @property {(ctx: LabContext) => Promise<string[]>} run
 *   Drives the file. Returns what went wrong, or an empty list when the lab passes.
 */

/** The test can't run at all, such as when a container isn't running. The runner exits with 2. */
export class HarnessError extends Error {}

/**
 * Runs the lab once. Returns { ok, problems }.
 * @param {Lab} lab
 * @param {URL} labDir
 * @param {string} fileName
 */
export async function runLab(lab, labDir, fileName) {
  try {
    await access(new URL(fileName, labDir));
  } catch {
    throw new HarnessError(`Can't find ${new URL(fileName, labDir).pathname}.`);
  }

  const clients = new Set();
  const production = await connect(PRODUCTION_URL, "test", "production");
  clients.add(production);
  const connectRestored = async (name) => {
    try {
      const client = await connect(RESTORED_URL, name, "the restored server");
      clients.add(client);
      return client;
    } catch {
      return null;
    }
  };

  const ctx = { lab: labDir.pathname.split("/").at(-2), fileName, production, connectRestored };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve([`The lab didn't finish within ${LAB_TIMEOUT_MS / 1000} seconds.`]),
      LAB_TIMEOUT_MS,
    );
  });
  try {
    const problems = await Promise.race([lab.run(ctx), timeout]);
    return { ok: problems.length === 0, problems };
  } finally {
    clearTimeout(timer);
    await Promise.all([...clients].map((client) => client.end().catch(() => {})));
  }
}

/** Opens a connection, or throws a HarnessError that says how to start the servers. */
export async function connect(url, name, server) {
  const client = new pg.Client({
    connectionString: url,
    application_name: `lab: ${name}`,
    connectionTimeoutMillis: 3000,
  });
  // A connection that the server ends, such as when the restored server stops, emits an error.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    throw new HarnessError(
      `Can't connect to ${server} at ${url.replace(/:[^:@/]*@/, ":***@")} (${error.message}).\n${START_HINT}`,
    );
  }
  return client;
}

/**
 * Runs a command in a container. Throws a HarnessError when the container isn't running, or when
 * neither docker nor podman is on the PATH.
 * @returns {Promise<{ code: number, output: string }>}
 */
export async function run(service, command, options) {
  const result = await exec(service, command, options);
  if (result.code === 127 || /is not running|no such container|no container with/i.test(result.output)) {
    throw new HarnessError(`Can't run a command in the ${service} container:\n${result.output}\n${START_HINT}`);
  }
  return result;
}

/** The restored server's log, or "" when it has none yet. */
export async function restoredLog() {
  const { output } = await exec("restore", ["sh", "-c", `cat ${RESTORED_LOG} 2>/dev/null || true`]);
  return output;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** An error as one line: its PostgreSQL code, when it has one, and its message. */
export function describeError(error) {
  const code = typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? `${error.code} ` : "";
  return `${code}${error.message}`;
}

/** 1200 as "1,200". */
export function n(value) {
  return value.toLocaleString("en-US");
}
