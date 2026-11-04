// Runs your suite, receipts.test.mjs, 4 times at once, each in its own Node process:
//
// - against service.mjs, where every test must pass, and nothing may stay open when it ends;
// - against the 3 copies in broken/, each with one bug, where at least one test must fail.
//
// The suite imports ./service.mjs. For the broken copies, lib/suite-hooks.mjs makes that import
// load the copy instead, so your file runs unchanged. lib/suite-reporter.mjs records each test's
// result. A run that doesn't end within 20 seconds is stopped.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count, list, sleep, within } from "../lib/helpers.mjs";

const RUN_MS = 20_000;
const EXIT_AFTER_DONE_MS = 1500;

const BROKEN = [
  {
    file: "broken/no-byte-limit.mjs",
    what: "has no byte limit",
    sees: "a 12 MB upload gets 201, and storage keeps the file",
    add: 'a test that a receipt over 10 MB gets 413 { error: "Body too large" }, and that storage doesn\'t keep it',
  },
  {
    file: "broken/timeout-as-502.mjs",
    what: "answers 502 to a request past its deadline",
    sees: 'when the tax API never answers, the upload gets 502 { error: "Tax API failed" }, so the mobile app shows a tax error and doesn\'t retry',
    add: 'a test with a fake tax API that never answers, where the upload gets 503 { error: "Timed out" }',
  },
  {
    file: "broken/ignores-client-leaving.mjs",
    what: "doesn't notice when the client leaves",
    sees: "when the user closes the app during an upload, the service keeps calling the tax API, with retries, for nobody",
    add: "a test where the client aborts its request during the tax call, and the fake tax API gets no more calls for that upload",
  },
];

export default {
  file: "receipts.test.mjs",
  lesson: "https://atomicly.dev/lessons/node-test",

  async run(ctx) {
    const labDir = new URL("./", import.meta.url);
    const dir = await mkdtemp(join(tmpdir(), "receipts-suite-"));
    ctx.defer(() => rm(dir, { recursive: true, force: true }));

    const runs = await Promise.all([
      runSuite(ctx, { labDir, dir, run: 0, swap: null, show: true }),
      ...BROKEN.map((broken, i) => runSuite(ctx, { labDir, dir, run: i + 1, swap: broken.file, show: false })),
    ]);
    const [real, ...broken] = runs;
    const problems = [];

    if (real.hung) {
      problems.push(
        `Against the real service, your suite didn't finish within ${RUN_MS / 1000} seconds. A test waits for something that never comes.`,
      );
    } else if (real.results.length === 0) {
      problems.push(`Your suite ran no tests. ${loadError(real) || "Add tests with test() from node:test."}`.trim());
    } else {
      const failed = real.results.filter((result) => result.type === "fail");
      if (failed.length) {
        problems.push(
          `Your suite fails against the real service, so it would block every deploy: ${count(failed.length, "test")} failed, ` +
            `such as "${failed[0].name}", with ${failed[0].error ?? "no error message"}.`,
        );
      }
      if (real.open) {
        problems.push(
          `After your tests finished, the suite's process didn't exit, because ${describeOpen(real.open)}. ` +
            "`node --test` waits for it, so a CI job hangs until it times out. Close everything you started, in after().",
        );
      }
    }

    BROKEN.forEach((bug, i) => {
      const run = broken[i];
      if (run.hung) {
        problems.push(
          `Against a copy of the service that ${bug.what}, your suite didn't finish within ${RUN_MS / 1000} seconds. ` +
            "A test waits for something that never comes. Give it a timeout, so a broken service fails the test instead of hanging the suite.",
        );
      } else if (run.results.length > 0 && !run.results.some((result) => result.type === "fail")) {
        problems.push(`Your suite passes against a copy of the service that ${bug.what}: there, ${bug.sees}. Add ${bug.add}.`);
      }
    });

    return problems;
  },
};

async function runSuite(ctx, { labDir, dir, run, swap, show }) {
  const resultsFile = join(dir, `results-${run}.jsonl`);
  const doneFile = join(dir, `done-${run}.jsonl`);
  const child = spawn(
    process.execPath,
    [
      "--import",
      new URL("../lib/suite-hooks.mjs", import.meta.url).href,
      "--test-reporter",
      new URL("../lib/suite-reporter.mjs", import.meta.url).href,
      "--test-reporter-destination",
      resultsFile,
      fileURLToPath(ctx.file),
    ],
    {
      cwd: fileURLToPath(labDir),
      env: {
        ...process.env,
        LAB_SERVICE: fileURLToPath(new URL("service.mjs", labDir)),
        LAB_SWAP_SERVICE: swap ? fileURLToPath(new URL(swap, labDir)) : "",
        LAB_SUITE_DONE: doneFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  ctx.defer(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  let stderr = "";
  child.stdout.on("data", (chunk) => show && process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (show) process.stderr.write(chunk);
  });

  // Wait for the process to exit, or for the suite to finish and the process to stay.
  const started = performance.now();
  let doneAt = null;
  let hung = false;
  let open = null;
  while (child.exitCode === null && child.signalCode === null) {
    const lines = await readLines(doneFile);
    if (doneAt === null && lines.some((line) => line.type === "done")) doneAt = performance.now();
    if (doneAt !== null && performance.now() - doneAt > EXIT_AFTER_DONE_MS) {
      open = lines.find((line) => line.type === "open")?.resources ?? ["something"];
      break;
    }
    if (doneAt === null && performance.now() - started > RUN_MS) {
      hung = true;
      break;
    }
    await within(exited, 50);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  const exitCode = await exited;
  await sleep(0);
  const results = await readLines(resultsFile);
  return { exitCode, results, hung, open, stderr };
}

async function readLines(path) {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function describeOpen(resources) {
  const counts = new Map();
  for (const name of resources) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [];
  for (const [name, n] of counts) {
    if (name === "TCPServerWrap") parts.push(n === 1 ? "a server still listened" : `${n} servers still listened`);
    else if (name === "TCPSocketWrap") parts.push(n === 1 ? "a socket was still open" : `${n} sockets were still open`);
    else if (name === "Timeout") parts.push(n === 1 ? "a timer still waited" : `${n} timers still waited`);
    else if (name !== "Immediate" && name !== "PipeWrap") parts.push(`${n} ${name}`);
  }
  return parts.length ? list(parts) : "something stayed open";
}

function loadError(run) {
  const line = run.stderr.split("\n").find((text) => /\w*Error\b/.test(text));
  return line ? `It stopped with ${line.trim()}` : "";
}
