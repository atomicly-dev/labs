// Runs a lab. Each run gets its own Node process, so a run starts with fresh modules, and a lab
// that hangs, or leaves sockets and timers behind, can't change the next run. lib/child.mjs runs
// the lab's test.mjs in that process and sends back what went wrong. The test starts the service
// in a process of its own, with lib/service.mjs.
//
// A run stops after 30 seconds. The child process stops the service and closes every server and
// socket the test opened, even when the lab fails. If it doesn't exit 5 seconds after that, this
// file kills it, and the service's process exits when it loses its parent.

import { fork } from "node:child_process";
import { access } from "node:fs/promises";

export const LAB_TIMEOUT_MS = 30_000;
const KILL_AFTER_MS = LAB_TIMEOUT_MS + 5_000;

/**
 * @typedef {object} Lab
 * @property {string} file The file the learner edits, relative to the lab's folder. The solution
 *   is solution.mjs in the same folder.
 * @property {string} lesson
 * @property {(ctx: import("./child.mjs").LabContext) => Promise<string[]>} run
 *   Drives the file. Returns what went wrong, or an empty list when the lab passes.
 */

export class HarnessError extends Error {}

/**
 * Runs the lab once, in a new process. Returns { ok, problems }.
 * @param {URL} labDir The lab's folder, with test.mjs in it.
 * @param {URL} file The file to test: the learner's file or the solution.
 */
export async function runLab(labDir, file) {
  try {
    await access(file);
  } catch {
    throw new HarnessError(`Can't find ${file.pathname}.`);
  }

  const child = fork(new URL("child.mjs", import.meta.url), [new URL("test.mjs", labDir).href, file.href], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });

  return new Promise((resolve, reject) => {
    let report = null;
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, KILL_AFTER_MS);

    child.on("message", (message) => {
      report = message;
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (report?.harnessError) return reject(new HarnessError(report.harnessError));
      if (report) return resolve({ ok: report.problems.length === 0, problems: report.problems });
      if (killed) {
        return resolve({
          ok: false,
          problems: [
            `The lab didn't finish within ${LAB_TIMEOUT_MS / 1000} seconds, and its process didn't respond, ` +
              "so the test stopped it. Look for a loop that never ends.",
          ],
        });
      }
      resolve({ ok: false, problems: [`The lab's process exited with code ${code} before the test finished.`] });
    });
  });
}
