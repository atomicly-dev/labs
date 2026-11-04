// Starts the service in its own process, with lib/service-host.mjs, the way production runs it:
// the test talks to it over HTTP, and sends it signals. The process stops when the lab ends.

import { fork } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileName } from "./helpers.mjs";

/**
 * @typedef {object} Service
 * @property {string} url Such as http://127.0.0.1:53124.
 * @property {import("node:child_process").ChildProcess} child
 * @property {(type: string) => Promise<any>} ask Asks the fakes in the service's process.
 * @property {() => Promise<object[]>} events What the fakes recorded, such as the pool closing.
 * @property {object[]} logs The JSON lines the service printed, each with `at`, the time it
 *   arrived, in ms since the service started.
 * @property {Promise<{ code: number | null, signal: string | null }>} exited
 * @property {() => string} stderr What the service printed to stderr so far.
 */

/**
 * @param {import("./child.mjs").LabContext} ctx
 * @param {object} settings The fakes' settings: taxUrl, storageWriteMs, queryMs, stuckQuery, flushMs.
 * @returns {Promise<{ service?: Service, problems?: string[] }>}
 */
export async function startService(ctx, settings) {
  const dir = await mkdtemp(join(tmpdir(), "receipts-service-"));
  ctx.defer(() => rm(dir, { recursive: true, force: true }));
  const eventsFile = join(dir, "events.jsonl");

  const child = fork(new URL("service-host.mjs", import.meta.url), [ctx.file.href, JSON.stringify({ ...settings, eventsFile })], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  ctx.defer(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });

  const started = performance.now();
  const logs = [];
  let stderr = "";
  forwardLines(child.stdout, (line) => {
    // The service's JSON log lines go to the test. Anything else, such as your console.log
    // lines, shows in the output.
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        logs.push({ ...entry, at: Math.round(performance.now() - started) });
        return;
      }
    } catch {}
    process.stdout.write(`${line}\n`);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text;
    process.stderr.write(text);
  });

  let nextId = 1;
  const waiting = new Map();
  const ready = new Promise((resolve) => {
    child.on("message", (message) => {
      if (message.type === "reply") {
        waiting.get(message.id)?.(message.value);
        waiting.delete(message.id);
      } else {
        resolve(message);
      }
    });
    exited.then(() => resolve({ type: "exit" }));
  });

  const first = await ready;
  const name = fileName(ctx.file);
  if (first.type === "error") return { problems: [`${name} ${first.message}`] };
  if (first.type === "exit") {
    return { problems: [`The service's process exited before it listened. ${firstError(stderr)}`.trim()] };
  }

  const service = {
    url: `http://127.0.0.1:${first.port}`,
    child,
    logs,
    exited,
    stderr: () => stderr,
    ask(type) {
      if (!child.connected) return Promise.resolve(null);
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        child.send({ type, id });
        exited.then(() => resolve(null));
      });
    },
    async events() {
      const text = await readFile(eventsFile, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
  return { service };
}

/** The first line of an error's stack in what a process printed, or "". */
export function firstError(stderr) {
  const line = stderr.split("\n").find((text) => /\w*Error\b/.test(text));
  return line ? `It printed: ${line.trim()}` : "";
}

function forwardLines(stream, onLine) {
  stream.setEncoding("utf8");
  let rest = "";
  stream.on("data", (text) => {
    const lines = (rest + text).split("\n");
    rest = lines.pop();
    for (const line of lines) onLine(line);
  });
  stream.on("end", () => {
    if (rest) onLine(rest);
  });
}
