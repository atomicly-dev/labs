// One instance of the shop's partner API. Each container runs this file, and nginx spreads the
// requests over the containers. You don't need to change it: the rate limit is in limiter.mjs.
//
// GET /orders lists a partner's recent orders. Each partner sends its API key in the x-api-key
// header, and may make 10 requests a minute.

import http from "node:http";
import os from "node:os";
import { createClient } from "redis";

// The test runs solution.mjs in place of limiter.mjs when it sets LAB_FILE.
const file = process.env.LAB_FILE || "limiter.mjs";
const { createLimiter } = await import(`./${file}`);

// A Redis connection that every instance shares, with the redis package (node-redis).
const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (error) => console.error("Redis:", error.message));
await redis.connect();

const limiter = createLimiter({ redis, limit: 10, windowSeconds: 60 });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://api");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...body, instance: os.hostname() }));
  };
  if (url.pathname === "/health") return send(200, { lab: "06-limit-across-replicas", file });
  if (url.pathname !== "/orders") return send(404, { error: "Not found" });

  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return send(401, { error: "Send your API key in the x-api-key header" });
  try {
    if (!(await limiter.allow(String(apiKey)))) {
      return send(429, { error: "Too many requests: the limit is 10 a minute" });
    }
  } catch (error) {
    return send(503, { error: `The rate limiter failed: ${error.message}` });
  }
  send(200, { orders: [{ id: 1042, status: "shipped" }] });
});

server.listen(3000, "0.0.0.0");
process.on("SIGTERM", () => {
  server.close();
  redis.close().finally(() => process.exit(0));
});
