// Customers open their order history at the same time, a few times over. The app's pool connects
// to PgBouncer, and PgBouncer has 2 server connections (default_pool_size in pgbouncer.ini).

import pg from "pg";
import { describeError, PGBOUNCER_URL, sleep, within } from "../lib/harness.mjs";

const SERVER_CONNECTIONS = 2;
const ROUNDS = 3;
const DEADLINE_MS = 5_000;
const CUSTOMERS = [1, 2, 3, 4, 5, 6, 8]; // Customer 4 has no orders.

export default {
  file: "my-orders.mjs",
  lesson: "https://atomicly.dev/lessons/pgbouncer-modes",
  exports: ["listMyOrders"],

  async run({ app, db, track }) {
    const { rows } = await db.query("SELECT id, customer_id FROM orders ORDER BY id");
    const ownerOf = new Map(rows.map((row) => [row.id, row.customer_id]));
    const ordersOf = (customerId) => rows.filter((row) => row.customer_id === customerId).map((row) => row.id);

    // Earlier runs may have left a customer in a server connection's settings. Clear them.
    const cleared = await onEveryServerConnection(
      track,
      "SELECT set_config('app.customer_id', '', false)",
    );
    if (cleared.problem) return [cleared.problem];

    const pool = track(new pg.Pool({ connectionString: PGBOUNCER_URL, max: 10 }));
    const problems = [];
    const wrong = [];
    for (let round = 0; round < ROUNDS; round++) {
      const outcomes = await Promise.all(
        CUSTOMERS.map((customerId) => within(app.listMyOrders(pool, customerId), DEADLINE_MS)),
      );
      outcomes.forEach((outcome, i) => {
        const customerId = CUSTOMERS[i];
        const request = `Customer ${customerId}`;
        if (outcome.timedOut) {
          problems.push(`${request}'s request didn't finish within ${DEADLINE_MS / 1000} seconds.`);
        } else if (outcome.error) {
          problems.push(`${request}'s request failed: ${describeError(outcome.error)}`);
        } else if (!Array.isArray(outcome.value)) {
          problems.push(`${request}'s request returned ${JSON.stringify(outcome.value)}, not a list of orders.`);
        } else {
          const want = ordersOf(customerId);
          const got = outcome.value.map((row) => row.id);
          if (got.join() !== want.join()) wrong.push(wrongOrders(customerId, want, got, ownerOf));
        }
      });
    }
    const shown = unique(wrong).slice(0, 3);
    problems.push(...shown);
    if (wrong.length > shown.length) {
      const total = ROUNDS * CUSTOMERS.length;
      problems.push(`${wrong.length - shown.length} more of the ${total} requests got the wrong orders.`);
    }

    // Close the app's connections, so every server connection is free for the next check.
    await Promise.race([pool.end().catch(() => {}), sleep(1000)]);

    // Once the requests are over, no server connection should still hold a customer.
    const left = await onEveryServerConnection(
      track,
      "SELECT current_setting('app.customer_id', true) AS customer_id",
    );
    if (left.problem) {
      problems.push(left.problem);
    } else {
      const customers = left.values.filter(Boolean);
      if (customers.length) {
        problems.push(
          `After the requests ended, PgBouncer's server connections still have app.customer_id set to ` +
            `${customers.join(" and ")}. The next request on one of them starts with that customer's setting.`,
        );
      }
    }

    return unique(problems);
  },
};

// Runs the query once on each of PgBouncer's server connections. Each client opens a transaction,
// which keeps its server connection until COMMIT, so the clients get different server connections.
async function onEveryServerConnection(track, query) {
  const pool = track(new pg.Pool({ connectionString: PGBOUNCER_URL, max: SERVER_CONNECTIONS }));
  const clients = [];
  try {
    for (let i = 0; i < SERVER_CONNECTIONS; i++) {
      const outcome = await within(
        pool.connect().then(async (client) => {
          clients.push(client);
          await client.query("BEGIN");
          return client;
        }),
        DEADLINE_MS,
      );
      if (outcome.timedOut || outcome.error) {
        return {
          problem:
            "The test couldn't get each of PgBouncer's server connections for itself " +
            `(${outcome.error ? describeError(outcome.error) : "it waited too long"}). ` +
            "If you have a transaction open through PgBouncer in psql, end it with COMMIT or ROLLBACK.",
        };
      }
    }
    const values = [];
    for (const client of clients) {
      const { rows } = await client.query(query);
      values.push(Object.values(rows[0] ?? {})[0]);
      await client.query("COMMIT");
    }
    return { values };
  } finally {
    for (const client of clients) client.release();
    await pool.end().catch(() => {});
  }
}

function wrongOrders(customerId, want, got, ownerOf) {
  const list = (ids) => (ids.length === 1 ? `order ${ids[0]}` : `orders ${ids.join(", ")}`);
  const others = [...new Set(got.map((id) => ownerOf.get(id)).filter((owner) => owner !== customerId))];
  if (got.length === 0) {
    return `Customer ${customerId} got no orders, but has ${list(want)}.`;
  }
  if (others.length) {
    const whose = others.map((owner) => `customer ${owner}`).join(" and ");
    return `Customer ${customerId} asked for their own orders and got ${list(got)}, which ${got.length === 1 ? "belongs" : "belong"} to ${whose}.`;
  }
  return `Customer ${customerId} got ${list(got)}, but has ${want.length ? list(want) : "no orders"}.`;
}

function unique(lines) {
  return [...new Set(lines)];
}
