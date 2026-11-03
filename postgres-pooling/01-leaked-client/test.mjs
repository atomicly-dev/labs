// Requests for order pages come in one after another. Some ask for an order that doesn't exist,
// and one has a broken id in its URL. The app's pool has 3 clients.

import pg from "pg";
import { DATABASE_URL, describeError, within } from "../lib/harness.mjs";

const POOL_SIZE = 3;
const DEADLINE_MS = 2_000;

// [the id from the URL, whether the order exists]
const REQUESTS = [
  [1, true],
  [404, false],
  [3, true],
  ["12abc", false],
  [9001, false],
  [6, true],
  [10, true],
  [12, true],
];

export default {
  file: "orders.mjs",
  lesson: "https://atomicly.dev/lessons/connections-and-pools",
  exports: ["getOrder"],

  async run({ app, track }) {
    const pool = track(
      new pg.Pool({ connectionString: DATABASE_URL, max: POOL_SIZE, application_name: "lab: orders api" }),
    );
    const problems = [];
    let leaked = 0;

    for (const [orderId, exists] of REQUESTS) {
      const request = `getOrder(pool, ${JSON.stringify(orderId)})`;
      const outcome = await within(app.getOrder(pool, orderId), DEADLINE_MS);

      if (outcome.timedOut) {
        problems.push(
          `${request} didn't finish within ${DEADLINE_MS / 1000} seconds. It's still waiting for ` +
            "a client, and it will wait forever: no request is using the checked-out clients, so none comes back.",
        );
        break;
      }
      if (exists && outcome.error) {
        problems.push(`${request} failed: ${describeError(outcome.error)}`);
      } else if (exists && outcome.value?.id !== orderId) {
        problems.push(`${request} returned ${JSON.stringify(outcome.value)}, not order ${orderId}.`);
      } else if (!exists && !outcome.error) {
        problems.push(`${request} returned an order, but order ${orderId} doesn't exist.`);
      }

      // The request is over, so it should have given its client back.
      const checkedOut = pool.totalCount - pool.idleCount;
      if (checkedOut > leaked) {
        const how = outcome.error ? `threw "${outcome.error.message}"` : "returned";
        problems.push(
          `${request} ${how}, and didn't give its client back. Now ${checkedOut} of the pool's ` +
            `${POOL_SIZE} clients ` +
            (checkedOut === 1 ? "is checked out, with no request using it." : "are checked out, with no request using them."),
        );
      }
      leaked = checkedOut;
    }
    return problems;
  },
};
