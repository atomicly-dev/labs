// The shop's API runs as 4 instances behind a load balancer. Each instance calls createPool once,
// when it starts, and serves every request with that pool.

import pg from "pg";
import { DATABASE_URL, PGBOUNCER_URL } from "../lib/urls.mjs";

// DATABASE_URL is PostgreSQL itself. PGBOUNCER_URL is PgBouncer, in front of the same database.
export function createPool() {
  return new pg.Pool({
    connectionString: DATABASE_URL,
    // Room for 10 requests at once on each instance.
    max: 10,
  });
}

// GET /customers/:id/summary: how many orders a customer has, and what they spent. pg_sleep stands
// in for a slow report, so each request holds its connection for about 200 ms.
export async function customerSummary(pool, customerId) {
  const { rows } = await pool.query(
    `SELECT count(DISTINCT o.id)::int AS order_count,
            coalesce(sum(oi.quantity * oi.unit_price), 0)::text AS total_spent
     FROM orders AS o
     LEFT JOIN order_items AS oi ON oi.order_id = o.id
     CROSS JOIN pg_sleep(0.2)
     WHERE o.customer_id = $1`,
    [customerId],
  );
  return rows[0];
}
