// The incident, then your restore. On each run:
//
// 1. Production starts again from seed.sql: 1,200 orders. The nightly job takes a base backup with
//    pg_basebackup, into /backups/base. From then on, production's archive_command copies each
//    completed WAL segment into /mnt/archive.
// 2. This morning's 30 orders come in, one checkout at a time.
// 3. The support script logs that it started, runs DELETE FROM orders, and logs `DELETE 1230`.
// 4. 5 more orders come in after the DELETE. Production switches to a new WAL segment, so the
//    archive has every change, and the test writes the support script's log beside restore.sh.
// 5. On the new server, the test runs restore.sh, then starts PostgreSQL on what it put in $PGDATA.
// 6. While recovery pauses at the target, the test checks the orders. Then it ends recovery with
//    pg_wal_replay_resume(), and checks that the server takes writes, on a new timeline.

import { readFile, writeFile } from "node:fs/promises";
import { HarnessError, n, restoredLog, run, sleep } from "../lib/harness.mjs";

const BACKUP_ORDERS = 1200; // In seed.sql, so in last night's base backup: ids 1 to 1200.
const MORNING_ORDERS = 30; // After the base backup, before the DELETE: ids 1201 to 1230.
const LATER_ORDERS = 5; // After the DELETE: ids 1231 to 1235.
const DELETED = BACKUP_ORDERS + MORNING_ORDERS;

export const LOG_FILE = "cleanup-test-orders.log";
const RECOVERY_WAIT_MS = 15_000;

export default {
  file: "restore.sh",
  lesson: "https://atomicly.dev/lessons/dr-pitr",

  async run(ctx) {
    const incident = await runIncident(ctx);
    const restore = await startRestore(ctx);
    if (restore.problems) return restore.problems;

    const { db, state, log } = restore;
    const problems = [];
    const settings = await recoverySettings(db);
    const orders = await countOrders(db);
    const back = orders.backup + orders.morning; // How many of the deleted orders are back.

    // Without recovery.signal (or standby.signal), the server only replays the WAL in the base
    // backup, logs neither line, and ignores restore_command and the target.
    if (!/starting (point-in-time|archive) recovery|entering standby mode/.test(log)) {
      problems.push(
        `The restored server has the ${n(orders.backup)} orders from last night's base backup, but ` +
          `${orders.morning === 0 ? "none" : orders.morning} of the ${MORNING_ORDERS} orders placed this morning, before the DELETE. ` +
          "It started from the base backup alone, and didn't replay production's archived WAL.",
      );
      const ignored = ["restore_command", "recovery_target_time"].filter((name) => settings[name]);
      if (ignored.length) {
        problems.push(
          `${ctx.fileName} sets ${ignored.join(" and ")}, but the server didn't start in recovery mode, ` +
            `so it never used ${ignored.length === 1 ? "it" : "them"}.`,
        );
      }
      return problems;
    }

    if (!settings.recovery_target_time) {
      problems.push(
        `The restored server has ${describeLater(orders)}, and ${back === 0 ? "none" : n(back)} ` +
          `of the ${n(DELETED)} orders the DELETE removed. ` +
          "Recovery replayed all of production's archived WAL, the DELETE too, and then ended.",
      );
      return problems;
    }

    const target = settings.recovery_target_time;
    const stopped = stopLine(log);
    if (state === "promoted") {
      problems.push(
        "The restored server ended recovery as soon as it reached the target, and took writes before anyone could check its orders. " +
          `Recovery should pause at the target${settings.recovery_target_action !== "pause" ? `, but recovery_target_action is '${settings.recovery_target_action}'` : ""}.`,
      );
    }
    if (back === 0) {
      problems.push(
        `The restored server has none of the ${n(DELETED)} orders the DELETE removed: recovery replayed the DELETE too. ` +
          (target === incident.loggedAt
            ? `recovery_target_time is '${target}', the time the support script logged \`DELETE ${incident.deleted}\`. The DELETE had committed by then.`
            : `recovery_target_time is '${target}', after the DELETE committed.`) +
          (stopped ? ` The server's log: "${stopped}".` : ""),
      );
    } else if (orders.backup < BACKUP_ORDERS || orders.morning < MORNING_ORDERS) {
      problems.push(
        `The restored server has ${n(back)} of the ${n(DELETED)} orders the DELETE removed. ` +
          (orders.morning === 0
            ? `It has none of this morning's ${MORNING_ORDERS} orders: recovery_target_time is '${target}', before the first of them.`
            : `It's missing ${MORNING_ORDERS - orders.morning} of this morning's ${MORNING_ORDERS} orders: recovery_target_time is '${target}', before the last of them.`) +
          (stopped ? ` The server's log: "${stopped}".` : ""),
      );
    }
    if (orders.later > 0) {
      problems.push(
        `The restored server has ${describeLater(orders)}. It should be the database as it was just before the DELETE.`,
      );
    }
    if (problems.length) return problems;

    // The orders are right, and recovery is paused, so end it.
    await db.query("SELECT pg_wal_replay_resume()");
    const ended = await waitFor(db, (row) => !row.recovering);
    if (ended.state !== "promoted") {
      return [`After pg_wal_replay_resume(), the restored server was still in recovery ${RECOVERY_WAIT_MS / 1000} seconds later.`];
    }
    const {
      rows: [{ timeline }],
    } = await db.query("SELECT timeline_id AS timeline FROM pg_control_checkpoint()");
    if (timeline < 2) {
      problems.push(`After recovery ended, the restored server is on timeline ${timeline}. It should start a new one.`);
    }
    return problems;
  },
};

/**
 * Production's side of the incident: the seed, the nightly base backup, this morning's orders,
 * the DELETE, and the orders after it. Writes the support script's log beside restore.sh.
 * @param {import("../lib/harness.mjs").LabContext} ctx
 */
export async function runIncident({ production, lab }) {
  const seed = await readFile(new URL("../postgres/seed.sql", import.meta.url), "utf8");
  try {
    await production.query("SET lock_timeout = '5s'");
    await production.query(seed);
  } catch (error) {
    throw new HarnessError(
      `The test couldn't put production's orders back to the start: ${error.message}\n` +
        "If you have a transaction open in psql on production, end it with ROLLBACK or COMMIT.",
    );
  }

  // Last night's backup. Each run starts the archive again from it, so old segments don't pile up.
  const backup = await run(
    "production",
    ["sh", "-c", "rm -rf /backups/base /mnt/archive/* && pg_basebackup -D /backups/base -c fast"],
    { user: "postgres" },
  );
  if (backup.code !== 0) throw new HarnessError(`The nightly base backup failed:\n${backup.output}`);

  const order = (i) =>
    production.query("INSERT INTO orders (customer_id, total) VALUES ($1, $2)", [1 + ((i * 53) % 400), 12 + (i % 9) * 7.5]);
  for (let i = 0; i < MORNING_ORDERS; i++) await order(i);

  // The support script. It logs with the server's clock, the clock that stamps each commit in the WAL.
  await sleep(200);
  const startedAt = await serverTime(production);
  await sleep(300);
  const { rowCount: deleted } = await production.query("DELETE FROM orders");
  await sleep(100);
  const loggedAt = await serverTime(production);

  await sleep(300);
  for (let i = 0; i < LATER_ORDERS; i++) await order(MORNING_ORDERS + i);

  // Archive the segment with the last orders, so the archive has every change.
  const {
    rows: [{ segment }],
  } = await production.query("SELECT pg_walfile_name(pg_switch_wal()) AS segment");
  await waitForArchive(production, segment);

  await writeFile(
    new URL(`../${lab}/${LOG_FILE}`, import.meta.url),
    `${startedAt} cleanup-test-orders: started, deleting test orders\n` +
      `${loggedAt} cleanup-test-orders: DELETE ${deleted}\n`,
  );
  return { startedAt, loggedAt, deleted };
}

/**
 * Runs the restore script on the new server and starts PostgreSQL there, then waits until recovery
 * pauses or ends. Returns { db, state, log }, or { problems } when the server didn't come up.
 * @param {import("../lib/harness.mjs").LabContext} ctx
 */
export async function startRestore({ lab, fileName, connectRestored }) {
  const result = await run("restore", ["sh", "/labs/lib/restore-server.sh", lab, fileName]);
  if (result.code === 3) {
    return { problems: [`${fileName} failed:`, ...lastLines(result.output, 6)] };
  }
  if (result.code === 5) {
    return {
      problems: [`${fileName} started the server itself. Leave that to the test: it starts the server when ${fileName} is done.`],
    };
  }
  if (result.code !== 0 && result.code !== 4) {
    throw new HarnessError(`The test couldn't run ${fileName} in the restore container:\n${result.output}`);
  }

  const db = result.code === 0 ? await connectRestored("check") : null;
  const outcome = db ? await waitFor(db, (row) => !row.recovering || row.pause === "paused") : { state: "gone" };
  const log = await restoredLog();
  if (outcome.state === "gone") return { problems: notStarted(log) };
  if (outcome.state === "replaying") {
    return {
      problems: [
        `${RECOVERY_WAIT_MS / 1000} seconds after it started, the restored server is still in recovery, and hasn't paused at a target.`,
        ...lastLines(log, 3),
      ],
    };
  }
  return { db, state: outcome.state, log };
}

// Polls the restored server until done(row) is true, for up to RECOVERY_WAIT_MS. The state is
// "paused", "promoted" (recovery ended), "replaying", or "gone" (the server stopped).
async function waitFor(db, done) {
  const deadline = Date.now() + RECOVERY_WAIT_MS;
  for (;;) {
    let row;
    try {
      ({
        rows: [row],
      } = await db.query(
        `SELECT pg_is_in_recovery() AS recovering,
                CASE WHEN pg_is_in_recovery() THEN pg_get_wal_replay_pause_state() END AS pause`,
      ));
    } catch {
      return { state: "gone" };
    }
    const state = !row.recovering ? "promoted" : row.pause === "paused" ? "paused" : "replaying";
    if (done(row) || Date.now() > deadline) return { state };
    await sleep(100);
  }
}

async function recoverySettings(db) {
  const { rows } = await db.query(
    `SELECT name, setting FROM pg_settings
      WHERE name IN ('restore_command', 'recovery_target_time', 'recovery_target_action')`,
  );
  return Object.fromEntries(rows.map((row) => [row.name, row.setting]));
}

async function countOrders(db) {
  const {
    rows: [row],
  } = await db.query(
    `SELECT count(*) FILTER (WHERE id <= $1)::int AS backup,
            count(*) FILTER (WHERE id > $1 AND id <= $2)::int AS morning,
            count(*) FILTER (WHERE id > $2)::int AS later
       FROM orders`,
    [BACKUP_ORDERS, DELETED],
  );
  return row;
}

function describeLater(orders) {
  return orders.later === LATER_ORDERS
    ? `the ${LATER_ORDERS} orders placed after the DELETE`
    : `${orders.later} of the ${LATER_ORDERS} orders placed after the DELETE`;
}

// The server's line about where recovery stopped, without its timestamp and process ID.
function stopLine(log) {
  const line = log.split("\n").find((text) => text.includes("recovery stopping"));
  return line?.replace(/^.*?LOG:\s+/, "");
}

// What the restored server's log says about why it didn't start, or stopped.
function notStarted(log) {
  const lines = log.split("\n").map(withoutPrefix);
  const errors = lines.filter((line) => /^(FATAL|PANIC):|invalid value for parameter/.test(line));
  const problems = ["The restored server stopped. Its log says:"];
  problems.push(...(errors.length ? errors : lastLines(log, 4)).map((line) => `  ${line.trim()}`));

  if (!log.trim()) {
    problems.push("The log is empty. Look at the restore container: docker compose logs restore");
  } else if (/must specify "?restore_command"?/.test(log)) {
    problems.push("Recovery needs restore_command, the shell command that copies each WAL segment from the archive.");
  } else if (/invalid value for parameter "recovery_target_time"/.test(log)) {
    problems.push(
      "PostgreSQL couldn't read the target time. Write it with a numeric offset from UTC, such as 2026-11-11T09:32:08.912+00:00.",
    );
  } else if (/before consistent recovery point/.test(log)) {
    problems.push(
      "The target is before last night's base backup finished, and a base backup can't restore to a time when it was still running.",
    );
  } else if (/recovery ended before configured recovery target was reached/.test(log)) {
    if (/restored log file/.test(log)) {
      problems.push(
        "Recovery replayed every segment in the archive, and still didn't reach the target: the target is after the last change production archived.",
      );
    } else {
      const copyError = lines.find((line) => !/^(LOG|FATAL|HINT|DETAIL|WARNING):/.test(line) && line.trim());
      problems.push(
        "Recovery didn't get a single segment from the archive, so it ran out of WAL before the target." +
          (copyError ? ` restore_command failed with: ${copyError.trim()}` : ""),
        "In restore_command, %f is the segment's file name in the archive, and %p is the path to copy it to.",
      );
    }
  } else if (/shutdown at recovery target/.test(log)) {
    problems.push("recovery_target_action is 'shutdown', so the server stopped at the target instead of pausing there.");
  }
  return problems;
}

// A log line without its time and process ID: "LOG:  pausing at the end of recovery".
function withoutPrefix(line) {
  return line.replace(/^\S+ \S+ \S+ \[\d+\] /, "");
}

function lastLines(text, count) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-count)
    .map((line) => `  ${withoutPrefix(line)}`);
}

// The server's clock, as the support script's log shows it: UTC, with a numeric offset.
async function serverTime(db) {
  const { rows } = await db.query(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"+00:00"') AS now`,
  );
  return rows[0].now;
}

async function waitForArchive(db, segment) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await db.query("SELECT last_archived_wal, last_failed_wal FROM pg_stat_archiver");
    if ((rows[0].last_archived_wal ?? "") >= segment) return;
    if (Date.now() > deadline) {
      throw new HarnessError(
        `Production didn't archive WAL segment ${segment} within 10 seconds. ` +
          `Its last failed segment: ${rows[0].last_failed_wal ?? "none"}. Look at \`docker compose logs production\`.`,
      );
    }
    await sleep(50);
  }
}
