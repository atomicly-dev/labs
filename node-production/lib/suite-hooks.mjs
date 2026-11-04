// Loaded with --import before a learner's test suite, by lab 03's test.
//
// - LAB_SERVICE and LAB_SWAP_SERVICE: when the suite imports LAB_SERVICE, it gets
//   LAB_SWAP_SERVICE instead, so the same suite runs against a copy with a bug.
// - LAB_SUITE_DONE: a file. When the suite's last test and hooks have run, this file records
//   it, and, a second later, what's still open, if the process hasn't exited by then.

import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { after } from "node:test";
import { pathToFileURL } from "node:url";

const { LAB_SERVICE, LAB_SWAP_SERVICE, LAB_SUITE_DONE } = process.env;

if (LAB_SERVICE && LAB_SWAP_SERVICE) {
  const target = pathToFileURL(LAB_SERVICE).href;
  const swap = pathToFileURL(LAB_SWAP_SERVICE).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      return result.url === target ? { ...result, url: swap } : result;
    },
  });
}

// A root after hook added here runs before the suite's own root hooks, so the check waits a
// second for them, and for the sockets they close.
after(() => {
  appendFileSync(LAB_SUITE_DONE, `${JSON.stringify({ type: "done" })}\n`);
  setTimeout(() => {
    appendFileSync(LAB_SUITE_DONE, `${JSON.stringify({ type: "open", resources: process.getActiveResourcesInfo() })}\n`);
  }, 1000).unref();
});
