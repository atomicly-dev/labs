// Runs one lab in this process, which lib/harness.mjs started, and sends the result to the
// parent: { problems } or { harnessError }.
//
// The test gets a LabContext. When the lab ends, pass or fail, this file runs the test's
// cleanups, such as closing pools and stopping workers, then closes each server the test started
// and every socket on it.

import http from "node:http";
import { HarnessError, LAB_TIMEOUT_MS } from "./harness.mjs";

/**
 * @typedef {object} LabContext
 * @property {URL} file The file the learner edits, or the solution.
 * @property {string} fileName Its name, such as config.mjs or solution.mjs.
 * @property {(handler: http.RequestListener) => Promise<string>} serve Starts an HTTP server and
 *   returns its URL, such as http://127.0.0.1:53124. The harness closes it when the lab ends.
 * @property {(cleanup: () => unknown) => void} defer Runs cleanup when the lab ends, pass or fail.
 */

const [testHref, fileHref] = process.argv.slice(2);

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

const servers = [];
async function serve(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const cleanups = [];
function defer(cleanup) {
  cleanups.push(cleanup);
}

function send(message) {
  process.send(message, () => process.exit(0));
}

let lab;
try {
  ({ default: lab } = await import(testHref));
} catch (error) {
  send({ harnessError: `Can't load the lab's test: ${error.message}` });
}

if (lab) {
  const file = new URL(fileHref);
  const ctx = { file, fileName: file.pathname.split("/").at(-1), serve, defer };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve([`The lab didn't finish within ${LAB_TIMEOUT_MS / 1000} seconds.`]),
      LAB_TIMEOUT_MS,
    );
  });
  let problems = [];
  let harnessError = null;
  try {
    problems = await Promise.race([lab.run(ctx), timeout]);
  } catch (error) {
    if (error instanceof HarnessError) harnessError = error.message;
    else problems = [`The test itself failed: ${error.stack}`];
  } finally {
    clearTimeout(timer);
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        problems.push(`The test couldn't clean up: ${error.message}`);
      }
    }
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
  }
  if (harnessError) {
    send({ harnessError });
  } else {
    if (unhandled.length) {
      const reason = unhandled[0];
      problems.push(
        `The test's process had a rejection with no handler: ${reason instanceof Error ? reason.message : String(reason)}.`,
      );
    }
    send({ problems });
  }
}
