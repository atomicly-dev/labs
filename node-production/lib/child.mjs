// Runs one lab in this process, which lib/harness.mjs started, and sends the result to the
// parent: { problems } or { harnessError }.
//
// The test gets a LabContext. Its servers listen on 127.0.0.1, on a random port. When the lab
// ends, pass or fail, this file runs the test's cleanups, such as stopping the service's process,
// then closes each server and every socket on it, including requests that still wait for an
// answer.

import http from "node:http";
import { LAB_TIMEOUT_MS } from "./harness.mjs";

/**
 * @typedef {object} LabContext
 * @property {URL} file The file the learner edits, or the solution.
 * @property {(handler: http.RequestListener) => Promise<string>} serve Starts an HTTP server and
 *   returns its URL, such as http://127.0.0.1:53124. The harness closes it when the lab ends.
 * @property {(cleanup: () => unknown) => void} defer Runs cleanup when the lab ends, pass or fail.
 * @property {{ unhandled: unknown[], uncaught: unknown[], warnings: Error[] }} events What went
 *   wrong in the test's own process, outside its calls. The harness reports it.
 */

const [testHref, fileHref] = process.argv.slice(2);

const events = { unhandled: [], uncaught: [], warnings: [] };
process.on("unhandledRejection", (reason) => events.unhandled.push(reason));
process.on("uncaughtException", (error) => events.uncaught.push(error));
process.removeAllListeners("warning");
process.on("warning", (warning) => events.warnings.push(warning));

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
  const ctx = { file: new URL(fileHref), serve, defer, events };
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve([`The lab didn't finish within ${LAB_TIMEOUT_MS / 1000} seconds.`]),
      LAB_TIMEOUT_MS,
    );
  });
  let problems;
  try {
    problems = await Promise.race([lab.run(ctx), timeout]);
  } catch (error) {
    problems = [`The test itself failed: ${error.stack}`];
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
  problems.push(...leftovers(events));
  send({ problems });
}

function leftovers({ unhandled, uncaught, warnings }) {
  const problems = [];
  if (unhandled.length) problems.push(`The test's own process had a rejection with no handler: ${describeError(unhandled[0])}.`);
  if (uncaught.length) problems.push(`The test's own process had an uncaught error: ${describeError(uncaught[0])}.`);
  if (warnings.length) problems.push(`Node printed ${warnings[0].name}: ${warnings[0].message}`);
  return problems;
}

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
