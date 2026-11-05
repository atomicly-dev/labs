// A small load generator. It sends a fixed number of requests, a set number at a time, and counts
// what came back.
//
// npm run load                                  800 requests to lab 01's cart total, 64 at a time
// npm run load -- --requests 2000 --connections 128
// npm run load -- --path "/orders" --header "x-api-key: ann"
//
// The tests import load() and read the counts.

import http from "node:http";
import { parseArgs } from "node:util";
import { API_URL } from "./urls.mjs";

/**
 * @param {object} options
 * @param {string} options.url
 * @param {number} options.requests How many requests to send in all.
 * @param {number} options.connections How many to keep in flight at once.
 * @param {Record<string, string>} [options.headers]
 * @returns {Promise<{ seconds: number, perSecond: number, statuses: Map<number, number>,
 *   errors: Map<string, number>, bodies: any[], p50: number, p99: number }>}
 *   errors counts each failure by its message: the body's `error`, or the network error.
 */
export async function load({ url, requests, connections, headers = {} }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: connections });
  const statuses = new Map();
  const errors = new Map();
  const bodies = [];
  const latencies = [];
  let next = 0;

  const one = () =>
    new Promise((resolve) => {
      const started = performance.now();
      const req = http.get(url, { agent, headers, timeout: 10_000 }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          latencies.push(performance.now() - started);
          statuses.set(res.statusCode, (statuses.get(res.statusCode) ?? 0) + 1);
          let body = null;
          try {
            body = JSON.parse(text);
          } catch {}
          bodies.push({ status: res.statusCode, body });
          if (res.statusCode >= 500) {
            const message = `${res.statusCode} ${body?.error ?? text.trim().slice(0, 120)}`;
            errors.set(message, (errors.get(message) ?? 0) + 1);
          }
          resolve();
        });
      });
      req.on("timeout", () => req.destroy(new Error("no answer within 10 seconds")));
      req.on("error", (error) => {
        const message = error.code ?? error.message;
        errors.set(message, (errors.get(message) ?? 0) + 1);
        resolve();
      });
    });

  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(connections, requests) }, async () => {
      while (next < requests) {
        next++;
        await one();
      }
    }),
  );
  const seconds = (performance.now() - started) / 1000;
  agent.destroy();

  latencies.sort((a, b) => a - b);
  const at = (q) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0);
  return {
    seconds,
    perSecond: requests / seconds,
    statuses,
    errors,
    bodies,
    p50: at(0.5),
    p99: at(0.99),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      requests: { type: "string", default: "800" },
      connections: { type: "string", default: "64" },
      path: { type: "string", default: "/cart-total?product=3&quantity=2" },
      header: { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("npm run load -- [--requests 800] [--connections 64] [--path /cart-total?product=3] [--header 'x-api-key: acme']");
    process.exit(0);
  }
  const headers = Object.fromEntries(
    values.header.map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
  const url = new URL(values.path, API_URL).href;
  console.log(`Sending ${values.requests} requests to ${url}, ${values.connections} at a time...`);
  let result;
  try {
    result = await load({ url, requests: Number(values.requests), connections: Number(values.connections), headers });
  } catch (error) {
    console.error(`Can't reach ${url} (${error.message}). Start the services with \`docker compose up -d --wait\`.`);
    process.exit(2);
  }
  const instances = new Set(result.bodies.map((b) => b.body?.instance).filter(Boolean));
  const ok = result.statuses.get(200) ?? 0;
  console.log(`${Math.round(result.perSecond)} requests a second, in ${result.seconds.toFixed(1)} s`);
  if (result.errors.size) console.log(`${Math.round(ok / result.seconds)} successful requests a second`);
  console.log(`Latency: ${result.p50} ms for half of them, ${result.p99} ms for 99 in 100`);
  console.log(`Statuses: ${[...result.statuses].map(([status, n]) => `${n} × ${status}`).join(", ")}`);
  if (instances.size) console.log(`Answered by ${instances.size} API ${instances.size === 1 ? "instance" : "instances"}`);
  for (const [message, n] of result.errors) console.log(`  ${n} failed: ${message}`);
}
