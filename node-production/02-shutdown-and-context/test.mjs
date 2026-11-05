// Starts the receipts service in its own process, with a real tax API on a random port, a fake
// pool whose queries take 150 ms, and fake telemetry whose flush takes 100 ms. Then:
//
// 1. r-2001, r-2002, and r-2003 arrive at once. The tax API answers when it has all 3 calls, and
//    answers 503 to r-2003's first call. r-2003 comes with a traceparent from the mobile app.
// 2. r-2004 arrives. Its ledger query never finishes, as when a row lock holds it up.
// 3. A load balancer sends uploads 4 at a time, 2 on keep-alive connections and 2 on new ones,
//    and calls /ready every 50 ms. 300 ms in, the test sends the service SIGTERM. The load balancer
//    stops sending after 2 failed /ready checks, as a real one does.
// 4. The test waits up to 5 seconds for the process to exit, then kills it, as Kubernetes does
//    at the end of its grace period.
//
// Then it checks the uploads' responses, what the pool and the telemetry saw, and the log lines.

import http from "node:http";
import { count, describeError, list, readJson, sendJson, sleep, within } from "../lib/helpers.mjs";
import { firstError, startService } from "../lib/service.mjs";

const GRACE_MS = 5000;
const SIGTERM_AFTER_MS = 300;
const STUCK = "r-2004";
const INCOMING_TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const INCOMING_PARENT = "00f067aa0ba902b7";
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export default {
  file: "service.mjs",
  lesson: "https://atomicly.dev/lessons/node-shutdown-under-load",

  async run(ctx) {
    // What the tax API saw: for each receipt, the traceparent of each call.
    const taxCalls = new Map(); // id -> [traceparent]
    const barrier = new Set();
    let openBarrier = () => {};
    const barrierOpen = new Promise((resolve) => (openBarrier = resolve));

    const taxUrl = await ctx.serve(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/vat") return sendJson(res, 404, { error: "Not found" });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: "The body isn't JSON" });
      }
      const traces = taxCalls.get(body.id) ?? [];
      traces.push(req.headers.traceparent ?? null);
      taxCalls.set(body.id, traces);
      if (["r-2001", "r-2002", "r-2003"].includes(body.id) && traces.length === 1) {
        barrier.add(body.id);
        if (barrier.size === 3) openBarrier();
        await within(barrierOpen, 1000);
        if (body.id === "r-2003") return sendJson(res, 503, { error: "Service Unavailable" });
      }
      sendJson(res, 200, { vat: Math.round(body.total * 19) / 100 });
    });

    const started = await startService(ctx, { taxUrl, queryMs: 150, stuckQuery: STUCK, flushMs: 100 });
    if (started.problems) return started.problems;
    const { service } = started;
    const problems = [];

    // 1 and 2.
    const first = await Promise.all([
      upload(service.url, "r-2001"),
      upload(service.url, "r-2002"),
      upload(service.url, "r-2003", { traceparent: `00-${INCOMING_TRACE}-${INCOMING_PARENT}-01` }),
    ]);
    first.push(await upload(service.url, STUCK));
    const badFirst = first.find((result) => result.status !== 201);
    if (badFirst) {
      problems.push(`Before any deploy, ${badFirst.id}'s upload should get 201, and got ${describe(badFirst)}.`);
      if (service.child.exitCode !== null) {
        problems.push(`The service's process crashed. ${firstError(service.stderr())}`.trim());
        return problems;
      }
    }

    // 3. The load balancer.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 2 });
    ctx.defer(() => agent.destroy());
    let sigtermAt = null;
    let stopped = false;
    let next = 3001;
    const sent = [];
    const readyChecks = [];

    // 2 connections stay open from one upload to the next, and 2 are new for each upload.
    const loops = [agent, agent, false, false].map(async (connection) => {
      while (!stopped) {
        const id = `r-${next++}`;
        const afterSigterm = sigtermAt !== null;
        const result = await upload(service.url, id, { agent: connection });
        sent.push({ ...result, afterSigterm });
        await sleep(10);
      }
    });
    const checker = (async () => {
      let failures = 0;
      while (!stopped) {
        const result = await get(`${service.url}/ready`);
        const afterSigterm = sigtermAt !== null;
        readyChecks.push({ ...result, afterSigterm });
        failures = result.status === 200 ? 0 : failures + 1;
        if (afterSigterm && failures >= 2) stopped = true;
        if (afterSigterm && performance.now() - sigtermAt > 3000) stopped = true; // a safety net
        await sleep(50);
      }
    })();

    await sleep(SIGTERM_AFTER_MS);
    sigtermAt = performance.now();
    service.child.kill("SIGTERM");
    await Promise.all([...loops, checker]);

    // 4. The grace period.
    const left = GRACE_MS - (performance.now() - sigtermAt);
    const exit = await within(service.exited, Math.max(left, 0));
    const killed = exit.timedOut;
    if (killed) service.child.kill("SIGKILL");
    await service.exited;
    agent.destroy();

    // The responses.
    const dropped = sent.filter((result) => result.afterSigterm && result.status !== 201);
    if (dropped.length) {
      const after = sent.filter((result) => result.afterSigterm).length;
      problems.push(
        `The load balancer sent ${count(after, "upload")} after SIGTERM, and ${dropped.length} of them failed, such as ${dropped[0].id}: ${describe(dropped[0])}. ` +
          "On a real deploy, the users of those uploads see an error.",
      );
    }
    const readyAfter = readyChecks.filter((check) => check.afterSigterm);
    if (!readyAfter.some((check) => check.status === 503)) {
      const seen = readyAfter[0] ? describe(readyAfter[0]) : "nothing";
      problems.push(
        `After SIGTERM, /ready should answer 503 while the server still takes uploads, so the load balancer stops sending. The first check after SIGTERM got ${seen}.`,
      );
    }

    // The pool and the telemetry.
    const events = await service.events();
    const poolEnd = events.find((event) => event.event === "pool-end");
    const flushed = events.find((event) => event.event === "telemetry-flushed");
    const saved = [...first, ...sent].filter((result) => result.status === 201 && result.id !== STUCK).map((result) => result.id);
    const written = new Set(
      events.filter((event) => event.event === "query-done" && (!poolEnd || event.at <= poolEnd.at)).map((event) => event.params[0]),
    );
    const failedQueries = events.filter((event) => event.event === "query-failed");
    const unwritten = saved.filter((id) => !written.has(id));
    if (failedQueries.length) {
      problems.push(
        `${count(failedQueries.length, "ledger job")} failed with "${failedQueries[0].error}". The pool closed while the background jobs still needed it, ` +
          `so ${count(unwritten.length, "receipt")} that got 201 never reached the ledger.`,
      );
    } else if (unwritten.length) {
      problems.push(
        `${count(unwritten.length, "receipt")} got 201, but never reached the ledger, such as ${unwritten[0]}. The process exited before their background jobs finished.`,
      );
    }
    // With r-2004 stuck, the deadline can pass before pool.end(), and that's fine: the process
    // exits next. What matters is that no job lost its pool.
    if (!flushed) {
      problems.push(
        events.some((event) => event.event === "telemetry-shutdown")
          ? "The service started telemetry.shutdown(), but exited before the flush finished, so the spans of the last requests are lost."
          : "The service never called telemetry.shutdown(), so the spans of the deploy's last seconds are lost. That's when you need them most.",
      );
    } else if (poolEnd && flushed.at < poolEnd.at) {
      problems.push("The telemetry flushed before the pool closed, so the spans of the last jobs and of the pool closing are lost. Flush it last.");
    }
    if (killed) {
      problems.push(
        `The process was still running ${GRACE_MS / 1000} seconds after SIGTERM, so Kubernetes would kill it with SIGKILL. ` +
          `Something in the shutdown waits with no deadline: ${STUCK}'s ledger job never finishes, and an idle keep-alive connection keeps server.close() waiting. ` +
          "Every step needs to share one deadline.",
      );
    } else if (exit.value.code !== 0) {
      problems.push(`The process exited with code ${exit.value.code} after SIGTERM. ${firstError(service.stderr())}`.trim());
    }

    problems.push(...checkLogs(service.logs, [...first, ...sent].filter((r) => r.status === 201).map((r) => r.id), written));
    problems.push(...checkTraces(service.logs, taxCalls));
    return problems;
  },
};

// Every line a request logs carries its requestId. So the lines with one requestId should be
// exactly one upload's: its "upload started", its "upload saved", and, once its job ran, its
// "ledger entry written".
function checkLogs(logs, receipts, written) {
  const byRequest = new Map();
  for (const line of logs) {
    if (!line.requestId) continue;
    const lines = byRequest.get(line.requestId) ?? [];
    lines.push(line);
    byRequest.set(line.requestId, lines);
  }
  const wrong = [];
  for (const id of receipts) {
    const start = logs.find((line) => line.msg === "upload started" && line.receiptId === id);
    if (!start) {
      wrong.push({ id, why: `has no "upload started" line` });
      continue;
    }
    if (!start.requestId) {
      wrong.push({ id, why: `has an "upload started" line with no requestId` });
      continue;
    }
    const lines = byRequest.get(start.requestId);
    const msgs = (msg) => lines.filter((line) => line.msg === msg).length;
    const expected = { "upload started": 1, "upload saved": 1, "ledger entry written": written.has(id) ? 1 : 0 };
    const off = Object.entries(expected).find(([msg, n]) => msgs(msg) !== n);
    if (off) {
      const [msg, n] = off;
      wrong.push({ id, why: `has ${msgs(msg)} "${msg}" ${msgs(msg) === 1 ? "line" : "lines"} under its requestId, and should have ${n}` });
    } else if (id === "r-2003" && msgs("tax API failed") !== 1) {
      wrong.push({ id, why: `has ${msgs("tax API failed")} "tax API failed" lines under its requestId, and its first tax call failed once` });
    }
  }
  if (!wrong.length) return [];
  return [
    `The log lines don't group by request: of the ${count(receipts.length, "upload")} that got 201, ${wrong.length} ${wrong.length === 1 ? "has" : "have"} the wrong lines under ${wrong.length === 1 ? "its" : "their"} requestId. ` +
      `For example, ${wrong[0].id} ${wrong[0].why}. While one request waits at an await, another one starts, so the on-call can't follow a failed upload through the logs.`,
  ];
}

// Each tax call carries the request's trace, and the request's log lines carry its traceId, so
// one search finds a failed upload's lines in both services.
function checkTraces(logs, taxCalls) {
  const problems = [];
  const missing = [...taxCalls].find(([, traces]) => traces.some((trace) => !TRACEPARENT.test(trace ?? "")));
  if (missing) {
    const [id, traces] = missing;
    const bad = traces.find((trace) => !TRACEPARENT.test(trace ?? ""));
    problems.push(
      `The tax API got ${id}'s call ${bad === null ? "with no traceparent header" : `with the traceparent "${bad}"`}, ` +
        "so its logs can't be matched to the upload that made the call.",
    );
    return problems;
  }
  const traceOf = (id) => TRACEPARENT.exec(taxCalls.get(id)?.[0] ?? "")?.slice(1) ?? [];
  const unreached = ["r-2001", "r-2002", "r-2003"].filter((id) => !taxCalls.has(id));
  if (unreached.length) {
    problems.push(`${list(unreached)} never reached the tax API, so the test couldn't check their traces.`);
    return problems;
  }

  const [trace2003, parent2003, flags2003] = traceOf("r-2003");
  if (trace2003 !== INCOMING_TRACE) {
    problems.push(
      `r-2003 came from the mobile app with the trace ID ${INCOMING_TRACE}, and its tax call carried ${trace2003}. The request should keep the trace it came with.`,
    );
  } else if (parent2003 === INCOMING_PARENT) {
    problems.push(
      "r-2003's tax call carried the mobile app's own span ID as its parent. The service should send its own span ID, so the trace shows the service's step.",
    );
  } else if (flags2003 !== "01") {
    problems.push(`r-2003 came with the flags 01, and its tax call carried ${flags2003}. Pass the flags on unchanged.`);
  }
  const retried = new Set(taxCalls.get("r-2003")?.map((trace) => TRACEPARENT.exec(trace)[1]));
  if (retried.size > 1) problems.push("r-2003's two tax calls carried different trace IDs. One request has one trace.");
  if (traceOf("r-2001")[0] === traceOf("r-2002")[0]) {
    problems.push("r-2001's and r-2002's tax calls carried the same trace ID. Each request needs its own.");
  }

  const unmatched = ["r-2001", "r-2002", "r-2003"].filter((id) => {
    const start = logs.find((line) => line.msg === "upload started" && line.receiptId === id);
    return !start?.traceId || start.traceId !== traceOf(id)[0];
  });
  if (unmatched.length) {
    problems.push(
      `The log lines of ${list(unmatched)} don't carry the trace ID their tax calls sent, so a search for a failed tax call's trace finds nothing in this service's logs.`,
    );
  }
  return problems;
}

function upload(url, id, { agent = false, traceparent } = {}) {
  return new Promise((resolve) => {
    const headers = { "content-length": "1000" };
    if (traceparent) headers.traceparent = traceparent;
    const req = http.request(`${url}/receipts/${id}?total=10.00&country=DE`, { method: "PUT", agent, headers });
    const timer = setTimeout(() => {
      req.destroy();
      resolve({ id, timedOut: true });
    }, 3000);
    req.on("response", async (res) => {
      let text = "";
      try {
        for await (const chunk of res) text += chunk;
      } catch {}
      clearTimeout(timer);
      resolve({ id, status: res.statusCode, text });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ id, error });
    });
    req.end(Buffer.alloc(1000, "r"));
  });
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { agent: false, timeout: 500 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("timeout", () => req.destroy(new Error("no answer within 500 ms")));
    req.on("error", (error) => resolve({ error }));
  });
}

function describe(result) {
  if (result.timedOut) return "no response within 3 seconds";
  if (result.error) return `no response: ${result.error.code ?? describeError(result.error)}`;
  return `${result.status}${result.text ? ` ${result.text.slice(0, 80)}` : ""}`;
}
