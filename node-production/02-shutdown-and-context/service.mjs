// The receipts service, with its logs, its background jobs, and its shutdown. The mobile app
// uploads a receipt:
//
//   PUT /receipts/r-1001?total=59.00&country=DE, with the file as the body  ->  201 { id, vat }
//
// The route saves the file to storage, and asks the tax API for the VAT, with up to 3 tries:
//
//   POST {taxUrl}/vat, with { id, total, country } as JSON  ->  { vat }
//
// After the response, a background job writes the receipt to the ledger with pool.query.
// Lab 01's byte limit, deadline, and cap on uploads are left out, to keep this file short.
//
// Each log line is one JSON object. Every line a request logs, including its background job's,
// should carry the request's requestId and traceId. Each call to the tax API should carry a
// traceparent header, 00-<traceId>-<spanId>-<flags>, so the tax API's logs show the same trace.
// When the mobile app sends a valid traceparent, the request keeps its trace ID and flags.
//
// The load balancer calls GET /ready every 50 ms, and stops sending uploads after 2 failures.
// On SIGTERM, the service should, in this order:
// 1. Fail /ready, and keep serving uploads for 1 second, so the load balancer stops sending.
// 2. Close the server, and wait for the requests and background jobs in progress.
// 3. Close the pool with pool.end().
// 4. Flush the telemetry with telemetry.shutdown(), and exit.
// Steps 1 to 3 get 2 seconds in all, from SIGTERM, and the whole shutdown gets 3 seconds. The
// platform kills the process at 5 seconds.
//
// The test runs createService in a process of its own, the way production does, calls
// server.listen, and sends that process SIGTERM.

import { randomUUID } from "node:crypto";
import http from "node:http";
import { pipeline } from "node:stream/promises";

const TRY_TIMEOUT_MS = 500;

let currentRequestId;

function log(level, msg, fields) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, requestId: currentRequestId, ...fields }));
}

export function createService({ storage, taxUrl, pool, telemetry }) {
  const server = http.createServer((req, res) => {
    if (req.url === "/ready") {
      res.statusCode = 200;
      return res.end();
    }
    currentRequestId = randomUUID();
    handleRequest(req, res);
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
      recordInLedger(pool, id, vat).catch((error) => log("error", "background job failed", { error: error.message }));
    } catch (error) {
      log("error", "upload failed", { error: error.message });
      if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong" });
    }
  }

  process.on("SIGTERM", () => {
    log("info", "SIGTERM: shutting down");
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => server.closeAllConnections(), 10_000);
  });

  return server;
}

async function recordInLedger(pool, id, vat) {
  await pool.query("INSERT INTO ledger (receipt_id, vat) VALUES ($1, $2)", [id, vat]);
  log("info", "ledger entry written");
}

async function getVat(taxUrl, receipt) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${taxUrl}/vat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
