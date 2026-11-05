// One instance of the shop's API. Each container runs this file, and nginx spreads the requests
// over the containers. You don't need to change it: the pool settings come from config.mjs.
//
// GET /cart-total?product=3&quantity=2 prices a cart line with one query. pg_sleep stands in for
// the rest of the checkout's database work, so each request holds a connection for 100 ms.

import http from "node:http";
import os from "node:os";
import pg from "pg";

// The test runs solution.mjs in place of config.mjs when it sets LAB_FILE.
const file = process.env.LAB_FILE || "config.mjs";
const { poolConfig } = await import(`./${file}`);

const pool = new pg.Pool({ ...poolConfig, connectionString: process.env.DATABASE_URL });
pool.on("error", () => {});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://api");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...body, instance: os.hostname() }));
  };
  if (url.pathname === "/health") {
    return send(200, { lab: "01-find-the-bottleneck", file, poolMax: pool.options.max });
  }
  if (url.pathname !== "/cart-total") return send(404, { error: "Not found" });

  try {
    const { rows } = await pool.query(
      `SELECT name, (price * $2)::text AS total
       FROM products CROSS JOIN pg_sleep(0.1)
       WHERE id = $1`,
      [Number(url.searchParams.get("product")), Number(url.searchParams.get("quantity") ?? 1)],
    );
    if (!rows.length) return send(404, { error: "No such product" });
    send(200, rows[0]);
  } catch (error) {
    send(503, { error: error.message });
  }
});

server.listen(3000, "0.0.0.0");
process.on("SIGTERM", () => {
  server.close();
  pool.end().finally(() => process.exit(0));
});
