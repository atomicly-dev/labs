// Starts the receipts service in its own process, with fake storage that writes a chunk per
// millisecond, and a real tax API on a random port. The tax API's behavior depends on the
// receipt:
//
// - r-1001 and r-1002 answer right away. r-1002 is an 8 MB upload, to measure the memory it takes.
// - r-1003 is a 12 MB upload, over the 10 MB limit.
// - r-1004 answers 503 to its first call, then answers.
// - r-1005 never answers. r-1006's client sends 1 KB, then nothing more.
// - r-1007 answers 503 after 50 ms, every time. Its client leaves during the first call.
// - r-1010 to r-1015 arrive at once, and the tax API holds their calls until all 6 got a call or
//   a response.
//
// The test sends each upload, then checks what the client got, what storage kept, and what the
// tax API saw.

import http from "node:http";
import { count, describeError, readJson, sendJson, sleep, within } from "../lib/helpers.mjs";
import { firstError, startService } from "../lib/service.mjs";

const MB = 1_000_000;
const CLIENT_WAIT_MS = 5000; // generous: the deadline is 1.5 seconds
const MAX_IN_FLIGHT = 4;
const VAT_RATES = { DE: 0.19, FR: 0.2 };

export default {
  file: "service.mjs",
  lesson: "https://atomicly.dev/lessons/node-request-limits",

  async run(ctx) {
    // What the tax API saw, per receipt.
    const calls = new Map(); // id -> [{ at, closed }]
    let held = []; // r-1010 to r-1015 calls waiting for release
    let release = null;
    let heldNow = 0;
    let heldPeak = 0;

    const taxUrl = await ctx.serve(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/vat") return sendJson(res, 404, { error: "Not found" });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "The body isn't JSON" });
      }
      const call = { at: performance.now(), closed: false };
      const list = calls.get(body.id) ?? [];
      list.push(call);
      calls.set(body.id, list);
      res.on("close", () => (call.closed = true));
      const answer = () => sendJson(res, 200, { vat: Math.round(body.total * (VAT_RATES[body.country] ?? 0) * 100) / 100 });

      if (body.id === "r-1004" && list.length === 1) return sendJson(res, 503, { error: "Service Unavailable" });
      if (body.id === "r-1005") return; // never answers
      if (body.id === "r-1007") {
        await sleep(50);
        return sendJson(res, 503, { error: "Service Unavailable" });
      }
      if (/^r-101\d$/.test(body.id)) {
        heldNow++;
        heldPeak = Math.max(heldPeak, heldNow);
        res.on("close", () => heldNow--);
        held.push(answer);
        release?.();
        return;
      }
      answer();
    });

    const started = await startService(ctx, { taxUrl, storageWriteMs: 1 });
    if (started.problems) return started.problems;
    const { service } = started;
    const problems = [];
    const stats = async () => (await service.ask("stats")) ?? { files: {}, discarded: [], peakHeld: 0 };
    const crashed = () => {
      if (service.child.exitCode === null && service.child.signalCode === null) return false;
      problems.push(`The service's process crashed, so every upload after that failed. ${firstError(service.stderr())}`.trim());
      return true;
    };

    // 1. A receipt of 300 KB.
    const small = await upload(service.url, "r-1001", 300_000, "59.00", "DE");
    if (small.status !== 201 || small.body?.vat !== 11.21) {
      problems.push(
        `A 300 KB receipt for 59.00 in DE should get 201 with { id: "r-1001", bytes: 300000, vat: 11.21 }, and got ${describe(small)}.`,
      );
    }
    if (crashed()) return problems;

    // 2. An 8 MB receipt: how much of it does the service hold at once?
    await service.ask("reset-held");
    const big = await upload(service.url, "r-1002", 8 * MB, "120.00", "FR");
    const afterBig = await stats();
    if (big.status !== 201) problems.push(`An 8 MB receipt should get 201, and got ${describe(big)}.`);
    if (afterBig.peakHeld > 1 * MB) {
      problems.push(
        `While a customer uploaded an 8 MB receipt, the service held ${mb(afterBig.peakHeld)} of it in memory at once. ` +
          `With 50 uploads like it at the same time, that's ${mb(afterBig.peakHeld * 50)}. ` +
          "Storage only needs the bytes in order, so stream them into it.",
      );
    }
    if (crashed()) return problems;

    // 3. A 12 MB receipt, over the limit.
    await service.ask("reset-held");
    const huge = await upload(service.url, "r-1003", 12 * MB, "80.00", "DE");
    const afterHuge = await stats();
    if (huge.status !== 413 || huge.body?.error !== "Body too large") {
      problems.push(
        `A 12 MB upload should get 413 { error: "Body too large" }, because a receipt is at most 10 MB. It got ${describe(huge)}` +
          (afterHuge.files["r-1003"] ? ", and storage kept the file." : "."),
      );
    } else if (afterHuge.files["r-1003"]) {
      problems.push("The 12 MB upload got its 413, but storage kept the file anyway.");
    }
    if (afterHuge.peakHeld > 1 * MB && afterBig.peakHeld <= 1 * MB) {
      problems.push(`During the 12 MB upload, the service held ${mb(afterHuge.peakHeld)} of it in memory at once.`);
    }
    if (crashed()) return problems;

    // 4. The tax API fails once.
    const flaky = await upload(service.url, "r-1004", 1000, "10.00", "DE");
    if (flaky.status !== 201 || flaky.body?.vat !== 1.9) {
      problems.push(
        `The tax API answered 503 to r-1004's first call, then answered. The upload should still get 201 with vat 1.9, after a retry, and got ${describe(flaky)}.`,
      );
    }

    // 5. The tax API never answers r-1005, and r-1006's client stops sending, at the same time.
    const [slowTax, slowBody] = await Promise.all([
      upload(service.url, "r-1005", 1000, "10.00", "DE"),
      stalledUpload(ctx, service.url, "r-1006"),
    ]);
    await sleep(300); // calls the deadline aborted close a moment later on the tax API's side
    if (slowTax.timedOut) {
      problems.push(
        `The tax API never answered r-1005. The mobile app waited ${CLIENT_WAIT_MS / 1000} seconds and got no response. ` +
          'It should get 503 { error: "Timed out" } within the 1.5-second deadline, while the app still waits.',
      );
    } else if (slowTax.status !== 503 || slowTax.body?.error !== "Timed out") {
      problems.push(`The tax API never answered r-1005, so its upload should get 503 { error: "Timed out" }, and got ${describe(slowTax)}.`);
    } else {
      const r1005 = calls.get("r-1005") ?? [];
      if (r1005.length > 3) {
        problems.push(`The service called the tax API ${r1005.length} times for r-1005. A request tries it up to 3 times.`);
      }
      if (r1005.some((call) => !call.closed)) {
        problems.push("r-1005 got its 503, but its call to the tax API was still open. The deadline should stop the call too.");
      }
    }
    if (!slowBody.ended) {
      problems.push(
        `r-1006's client sent 1 KB of its upload, then nothing more, as on a bad mobile network. After ${CLIENT_WAIT_MS / 1000} seconds, ` +
          "the service still waited for the rest, with the connection open. The 1.5-second deadline should cover the body read too.",
      );
    }
    if (crashed()) return problems;
    const afterSlow = await stats();
    if (afterSlow.files["r-1006"]) problems.push("Storage kept r-1006's half-sent file.");

    // 6. r-1007's client leaves during the first tax call.
    const left = await leavingUpload(ctx, service.url, "r-1007", () => (calls.get("r-1007") ?? []).length > 0);
    if (!left) {
      problems.push("r-1007's upload never reached the tax API, so the test couldn't check what happens when its client leaves.");
    } else {
      await sleep(500);
      const r1007 = calls.get("r-1007") ?? [];
      const after = r1007.filter((call) => call.at > left);
      if (after.length) {
        problems.push(
          `r-1007's client left during its first tax call, and the service called the tax API ${count(after.length, "more time")} in the next 500 ms. ` +
            "Nobody waits for that answer anymore, so the work should stop when the client leaves.",
        );
      } else if (r1007.some((call) => !call.closed)) {
        problems.push("r-1007's client left during its tax call, and the call stayed open. The service should abort it.");
      }
    }
    if (crashed()) return problems;

    // 7. 6 uploads at once, while the tax API holds their calls.
    const allIn = new Promise((resolve) => (release = () => held.length + responded >= 6 && resolve()));
    let responded = 0;
    const burst = ["r-1010", "r-1011", "r-1012", "r-1013", "r-1014", "r-1015"].map((id) =>
      upload(service.url, id, 1000, "10.00", "DE").then((result) => {
        responded++;
        release?.();
        return result;
      }),
    );
    await within(allIn, 3000);
    release = null;
    for (const answer of held) answer();
    held = [];
    const results = await Promise.all(burst);
    const busy = results.filter((result) => result.status === 503 && result.body?.error === "Server busy");
    if (heldPeak > MAX_IN_FLIGHT) {
      problems.push(
        `6 uploads arrived at once, and the service worked on ${heldPeak} of them at the same time. It runs at most ${MAX_IN_FLIGHT}. ` +
          'The rest should get 503 { error: "Server busy" } right away, so a traffic spike can\'t run the service out of memory.',
      );
    } else if (busy.length === 0) {
      problems.push(`6 uploads arrived at once, and none got 503 { error: "Server busy" }. The service runs at most ${MAX_IN_FLIGHT}.`);
    }
    const odd = results.find((result) => result.status !== 201 && !busy.includes(result));
    if (odd && heldPeak <= MAX_IN_FLIGHT) {
      problems.push(`Of the 6 uploads that arrived at once, the ones the service took should get 201, and one got ${describe(odd)}.`);
    }
    crashed();
    return problems;
  },
};

// Each upload gets a connection of its own, the way separate phones send them.
function upload(url, id, bytes, total, country) {
  return new Promise((resolve) => {
    const req = http.request(`${url}/receipts/${id}?total=${total}&country=${country}`, {
      method: "PUT",
      agent: false,
      headers: { "content-length": String(bytes) },
    });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ timedOut: true });
    }, CLIENT_WAIT_MS);
    req.on("response", async (res) => {
      let text = "";
      try {
        for await (const chunk of res) text += chunk;
      } catch {}
      clearTimeout(timer);
      req.destroy(); // after a 413, the rest of the body would wait on the connection
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      resolve({ status: res.statusCode, body, text });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error });
    });
    // A server that answers 413 early stops reading, so the rest of the body may never go out.
    req.end(Buffer.alloc(bytes, "r"));
  });
}

// Sends the headers and 1 KB of a 1 MB upload, then nothing. Resolves with { ended: true } once
// the service answers or closes the connection, or with { ended: false } after CLIENT_WAIT_MS.
async function stalledUpload(ctx, url, id) {
  const req = http.request(`${url}/receipts/${id}?total=10.00&country=DE`, {
    method: "PUT",
    agent: false,
    headers: { "content-length": String(MB) },
  });
  ctx.defer(() => req.destroy());
  req.on("error", () => {});
  const ended = new Promise((resolve) => {
    req.on("response", (res) => {
      res.resume();
      resolve();
    });
    req.on("close", resolve);
  });
  req.write(Buffer.alloc(1000, "r"));
  const outcome = await within(ended, CLIENT_WAIT_MS);
  req.destroy();
  return { ended: !outcome.timedOut };
}

// Sends a small upload, and closes the connection once reached() is true. Returns when the
// client left, as a performance.now() time, or null.
async function leavingUpload(ctx, url, id, reached) {
  const req = http.request(`${url}/receipts/${id}?total=10.00&country=DE`, { method: "PUT" });
  ctx.defer(() => req.destroy());
  req.on("error", () => {});
  req.end(Buffer.alloc(1000, "r"));
  for (let waited = 0; waited < 2000; waited += 5) {
    if (reached()) {
      req.destroy();
      return performance.now();
    }
    await sleep(5);
  }
  return null;
}

function describe(result) {
  if (result.timedOut) return `no response within ${CLIENT_WAIT_MS / 1000} seconds`;
  if (result.error) return `no response: ${describeError(result.error.cause ?? result.error)}`;
  return `${result.status} ${result.text.slice(0, 120)}`;
}

function mb(bytes) {
  return `${(bytes / MB).toFixed(1)} MB`;
}
