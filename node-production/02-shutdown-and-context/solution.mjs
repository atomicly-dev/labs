// The receipts service, with its logs, its background jobs, and its shutdown. See service.mjs for
// what it does and how the test runs it.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { pipeline } from "node:stream/promises";

const TRY_TIMEOUT_MS = 500;
const READY_WAIT_MS = 1000; // how long the load balancer takes to stop sending, measured
const SHUTDOWN_MS = 2000; // requests, background jobs, and the pool
const HARD_SHUTDOWN_MS = 3000; // everything, telemetry included

const requestContext = new AsyncLocalStorage();

function log(level, msg, fields) {
  const { requestId, traceId } = requestContext.getStore() ?? {};
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, requestId, traceId, ...fields }));
}

export function createService({ storage, taxUrl, pool, telemetry }) {
  let shuttingDown = false;
  const running = new Set();

  function track(task) {
    const job = task()
      .catch((error) => log("error", "background job failed", { error: error.message }))
      .finally(() => running.delete(job));
    running.add(job);
  }

  const server = http.createServer((req, res) => {
    if (shuttingDown) res.setHeader("Connection", "close");
    if (req.url === "/ready") {
      res.statusCode = shuttingDown ? 503 : 200;
      return res.end();
    }
    const parent = parseTraceparent(req.headers.traceparent);
    const context = {
      requestId: randomUUID(),
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      flags: parent?.flags ?? "01",
    };
    // Every log line, tax call, and background job this request starts runs in its context.
    requestContext.run(context, () => track(() => handleRequest(req, res)));
  });

  async function handleRequest(req, res) {
    const url = new URL(req.url, "http://receipts");
    const id = /^\/receipts\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (req.method !== "PUT" || !id) return sendJson(res, 404, { error: "Not found" });
    try {
      log("info", "upload started", { receiptId: id });
      await pipeline(req, storage.createWriteStream(id));
      const receipt = { id, total: Number(url.searchParams.get("total")), country: url.searchParams.get("country") };
      const vat = await getVat(taxUrl, receipt);
      sendJson(res, 201, { id, vat });
      log("info", "upload saved");
      track(() => recordInLedger(pool, id, vat));
    } catch (error) {
      log("error", "upload failed", { error: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong" });
    }
  }

  process.on("SIGTERM", async () => {
    log("info", "SIGTERM: shutting down");
    const deadline = AbortSignal.timeout(SHUTDOWN_MS);
    const hardDeadline = AbortSignal.timeout(HARD_SHUTDOWN_MS);
    deadline.addEventListener("abort", () => server.closeAllConnections());
    shuttingDown = true; // /ready fails, so the load balancer stops sending
    try {
      await upTo(deadline, () => sleep(READY_WAIT_MS));
      await upTo(deadline, () => new Promise((resolve) => server.close(resolve)));
      await upTo(deadline, waitForRunning);
      await upTo(deadline, () => pool.end());
    } catch (error) {
      log("error", "shutdown step failed", { error: error.message });
    } finally {
      await upTo(hardDeadline, () => telemetry.shutdown()).catch((error) =>
        log("error", "telemetry flush failed", { error: error.message }),
      );
      process.exit(0);
    }
  });

  async function waitForRunning() {
    while (running.size > 0) await Promise.allSettled(running);
  }

  return server;
}

async function recordInLedger(pool, id, vat) {
  await pool.query("INSERT INTO ledger (receipt_id, vat) VALUES ($1, $2)", [id, vat]);
  log("info", "ledger entry written");
}

async function getVat(taxUrl, receipt) {
  const { traceId, spanId, flags } = requestContext.getStore();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${taxUrl}/vat`, {
      method: "POST",
      headers: { "content-type": "application/json", traceparent: `00-${traceId}-${spanId}-${flags}` },
      body: JSON.stringify(receipt),
      signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
    }).catch(() => null);
    if (response?.ok) return (await response.json()).vat;
    await response?.body?.cancel().catch(() => {});
    log("warn", "tax API failed", { status: response?.status ?? null, attempt });
    if ((response && response.status < 500) || attempt === 3) break;
    await sleep(100 * attempt);
  }
  throw new Error("Tax API failed");
}

function parseTraceparent(header = "") {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(header);
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return null;
  return { traceId: match[1], parentId: match[2], flags: match[3] };
}

function upTo(signal, step) {
  if (signal.aborted) return Promise.resolve();
  return Promise.race([step(), once(signal, "abort")]);
}

const hex = (bytes) => randomBytes(bytes).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
