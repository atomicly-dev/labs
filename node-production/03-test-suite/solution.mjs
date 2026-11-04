// Integration tests for the receipts service: one way to write receipts.test.mjs. Run it with
// `node --test 03-test-suite/solution.mjs`, or with `npm test -- 03 --solution`.

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createStorage } from "./fakes.mjs";
import { createService } from "./service.mjs";

let storage;
let taxApi;
let service;
let baseUrl;
// The test that needs a tax call to hang puts a function here. The fake calls it with each
// call's body, req, and res. When it returns true, the test answers the call itself.
let onTaxCall = null;

before(async () => {
  taxApi = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const receipt = JSON.parse(text);
    if (onTaxCall?.(receipt, req, res)) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ vat: Math.round(receipt.total * 19) / 100 }));
  });
  taxApi.listen(0, "127.0.0.1");
  await once(taxApi, "listening");

  storage = createStorage();
  service = createService({ storage, taxUrl: `http://127.0.0.1:${taxApi.address().port}` });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  baseUrl = `http://127.0.0.1:${service.address().port}`;
});

after(async () => {
  // A call a test left hanging would keep close() waiting, so close every connection.
  service.closeAllConnections();
  taxApi.closeAllConnections();
  await Promise.all([new Promise((resolve) => service.close(resolve)), new Promise((resolve) => taxApi.close(resolve))]);
});

function upload(id, body, options = {}) {
  return fetch(`${baseUrl}/receipts/${id}?total=59.00&country=DE`, {
    method: "PUT",
    body,
    signal: AbortSignal.timeout(5000),
    ...options,
  });
}

test("saves a receipt and returns its VAT", async () => {
  const response = await upload("r-1001", Buffer.alloc(300_000, "r"));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "r-1001", bytes: 300_000, vat: 11.21 });
  assert.equal(storage.files.get("r-1001").length, 300_000);
});

test("answers 413 to a receipt over 10 MB, and keeps nothing", async () => {
  const response = await upload("r-1002", Buffer.alloc(12_000_000, "r"));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: "Body too large" });
  assert.equal(storage.files.has("r-1002"), false);
});

test("answers 503 Timed out when the tax API never answers", async (t) => {
  onTaxCall = (receipt) => receipt.id === "r-1003"; // never answer
  t.after(() => (onTaxCall = null));
  const response = await upload("r-1003", "receipt");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Timed out" });
});

// The fake answers 503 a moment after the client leaves. A service that keeps working for a client
// that's gone retries within 150 ms.
test("stops calling the tax API when the client leaves", async (t) => {
  const client = new AbortController();
  let calls = 0;
  onTaxCall = (receipt, req, res) => {
    if (receipt.id !== "r-1004") return false;
    calls++;
    client.abort(); // the user closes the app during the tax call
    setTimeout(() => {
      res.writeHead(503);
      res.end();
    }, 50);
    return true;
  };
  t.after(() => (onTaxCall = null));
  await assert.rejects(upload("r-1004", "receipt", { signal: client.signal }), { name: "AbortError" });
  await sleep(500);
  assert.equal(calls, 1);
});
