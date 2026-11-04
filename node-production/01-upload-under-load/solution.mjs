// The receipts service's upload route. See service.mjs for what it does and how the test runs it.

import http from "node:http";
import { pipeline } from "node:stream/promises";

const MAX_BYTES = 10_000_000; // 10 MB, the largest receipt the app accepts
const DEADLINE_MS = 1500; // the mobile app gives up after 2 seconds
const TRY_TIMEOUT_MS = 500; // one call to the tax API
const MAX_TRIES = 3;
const MAX_IN_FLIGHT = 4;

class BodyTooLarge extends Error {}

export function createService({ storage, taxUrl }) {
  let inFlight = 0;

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://receipts");
    const id = /^\/receipts\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (req.method !== "PUT" || !id) return sendJson(res, 404, { error: "Not found" });

    // Turn away what the service can't serve, before it reads a byte.
    if (inFlight >= MAX_IN_FLIGHT) {
      res.setHeader("Retry-After", "1");
      return sendJson(res, 503, { error: "Server busy" });
    }
    inFlight++;
    // One signal for the whole request: the deadline, or the client leaving.
    const signal = requestSignal(res, DEADLINE_MS);
    try {
      let bytes = 0;
      async function* limitBytes(chunks) {
        for await (const chunk of chunks) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) throw new BodyTooLarge("Body too large");
          yield chunk;
        }
      }
      // The upload goes into storage a chunk at a time, and only while storage keeps up.
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
        console.error("upload failed", error);
        sendJson(res, 500, { error: "Something went wrong" });
      } // else the client left, so there's nobody to answer
    } finally {
      inFlight--;
    }
  });
}

function requestSignal(res, ms) {
  const clientLeft = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) clientLeft.abort();
  });
  return AbortSignal.any([clientLeft.signal, AbortSignal.timeout(ms)]);
}

// Retries a 5xx, a timeout, and a call that couldn't connect, until the request's signal aborts.
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
