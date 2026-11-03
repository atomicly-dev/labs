// A busy minute: each of the 4 instances gets 10 summary requests at the same moment. PostgreSQL
// allows 20 connections (max_connections in compose.yaml).

import { describeError, PGBOUNCER_URL, within } from "../lib/harness.mjs";

const INSTANCES = 4;
const REQUESTS_PER_INSTANCE = 10;
const MAX_CONNECTIONS = 20;
const DEADLINE_MS = 10_000;
const CUSTOMERS = [1, 2, 3, 5, 6, 8];

export default {
  file: "pool.mjs",
  lesson: "https://atomicly.dev/lessons/connections-and-pools",
  exports: ["createPool", "customerSummary"],

  async run({ app, db, track }) {
    const expected = new Map();
    for (const customerId of CUSTOMERS) {
      const { rows } = await db.query("SELECT count(*)::int AS n FROM orders WHERE customer_id = $1", [
        customerId,
      ]);
      expected.set(customerId, rows[0].n);
    }

    const pools = Array.from({ length: INSTANCES }, () => track(app.createPool()));
    const requests = pools.flatMap((pool) =>
      Array.from({ length: REQUESTS_PER_INSTANCE }, (_, i) => {
        const customerId = CUSTOMERS[i % CUSTOMERS.length];
        return within(app.customerSummary(pool, customerId), DEADLINE_MS).then((outcome) => ({
          customerId,
          ...outcome,
        }));
      }),
    );
    const outcomes = await Promise.all(requests);

    const problems = [];
    const total = outcomes.length;
    const failures = new Map();
    for (const outcome of outcomes) {
      const reason = outcome.timedOut
        ? `didn't finish within ${DEADLINE_MS / 1000} seconds`
        : outcome.error
          ? `failed with ${describeError(outcome.error)}`
          : outcome.value?.order_count !== expected.get(outcome.customerId)
            ? `returned the wrong summary: ${JSON.stringify(outcome.value)}`
            : null;
      if (reason) failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    for (const [reason, count] of failures) {
      problems.push(`${count} of ${total} requests ${reason}.`);
    }

    if (problems.length) {
      const direct = pools.filter((pool) => !usesPgBouncer(pool)).map((pool) => pool.options.max);
      const sum = direct.reduce((a, b) => a + b, 0);
      if (direct.length) {
        const parts = direct.every((max) => max === direct[0])
          ? `${direct.length} pools × ${direct[0]}`
          : direct.join(" + ");
        problems.push(
          `The pools that connect to PostgreSQL itself can open up to ${sum} connections (${parts}), ` +
            `and PostgreSQL allows ${MAX_CONNECTIONS}.`,
        );
      }
    }
    return problems;
  },
};

function usesPgBouncer(pool) {
  const url = pool.options.connectionString;
  return url === PGBOUNCER_URL || (url && new URL(url).port === new URL(PGBOUNCER_URL).port);
}
