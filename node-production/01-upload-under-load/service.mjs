// The receipts service's upload route. The mobile app uploads a photo or a PDF of a receipt:
//
//   PUT /receipts/r-1001?total=59.00&country=DE, with the file as the body
//   -> 201 { id, bytes, vat }
//
// The route saves the file to storage, then asks the tax API for the receipt's VAT:
//
//   POST {taxUrl}/vat, with { id, total, country } as JSON  ->  { vat }
//
// The tax API is flaky: it sometimes answers 503, and sometimes doesn't answer at all.
//
// The limits it should keep:
// - A receipt is at most 10 MB. A bigger body gets 413 { error: "Body too large" }.
// - The mobile app gives up after 2 seconds. So a request gets 1.5 seconds in all, for the body
//   and the tax calls. Past that, it gets 503 { error: "Timed out" }.
// - One call to the tax API gets 500 ms, and a request tries it up to 3 times.
// - When the client leaves, the work for it stops.
// - The service runs at most 4 uploads at once. Past that, it answers 503 { error: "Server busy" }
//   right away.
//
// The test runs createService in a process of its own, the way production does, and calls
// server.listen. storage.createWriteStream(name) returns a writable stream: storage keeps the
// file when the stream finishes, and discards it when the stream is destroyed first.

import http from "node:http";
import { finished } from "node:stream/promises";

export function createService({ storage, taxUrl }) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://receipts");
    const id = /^\/receipts\/([\w-]+)$/.exec(url.pathname)?.[1];
    if (req.method !== "PUT" || !id) return sendJson(res, 404, { error: "Not found" });

    try {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const file = Buffer.concat(chunks);

      const out = storage.createWriteStream(id);
      out.end(file);
      await finished(out);

      const receipt = { id, total: Number(url.searchParams.get("total")), country: url.searchParams.get("country") };
      const vat = await getVat(taxUrl, receipt);
      sendJson(res, 201, { id, bytes: file.length, vat });
    } catch (error) {
      console.error("upload failed", error);
      sendJson(res, 500, { error: "Something went wrong" });
    }
  });
}

// The tax API recovers in the end, so keep trying.
async function getVat(taxUrl, receipt) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${taxUrl}/vat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(receipt),
      });
      if (response.ok) return (await response.json()).vat;
      await response.body?.cancel().catch(() => {});
    } catch {
      // couldn't connect, so try again
    }
    await sleep(100 * attempt);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendJson(res, status, body) {
  if (res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
