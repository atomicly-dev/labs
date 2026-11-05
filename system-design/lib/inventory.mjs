// Lab 05's dependency: the inventory service. GET /stock/:productId answers how many items are in
// stock. It counts every call, so the test can see how many calls the service behind it made.
// Toxiproxy, in front of it, makes it slow when the test asks.
//
// The test calls these on port 8091, past Toxiproxy: GET /stats returns { calls }, POST /reset sets
// the count back to 0, and POST /fail-next?count=1 makes the next call answer 503.

import http from "node:http";

let calls = 0;
let failNext = 0;

const server = http.createServer((req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true });
  if (req.method === "GET" && req.url === "/stats") return send(200, { calls });
  if (req.method === "POST" && req.url === "/reset") {
    calls = 0;
    failNext = 0;
    return send(200, { calls });
  }
  if (req.method === "POST" && req.url?.startsWith("/fail-next")) {
    failNext = Number(new URL(req.url, "http://inventory").searchParams.get("count") ?? 1);
    return send(200, { failNext });
  }
  const match = /^\/stock\/(\d+)$/.exec(req.url ?? "");
  if (req.method === "GET" && match) {
    calls++;
    if (failNext > 0) {
      failNext--;
      return send(503, { error: "Service Unavailable" });
    }
    return send(200, { productId: Number(match[1]), inStock: 12 });
  }
  send(404, { error: "Not found" });
});

server.listen(3000, "0.0.0.0");
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
