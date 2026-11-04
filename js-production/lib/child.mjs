// Runs one lab in this process, which lib/harness.mjs started with --expose-gc, and sends the
// result to the parent: { problems } or { harnessError }.
//
// The test gets a LabContext. Its servers listen on 127.0.0.1, on a random port. When the lab
// ends, pass or fail, this file closes each server and every socket on it, including requests
// that are still waiting for an answer.

import http from "node:http";
import { LAB_TIMEOUT_MS } from "./harness.mjs";

/**
 * @typedef {object} LabContext
 * @property {URL} file The file the learner edits, or the solution.
 * @property {(handler: http.RequestListener) => Promise<string>} serve Starts an HTTP server and
 *   returns its URL, such as http://127.0.0.1:53124. The harness closes it when the lab ends.
 * @property {() => Promise<void>} collectGarbage Runs the garbage collector until it has freed
 *   everything that nothing reaches, so a WeakRef shows what's still alive.
 * @property {{ unhandled: unknown[], uncaught: unknown[], warnings: Error[] }} events What went
 *   wrong outside the test's own calls. A test can take the items it reports itself out of the
 *   lists. The harness reports what's left.
 */

const [testHref, fileHref] = process.argv.slice(2);

// An unhandled rejection or an uncaught exception would stop a real app's process. Here the lab
// keeps running, and the harness reports it.
const events = { unhandled: [], uncaught: [], warnings: [] };
process.on("unhandledRejection", (reason) => events.unhandled.push(reason));
process.on("uncaughtException", (error) => events.uncaught.push(error));
// Node prints warnings, such as MaxListenersExceededWarning, to stderr. The labs report them
// with the rest of the problems, once per run, so the output stays readable.
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

async function collectGarbage() {
  // A WeakRef keeps its target alive until the current job ends, so the collector runs between
  // turns of the event loop.
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.gc();
  }
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
  if (typeof globalThis.gc !== "function") {
    send({ harnessError: "The lab needs Node's --expose-gc flag. Run it with `npm test`." });
  } else {
    const ctx = { file: new URL(fileHref), serve, collectGarbage, events };
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
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
    }
    problems.push(...leftovers(events));
    send({ problems });
  }
}

function leftovers({ unhandled, uncaught, warnings }) {
  const problems = [];
  if (unhandled.length) {
    problems.push(
      `${count(unhandled.length, "promise")} rejected with no handler, so Node would stop the app's process. ` +
        `The first: ${describeError(unhandled[0])}.`,
    );
  }
  if (uncaught.length) {
    problems.push(
      `${count(uncaught.length, "error")} went uncaught, so Node would stop the app's process. ` +
        `The first: ${describeError(uncaught[0])}.`,
    );
  }
  if (warnings.length) problems.push(`Node printed ${warnings[0].name}: ${warnings[0].message}`);
  return problems;
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function describeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
