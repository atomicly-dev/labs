// npm run restore: lab 01 by hand. It runs the incident on production, then your restore.sh on the
// new server, and stops while recovery pauses, so you can check the orders yourself and end
// recovery. `npm run restore -- --solution` runs solution.sh instead.

import { parseArgs } from "node:util";
import { runIncident, startRestore, LOG_FILE } from "../01-point-in-time-restore/test.mjs";
import { HarnessError, runLab } from "./harness.mjs";
import { ensureServers } from "./servers.mjs";

const LAB = "01-point-in-time-restore";
const { values } = parseArgs({ options: { solution: { type: "boolean", default: false } } });
const file = values.solution ? "solution.sh" : "restore.sh";
const dim = (text) => (process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${text}\x1b[0m` : text);

await ensureServers();

const byHand = {
  async run(ctx) {
    console.log(dim("Production: the seed, last night's base backup, this morning's orders, the DELETE, and the orders after it..."));
    const incident = await runIncident(ctx);
    console.log(`The support script's log, in ${LAB}/${LOG_FILE}:`);
    console.log(`  ${incident.startedAt} cleanup-test-orders: started, deleting test orders`);
    console.log(`  ${incident.loggedAt} cleanup-test-orders: DELETE ${incident.deleted}`);
    console.log();

    console.log(dim(`The new server: ${file}, then PostgreSQL starts...`));
    const restore = await startRestore(ctx);
    if (restore.problems) return restore.problems;

    const lines = restore.log
      .split("\n")
      .filter((line) => /recovery|restored log file|pausing|HINT|timeline/.test(line))
      .map((line) => `  ${line.replace(/^\S+ \S+ \S+ \[\d+\] /, "")}`);
    console.log("The restored server's log:");
    console.log(lines.join("\n"));
    console.log();

    if (restore.state === "paused") {
      console.log("Recovery is paused at the target. Check the orders on the restored server:");
      console.log("  npm run db -- restored");
      console.log("  SELECT count(*), max(id), max(ordered_at) FROM orders;");
      console.log();
      console.log("When they're right, end recovery there. A moment later, look at the timeline:");
      console.log("  SELECT pg_wal_replay_resume();");
      console.log("  SELECT pg_is_in_recovery(), timeline_id FROM pg_control_checkpoint();");
    } else {
      console.log("The restored server isn't in recovery: it takes writes already. Look at its orders:");
      console.log("  npm run db -- restored");
      console.log("  SELECT count(*), max(id), max(ordered_at) FROM orders;");
    }
    return [];
  },
};

try {
  const outcome = await runLab(byHand, new URL(`../${LAB}/`, import.meta.url), file);
  for (const problem of outcome.problems) console.log(problem);
  process.exitCode = outcome.ok ? 0 : 1;
} catch (error) {
  if (error instanceof HarnessError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
