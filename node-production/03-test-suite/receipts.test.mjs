// Integration tests for the receipts service in service.mjs. They start the real service on a
// random port, with in-memory storage and a fake tax API, and send it real HTTP requests.
//
// The lab runs this file against service.mjs, where every test must pass, and against 3 copies
// of the service with a bug each, where a test must fail. When the tests finish, nothing may
// stay open. README.md says what to add. Run it yourself with `node --test 03-test-suite/`.

import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createStorage } from "./fakes.mjs";
import { createService } from "./service.mjs";

let storage;
let taxApi;
let service;
let baseUrl;

before(async () => {
  // The fake tax API answers every call with the VAT for Germany, 19%.
  taxApi = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const receipt = JSON.parse(text);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ vat: Math.round(receipt.total * 19) / 100 }));
  });
  await new Promise((resolve) => taxApi.listen(0, "127.0.0.1", resolve));

  storage = createStorage();
  service = createService({ storage, taxUrl: `http://127.0.0.1:${taxApi.address().port}` });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${service.address().port}`;
});

after(async () => {
  await new Promise((resolve) => service.close(resolve));
});

test("saves a receipt and returns its VAT", async () => {
  const response = await fetch(`${baseUrl}/receipts/r-1001?total=59.00&country=DE`, {
    method: "PUT",
    body: Buffer.alloc(300_000, "r"),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "r-1001", bytes: 300_000, vat: 11.21 });
  assert.equal(storage.files.get("r-1001").length, 300_000);
});

// Add the tests here.
