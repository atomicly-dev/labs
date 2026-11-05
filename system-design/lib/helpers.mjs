// Small helpers that the labs' tests share: loading your file, connecting to the services, and
// restarting the API instances.

import { execFile } from "node:child_process";
import pg from "pg";
import { createClient } from "redis";
import { compose, containerCli, PROJECT, servicesDown } from "./compose.mjs";
import { HarnessError } from "./harness.mjs";
import { API_URL } from "./urls.mjs";

const START_HINT = "Start the services with `docker compose up -d --wait` in system-design, then run the test again.";

/**
 * Imports the module you edit and checks its exports.
 * Returns { app } or { problems } when it doesn't load.
 */
export async function loadModule(file, exports) {
  let app;
  try {
    app = await import(file.href);
  } catch (error) {
    return { problems: [`${fileName(file)} doesn't load: ${error.message}`] };
  }
  const missing = exports.filter((name) => typeof app[name] !== "function");
  if (missing.length) {
    return {
      problems: missing.map((name) => `${fileName(file)} doesn't export a function called ${name}.`),
    };
  }
  return { app };
}

export function fileName(url) {
  return url.pathname.split("/").at(-1);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Settles with the promise's outcome, or with { timedOut: true } after ms.
 * @returns {Promise<{ value?: unknown, error?: any, timedOut?: boolean }>}
 */
export async function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
  });
  try {
    return await Promise.race([
      Promise.resolve(promise).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error as one line: its PostgreSQL code, when it has one, and its message. */
export function describeError(error) {
  if (!(error instanceof Error)) return String(error);
  const code = typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? `${error.code} ` : "";
  return `${code}${error.message}`;
}

/** "1 call", "3 calls". */
export function count(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * A pg pool to one of the PostgreSQL servers. The harness closes it when the lab ends.
 * @param {import("./child.mjs").LabContext} ctx
 */
export async function connectPool(ctx, url, name, options = {}) {
  const pool = new pg.Pool({ connectionString: url, max: 10, ...options });
  pool.on("error", () => {});
  ctx.defer(() => pool.end());
  try {
    await pool.query("SELECT 1");
  } catch (error) {
    throw new HarnessError(`Can't connect to ${name} at ${hidePassword(url)} (${error.message}).\n${START_HINT}`);
  }
  return pool;
}

/**
 * A Redis client. The harness closes it when the lab ends.
 * @param {import("./child.mjs").LabContext} ctx
 */
export async function connectRedis(ctx, url) {
  const client = createClient({ url, socket: { reconnectStrategy: false, connectTimeout: 3000 } });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (error) {
    throw new HarnessError(`Can't connect to Redis at ${url} (${error.message}).\n${START_HINT}`);
  }
  ctx.defer(() => client.close());
  return client;
}

/** GETs or POSTs JSON. Throws a HarnessError when nothing answers. */
export async function fetchJson(url, init = {}, service = new URL(url).host) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new HarnessError(`Can't reach ${service} at ${url} (${error.cause?.message ?? error.message}).\n${START_HINT}`);
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status: res.status, body, text };
}

/**
 * Restarts the API containers with a lab's server.mjs and the file to test, and scales them to
 * `instances`. Then it waits until nginx sends requests to every new instance.
 * @returns {Promise<{ health?: object[], problems?: string[] }>} Each instance's /health answer,
 *   or what went wrong when the containers don't start with the file.
 */
export async function startApi({ lab, file, instances }) {
  if (!containerCli()) throw new HarnessError("Lab 01 and lab 06 start the API with docker or podman, and neither is on your PATH.");
  const down = (await servicesDown()).filter((name) => ["nginx", "postgres", "redis"].includes(name));
  if (down.length) throw new HarnessError(`Nothing answers on the port of ${down.join(", ")}.\n${START_HINT}`);

  // Remove the old API containers first. podman-compose doesn't scale a service down, and new
  // containers load the latest file.
  await removeApiContainers();
  const { code } = await compose(["up", "-d", "--wait", "--wait-timeout", "30", "--no-deps", "--scale", `api=${instances}`, "api"], {
    LAB: lab,
    LAB_FILE: file,
  });
  if (code !== 0 && (await apiCrashed())) return { problems: await crashProblems(file) };

  // nginx looks up the instances' addresses every second. Wait until it reaches all of them,
  // and only them.
  const deadline = Date.now() + 20_000;
  let seen = new Map();
  while (Date.now() < deadline) {
    seen = new Map();
    let stale = false;
    for (let i = 0; i < instances * 3; i++) {
      const { status, body } = await fetchJson(`${API_URL}/health`, {}, "nginx").catch(() => ({ status: 0 }));
      if (status !== 200 || body?.lab !== lab || body?.file !== file) {
        stale = true;
        break;
      }
      seen.set(body.instance, body);
    }
    if (!stale && seen.size === instances) return { health: [...seen.values()] };
    await sleep(250);
  }
  if (await apiCrashed()) return { problems: await crashProblems(file) };
  throw new HarnessError(
    `nginx didn't reach ${instances} API instances running ${lab}/${file} within 20 seconds (it reached ${seen.size}). ` +
      "Look at `docker compose logs api nginx`.",
  );
}

const API_FILTERS = ["--filter", `label=com.docker.compose.project=${PROJECT}`, "--filter", "label=com.docker.compose.service=api"];

/** Whether an API container stopped or restarts, as when the lab's file doesn't load. */
async function apiCrashed() {
  const { stdout } = await run(containerCli(), ["ps", "-a", ...API_FILTERS, "--format", "{{.State}}"]);
  return stdout.split(/\s+/).filter(Boolean).some((state) => !/^running$/i.test(state));
}

async function crashProblems(file) {
  const { stdout: ids } = await run(containerCli(), ["ps", "-aq", ...API_FILTERS]);
  const first = ids.split(/\s+/).find(Boolean);
  const { stdout, stderr } = first ? await run(containerCli(), ["logs", "--tail", "15", first]) : { stdout: "", stderr: "" };
  const lines = `${stdout}\n${stderr}`.split("\n").filter((line) => line.trim());
  return [
    `The API containers stopped when they loaded ${file}. The last lines of one container's log:`,
    ...lines.slice(-15).map((line) => `  ${line}`),
  ];
}

async function removeApiContainers() {
  const { stdout } = await run(containerCli(), ["ps", "-aq", ...API_FILTERS]);
  const ids = stdout.split(/\s+/).filter(Boolean);
  if (ids.length) await run(containerCli(), ["rm", "-f", ...ids]);
}

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

function hidePassword(url) {
  return url.replace(/:[^:@/]*@/, ":***@");
}
