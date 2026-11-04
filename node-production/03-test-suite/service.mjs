// The receipts service, as lab 01 left it. Your suite in receipts.test.mjs tests this file. Don't
// change it: the lab runs your suite against it, and against 3 copies with a bug each.
//
//   PUT /receipts/r-1001?total=59.00&country=DE, with the file as the body
//   -> 201 { id, bytes, vat }
//   -> 413 { error: "Body too large" } past maxBytes
//   -> 503 { error: "Timed out" } past deadlineMs, for the body and the tax calls together
//   -> 503 { error: "Server busy" } past maxInFlight uploads at once
//   When the client leaves, the service aborts its tax call, and tries no more.
//
//   GET /receipts/r-1001  ->  200 with the file, or 404 { error: "Not found" }
//
// The tax API:  POST {taxUrl}/vat, with { id, total, country } as JSON  ->  { vat }
// Each call gets 500 ms, and an upload tries up to 3 times, for a 5xx, a timeout, or a call that
// couldn't connect.
//
// createService returns an http.Server that doesn't listen yet. storage needs two methods:
// createWriteStream(name), a writable stream that keeps the file when it finishes, and
// createReadStream(name). fakes.mjs has one that keeps the files in memory.

import http from "node:http";
import { pipeline } from "node:stream/promises";

const TRY_TIMEOUT_MS = 500;
const MAX_TRIES = 3;

class BodyTooLarge extends Error {}

export function createService({ storage, taxUrl, maxBytes = 10_000_000, deadlineMs = 1500, maxInFlight = 4 }) {
  let inFlight = 0;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://receipts");
    const id = /^\/receipts\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (req.method === "GET" && id) return download(storage, id, res);
    if (req.method !== "PUT" || !id) return sendJson(res, 404, { error: "Not found" });

    if (inFlight >= maxInFlight) {
      res.setHeader("Retry-After", "1");
      return sendJson(res, 503, { error: "Server busy" });
    }
    // A body that says it's too large gets its 413 before the service reads it. Node then reads
    // and drops the rest, so the client gets the answer, and the connection stays usable.
    if (Number(req.headers["content-length"]) > maxBytes) return sendJson(res, 413, { error: "Body too large" });
    inFlight++;
    const signal = requestSignal(res, deadlineMs);
    try {
      let bytes = 0;
      async function* limitBytes(chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > maxBytes) throw new BodyTooLarge("Body too large");
          yield chunk;
        }
      }
      await pipeline(req, limitBytes, storage.createWriteStream(id), { signal });
      const receipt = { id, total: Number(url.searchParams.get("total")), country: url.searchParams.get("country") };
      const vat = await getVat(taxUrl, receipt, signal);
      sendJson(res, 201, { id, bytes, vat });
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendJson(res, 413, { error: "Body too large" });
      } else if (signal.reason?.name === "TimeoutError") {
        sendJson(res, 503, { error: "Timed out" });
      } else if (!signal.aborted && error.code !== "ECONNRESET") {
        sendJson(res, 502, { error: "Tax API failed" });
      } // else the client left, so there's nobody to answer
    } finally {
      inFlight--;
    }
  });
}

async function download(storage, id, res) {
  let file;
  try {
    file = storage.createReadStream(id);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return sendJson(res, 404, { error: "Not found" });
  }
  res.setHeader("content-type", "application/octet-stream");
  await pipeline(file, res).catch(() => {});
}

function requestSignal(res, ms) {
  const clientLeft = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) clientLeft.abort();
  });
  return AbortSignal.any([clientLeft.signal, AbortSignal.timeout(ms)]);
}

async function getVat(taxUrl, receipt, signal) {
  for (let attempt = 1; ; attempt++) {
    let response = null;
    try {
      response = await fetch(`${taxUrl}/vat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TRY_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
    }
    if (response?.ok) return (await response.json()).vat;
    await response?.body?.cancel().catch(() => {});
    if ((response && response.status < 500) || attempt === MAX_TRIES) {
      throw new Error(`Tax API failed: ${response ? response.status : "no response"}`);
    }
    await sleep(100 * attempt, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function sendJson(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
