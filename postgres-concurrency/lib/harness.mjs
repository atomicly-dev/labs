// Runs a lab: the lab's SQL file in several sessions at the same time, then the lab's checks.
//
// Each session is its own connection, like one request in your app. The sessions run the file in
// lockstep: a session starts its next statement only when every other session has finished the
// statement before it, is waiting for a lock, or is done. So all sessions read before any of them
// writes, and a race shows up on every run, not only on an unlucky one. A separate connection
// watches pg_stat_activity to see which sessions wait for a lock, and on whom.

import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, interpolate, parseSqlFile } from "./sql-file.mjs";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5440/shop";

const LAB_TIMEOUT_MS = 15_000;
const POLL_MS = 2;
const MAX_RETRIES = 5;

// psql shows every value as text, so the sessions get every value as text too.
const textTypes = { getTypeParser: () => (value) => value };

/**
 * @typedef {object} SessionResult
 * @property {string} name
 * @property {Record<string, string>} vars The variables at the end, including those from \gset.
 * @property {{ code: string, message: string, line: number, sql: string } | null} error
 * @property {number} retries How many times the session started over after a 40001 error.
 * @property {Set<string>} waitedFor The names of the sessions it waited for a lock on.
 * @property {boolean} finished
 */

/**
 * @typedef {object} Lab
 * @property {string} file The SQL file the learner edits, relative to the lab's folder.
 * @property {string} setup SQL that puts the lab's tables back to the starting state.
 * @property {{ name: string, params: Record<string, string | number> }[]} sessions
 * @property {string[]} [sessionSettings] SET statements each session runs before the file.
 * @property {(ctx: { db: pg.Client, sessions: SessionResult[] }) => Promise<string[]>} check
 *   Returns what went wrong, or an empty list when the lab passes.
 */

export class HarnessError extends Error {}

/**
 * Runs the lab once. Returns { ok, problems, sessions }.
 * @param {Lab} lab
 * @param {URL} sqlFile
 */
export async function runLab(lab, sqlFile) {
  let source;
  try {
    source = await readFile(sqlFile, "utf8");
  } catch {
    throw new HarnessError(`Can't read ${sqlFile.pathname}.`);
  }
  let statements;
  try {
    statements = parseSqlFile(source);
  } catch (error) {
    return { ok: false, problems: [`${fileName(sqlFile)}, ${error.message}`], sessions: [] };
  }
  if (statements.length === 0) {
    return { ok: false, problems: [`${fileName(sqlFile)} has no SQL in it.`], sessions: [] };
  }

  const monitor = await connect("monitor");
  const clients = [];
  try {
    try {
      await monitor.query("SET lock_timeout = '5s'");
      await monitor.query(lab.setup);
    } catch (error) {
      throw new HarnessError(
        `The test couldn't put the lab's rows back to the start: ${error.message}\n` +
          (error.code === "55P03"
            ? "Another session holds a lock on them. If you have a transaction open in psql, end it with ROLLBACK or COMMIT."
            : "If you changed the tables by hand, run `npm run reset`."),
      );
    }
    for (const session of lab.sessions) {
      const client = await connect(session.name);
      clients.push(client);
      for (const setting of [
        "SET lock_timeout = '10s'",
        "SET statement_timeout = '10s'",
        ...(lab.sessionSettings ?? []),
      ]) {
        await client.query(setting);
      }
    }
    const sessions = await runSessions(lab, statements, clients, monitor, sqlFile);
    const problems = sessions.timedOut
      ? sessions.timedOut
      : await lab.check({ db: monitor, sessions: sessions.results });
    return { ok: problems.length === 0, problems, sessions: sessions.results };
  } finally {
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
    await monitor.end().catch(() => {});
  }
}

async function connect(name) {
  const client = new pg.Client({
    connectionString: DATABASE_URL,
    application_name: `lab: ${name}`,
  });
  // A session that the timeout ends emits an error. The session's query reports it already.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    throw new HarnessError(
      `Can't connect to PostgreSQL at ${DATABASE_URL.replace(/:[^:@/]*@/, ":***@")} (${error.message}).\n` +
        "Start it with `docker compose up -d --wait` in postgres-concurrency, then run the test again.",
    );
  }
  return client;
}

async function runSessions(lab, statements, clients, monitor, sqlFile) {
  const states = lab.sessions.map((session, index) => ({
    name: session.name,
    params: session.params,
    client: clients[index],
    pid: clients[index].processID,
    completed: 0, // How many statements of the current attempt have finished.
    running: null, // The statement running now, or null.
    runSeq: 0, // Counts statements started, so a slow lock check can't mark the wrong one.
    blocked: false,
    done: false,
    result: {
      name: session.name,
      vars: {},
      error: null,
      retries: 0,
      waitedFor: new Set(),
      finished: false,
    },
  }));
  const byPid = new Map(states.map((state) => [state.pid, state]));

  let stop = false;
  const watcher = (async () => {
    while (!stop) {
      const seqs = new Map(states.map((state) => [state, state.runSeq]));
      const { rows } = await monitor.query(
        `SELECT pid, pg_blocking_pids(pid) AS blockers
           FROM pg_stat_activity
          WHERE pid = ANY($1) AND wait_event_type = 'Lock'`,
        [states.map((state) => state.pid)],
      );
      const waiting = new Map(rows.map((row) => [row.pid, row.blockers]));
      for (const state of states) {
        const blockers = waiting.get(state.pid);
        const same = seqs.get(state) === state.runSeq && state.running;
        state.blocked = Boolean(blockers && same);
        if (state.blocked) {
          for (const pid of blockers) {
            const other = byPid.get(pid);
            if (other) state.result.waitedFor.add(other.name);
          }
        }
      }
      await sleep(POLL_MS);
    }
  })();

  // A session may start statement i when each other session has finished statement i - 1, is
  // waiting for a lock, or is done.
  const mayStart = (state, i) =>
    states.every(
      (other) => other === state || other.done || other.blocked || other.completed >= i,
    );

  const runOne = async (state) => {
    for (;;) {
      const vars = Object.fromEntries(
        Object.entries(state.params).map(([key, value]) => [key, String(value)]),
      );
      state.completed = 0;
      let retry = false;
      for (const [i, statement] of statements.entries()) {
        while (!mayStart(state, i)) {
          if (stop) {
            state.done = true;
            return;
          }
          await sleep(POLL_MS);
        }
        let sql;
        try {
          sql = interpolate(statement, vars);
        } catch (error) {
          state.result.error = {
            code: "",
            message: error.message,
            line: statement.line,
            sql: describe(statement),
          };
          break;
        }
        state.running = statement;
        state.runSeq++;
        try {
          const result = await state.client.query({ text: sql, types: textTypes });
          if (statement.gset) {
            const last = Array.isArray(result) ? result.at(-1) : result;
            if (last.rows.length !== 1) {
              throw Object.assign(
                new Error(
                  last.rows.length === 0
                    ? "no rows returned for \\gset"
                    : "more than one row returned for \\gset",
                ),
                { code: "" },
              );
            }
            for (const [column, value] of Object.entries(last.rows[0])) {
              vars[statement.gset.prefix + column] = value;
            }
          }
        } catch (error) {
          await state.client.query("ROLLBACK").catch(() => {});
          if (error.code === "40001" && state.result.retries < MAX_RETRIES) {
            state.result.retries++;
            retry = true;
          } else {
            state.result.error = {
              code: error.code ?? "",
              message: error.message,
              line: statement.line,
              sql: describe(statement),
            };
          }
          break;
        } finally {
          state.running = null;
          state.blocked = false;
        }
        state.completed = i + 1;
      }
      state.result.vars = vars;
      if (!retry) break;
    }
    if (!state.result.error && (await rollBackOpenTransaction(state.client))) {
      const last = statements.at(-1);
      state.result.error = {
        code: "",
        message:
          "the file ended with its transaction still open, so the test rolled it back. End it with COMMIT.",
        line: last.line,
        sql: describe(last),
      };
    }
    state.result.finished = !state.result.error;
    state.done = true;
  };

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), LAB_TIMEOUT_MS);
  });
  const outcome = await Promise.race([Promise.all(states.map(runOne)), timeout]);
  clearTimeout(timer);

  let timedOut = null;
  if (outcome === "timeout") {
    stop = true;
    timedOut = [
      `The sessions didn't finish in ${LAB_TIMEOUT_MS / 1000} seconds, so the test stopped them.`,
      ...states
        .filter((state) => !state.done)
        .map((state) =>
          state.running
            ? `${state.name} was ${state.blocked ? "waiting for a lock" : "running"} at ${fileName(sqlFile)} line ${state.running.line}: ${describe(state.running)}`
            : `${state.name} was waiting for the other sessions.`,
        ),
    ];
    await monitor
      .query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [
        states.map((state) => state.pid),
      ])
      .catch(() => {});
  }
  stop = true;
  await watcher.catch(() => {});
  return { results: states.map((state) => state.result), timedOut };
}

// Sends ROLLBACK and returns whether a transaction was open. With no transaction open,
// PostgreSQL answers with the warning 25P01 "there is no transaction in progress".
async function rollBackOpenTransaction(client) {
  let open = true;
  const onNotice = (notice) => {
    if (notice.code === "25P01") open = false;
  };
  client.on("notice", onNotice);
  try {
    await client.query("ROLLBACK");
  } catch {
    return false;
  } finally {
    client.off("notice", onNotice);
  }
  return open;
}

function fileName(url) {
  return url.pathname.split("/").at(-1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One line about a session's error, for a lab's report. */
export function errorLine(session) {
  const { error } = session;
  const code = error.code ? ` (${error.code}${CODE_NAMES[error.code] ? ` ${CODE_NAMES[error.code]}` : ""})` : "";
  return `${session.name} failed at line ${error.line}${code}: ${error.message}`;
}

const CODE_NAMES = {
  "40001": "serialization_failure",
  "40P01": "deadlock_detected",
  "55P03": "lock_not_available",
  "57014": "query_canceled",
  "23505": "unique_violation",
  "23514": "check_violation",
};

/** A line for each error. Sessions that failed the same way share one line. */
export function errorLines(sessions) {
  const groups = new Map();
  for (const session of sessions.filter((session) => session.error)) {
    const key = errorLine({ ...session, name: "" });
    groups.set(key, [...(groups.get(key) ?? []), session.name]);
  }
  return [...groups].map(([line, names]) => `${names.join(", ")}${line}`);
}
