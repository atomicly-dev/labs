// The payment provider delivers webhook events the way real providers do: some more than once,
// at the same moment, and some in the wrong order. The test's pool adds 20 ms before each query,
// like the network between an app and its database, so copies of an event overlap on every run.
// For one payment, the first delivery loses its connection right after it claims the event, and
// the provider sends it again.

import pg from "pg";
import { DATABASE_URL, UNTRACKED, describeError, loadModule, setUp, sleep, within } from "../lib/harness.mjs";

const LATENCY_MS = 20;
const DEADLINE_MS = 10_000;
const AMOUNTS = [49, 19.5, 189, 7.25, 32, 39.9, 44, 25, 64.5, 120];

// The events for one order: a payment, and for some orders a refund an hour later.
function eventsFor(orderId, { refund }) {
  const amount = AMOUNTS[orderId % AMOUNTS.length];
  const paidAt = new Date(Date.UTC(2026, 9, 1, 9, orderId % 60));
  const paid = {
    id: `evt_paid_${orderId}`,
    type: "payment.succeeded",
    created: paidAt.toISOString(),
    orderId,
    amount,
  };
  if (!refund) return { paid };
  const refunded = {
    id: `evt_refund_${orderId}`,
    type: "payment.refunded",
    created: new Date(paidAt.getTime() + 60 * 60 * 1000).toISOString(),
    orderId,
    amount,
  };
  return { paid, refunded };
}

const DUPLICATED = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
const LATE_PAYMENT = [111, 112, 113, 114, 115];
const ALL_AT_ONCE = [116, 117, 118, 119, 120];
const CUT_OFF = 121;
const ORDERS = [...DUPLICATED, ...LATE_PAYMENT, ...ALL_AT_ONCE, CUT_OFF];
const PAYMENT_ONLY = [...DUPLICATED, CUT_OFF];

export default {
  file: "handler.mjs",
  lesson: "https://atomicly.dev/lessons/psql-idempotency",

  async run({ file, db, track }) {
    const loaded = await loadModule(file, ["handlePaymentWebhook"]);
    if (loaded.problems) return loaded.problems;
    const { handlePaymentWebhook } = loaded.app;

    await setUp(db, async () => {
      await db.query("TRUNCATE payments, webhook_events");
      await db.query(
        "UPDATE orders SET payment_status = NULL, payment_status_at = NULL WHERE payment_status IS NOT NULL",
      );
    });

    const pool = withLatency(
      track(new pg.Pool({ connectionString: DATABASE_URL, max: 20, application_name: "lab: app", options: UNTRACKED })),
    );
    const deliveries = [];
    const deliver = async (event, how, through = pool) => {
      const outcome = await within(handlePaymentWebhook(through, structuredClone(event)), DEADLINE_MS);
      deliveries.push({ event, how, ...outcome });
      return outcome;
    };

    await Promise.all([
      // The provider didn't get a quick enough answer, so it sent each payment 3 times at once.
      ...DUPLICATED.flatMap((orderId) => {
        const { paid } = eventsFor(orderId, { refund: false });
        return [deliver(paid, "at once"), deliver(paid, "at once"), deliver(paid, "at once")];
      }),
      // The payment's first delivery failed, so the provider sent it again later, after the refund.
      ...LATE_PAYMENT.map(async (orderId) => {
        const { paid, refunded } = eventsFor(orderId, { refund: true });
        await deliver(refunded, "in order");
        await deliver(paid, "late");
      }),
      // The payment and the refund, each twice, all at the same moment.
      ...ALL_AT_ONCE.map((orderId, i) => {
        const { paid, refunded } = eventsFor(orderId, { refund: true });
        const copies = i % 2 ? [paid, refunded, paid, refunded] : [refunded, paid, refunded, paid];
        return Promise.all(copies.map((event) => deliver(event, "at once")));
      }),
    ]);
    // One more copy of a payment, long after the first.
    await deliver(eventsFor(101, { refund: false }).paid, "again later");

    // The connection drops after the handler claims the event, before its next query reaches the
    // database. The provider sees an error and sends the event again.
    const cutOff = eventsFor(CUT_OFF, { refund: false }).paid;
    const first = await deliver(cutOff, "cut off", cutAfterClaim(pool));
    await deliver(cutOff, "retry");

    return check(db, deliveries, first);
  },
};

async function check(db, deliveries, cutOff) {
  const problems = [];

  const failed = deliveries.filter((delivery) => delivery.how !== "cut off" && (delivery.error || delivery.timedOut));
  if (failed.length) {
    const first = failed[0];
    const how = first.timedOut
      ? `didn't finish within ${DEADLINE_MS / 1000} seconds`
      : `failed with ${describeError(first.error)}`;
    problems.push(
      `${failed.length} of ${deliveries.length} deliveries failed, so the provider would see an error ` +
        `and send them again. The first, ${first.event.id}, ${how}.`,
    );
  }

  const { rows: ledger } = await db.query(
    "SELECT order_id, event_id, amount::float8 AS amount FROM payments WHERE order_id = ANY ($1) ORDER BY id",
    [ORDERS],
  );
  const { rows: orders } = await db.query(
    "SELECT id, payment_status FROM orders WHERE id = ANY ($1) ORDER BY id",
    [ORDERS],
  );

  const charged = [];
  const missing = [];
  const misbooked = [];
  const expectedIds = new Set();
  for (const orderId of ORDERS) {
    const refund = !PAYMENT_ONLY.includes(orderId);
    for (const event of Object.values(eventsFor(orderId, { refund }))) {
      expectedIds.add(event.id);
      const rows = ledger.filter((row) => row.event_id === event.id);
      if (rows.length > 1) charged.push({ orderId, event, rows: rows.length });
      if (rows.length === 0) missing.push({ orderId, event });
      const amount = event.type === "payment.refunded" ? -event.amount : event.amount;
      const wrongRow = rows.find((row) => row.order_id !== orderId || row.amount !== amount);
      if (wrongRow) misbooked.push({ orderId, event, amount, row: wrongRow });
    }
  }
  const extra = ledger.filter((row) => !expectedIds.has(row.event_id));
  if (charged.length) {
    const { orderId, event, rows } = charged[0];
    problems.push(
      `${charged.length} events went into the payments ledger more than once. ` +
        `Order ${orderId} has ${rows} rows for ${event.id} (${event.type}), so the shop counts that money ${rows} times.`,
    );
  }
  if (misbooked.length) {
    const { orderId, event, amount, row } = misbooked[0];
    problems.push(
      `${misbooked.length} ledger rows have the wrong order or amount. ${event.id} (${event.type}) should add ` +
        `${amount} to order ${orderId}, and its row adds ${row.amount} to order ${row.order_id}.`,
    );
  }
  if (extra.length) {
    const row = extra[0];
    problems.push(
      `The payments ledger has ${extra.length} rows that no event sent. Order ${row.order_id} has a row of ` +
        `${row.amount} with event_id ${row.event_id}.`,
    );
  }
  const cutOffMissing = missing.find((item) => item.orderId === CUT_OFF);
  if (cutOffMissing && cutOff.error) {
    problems.push(
      `The first delivery of ${cutOffMissing.event.id} lost its connection right after it claimed the event, ` +
        `and the retry skipped the event, so its payment never reached the ledger. The claim was saved without ` +
        `the changes it stands for.`,
    );
  }
  const otherMissing = missing.filter((item) => item !== cutOffMissing || !cutOff.error);
  if (otherMissing.length && !failed.length) {
    const { orderId, event } = otherMissing[0];
    problems.push(`${otherMissing.length} events never reached the ledger. Order ${orderId} has no row for ${event.id}.`);
  }

  const wrong = orders.filter((order) => order.payment_status !== (PAYMENT_ONLY.includes(order.id) ? "paid" : "refunded"));
  const late = wrong.filter((order) => LATE_PAYMENT.includes(order.id));
  if (late.length) {
    const { paid, refunded } = eventsFor(late[0].id, { refund: true });
    problems.push(
      `Order ${late[0].id} was refunded, but its payment_status is ${late[0].payment_status}. ` +
        `The payment event (created ${time(paid.created)}) arrived after the refund (created ${time(refunded.created)}) and overwrote it.`,
    );
  }
  const others = wrong.filter((order) => !LATE_PAYMENT.includes(order.id));
  if (others.length) {
    const order = others[0];
    const want = PAYMENT_ONLY.includes(order.id) ? "paid" : "refunded";
    problems.push(
      `${others.length === 1 ? "An order" : `${others.length} orders`} ended with the wrong payment_status. ` +
        `Order ${order.id}'s is ${order.payment_status ?? "NULL"}, and it should be ${want}.`,
    );
  }
  return problems;
}

function time(iso) {
  return iso.slice(11, 16);
}

// Wraps the latency pool for one delivery. After the first query that mentions webhook_events,
// the connection drops before the next query reaches the database, as when the network fails.
// PostgreSQL then rolls back the connection's open transaction, if it has one. A COMMIT or
// ROLLBACK right after the claim goes through, so a handler that claims and applies the event in
// one statement isn't cut off.
function cutAfterClaim(pool) {
  let claimed = false;
  let cut = false;
  const guarded = (target, drop) => async (...args) => {
    const text = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
    if (claimed && !cut && !/^\s*(COMMIT|ROLLBACK|END)\b/i.test(text)) {
      cut = true;
      drop();
      throw new Error("Connection terminated unexpectedly");
    }
    if (/webhook_events/i.test(text)) claimed = true;
    return target.query(...args);
  };
  return {
    query: guarded(pool, () => {}),
    async connect() {
      const client = await pool.connect();
      const query = guarded(client, () => client.connection.stream.destroy());
      return new Proxy(client, {
        get(target, prop) {
          if (prop === "query") return query;
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

// Wraps the pool, so each query, from pool.query() or from a client of pool.connect(), starts
// LATENCY_MS later.
function withLatency(pool) {
  const delayed = (target) => async (...args) => {
    await sleep(LATENCY_MS);
    return target.query(...args);
  };
  return {
    query: delayed(pool),
    async connect() {
      const client = await pool.connect();
      return new Proxy(client, {
        get(target, prop) {
          if (prop === "query") return delayed(target);
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    end: () => pool.end(),
  };
}
