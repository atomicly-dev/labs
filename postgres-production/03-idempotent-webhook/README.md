# Lab 03: Idempotent webhook

Lesson: [Idempotent writes](https://atomicly.dev/lessons/idempotency)

## The situation

When a customer pays, or gets a refund, the shop's payment provider sends a webhook: a `POST` to `/webhooks/payments` with the event. The handler, `handlePaymentWebhook` in `handler.mjs`, does two things for each event:

1. It adds a row to the `payments` ledger: the amount, or minus the amount for a refund.
2. It sets the order's `payment_status` to `paid` or `refunded`.

The provider sends each event at least once, not exactly once. When it doesn't get a `200` in time, it sends the event again, sometimes while the first copy is still running. And events can arrive out of order: a payment that failed to deliver the first time can come after its refund.

The finance team found orders with the same payment in the ledger 3 times, and refunded orders that show as paid.

## What's wrong

The handler checks `webhook_events` for the event's id before it does anything, and records the id at the end. When two copies arrive at the same moment, both check before either one records the id, so both apply the event. The second `INSERT INTO webhook_events` then fails on the primary key, and the provider sees an error and sends the event once more.

And the handler sets `payment_status` from whichever event arrives last. When the payment arrives after its refund, it sets the order back to `paid`.

## What passing looks like

```sh
npm run lab -- 03
```

The test calls `handlePaymentWebhook` with a `pg` pool, the way the route does, for 21 orders:

- 10 payments, each delivered 3 times at the same moment.
- 5 refunds, each followed by its payment, which arrives late.
- 5 payments and refunds, each delivered twice, all 4 at the same moment.
- 1 payment whose first delivery loses its connection right after the handler records the event's id, and before its next query. The provider sends it again.

The test's pool adds 20 ms before each query, like the network between an app and its database, so the copies of an event overlap on every run.

The lab passes when every delivery returns without an error, except the one that loses its connection, and each event is in the ledger exactly once, for its order and with its amount: the payment's amount, or minus the amount for a refund. Each order also ends with the status of its newest event: `paid`, or `refunded` when there was a refund.

## Hint

There are two fixes, one for each problem:

- Make the event's id the idempotency key, and let the primary key on `webhook_events` decide which copy wins. Insert the id first, with `ON CONFLICT (id) DO NOTHING`. When `rowCount` is 0, another copy has it, so return. Do the insert and the two changes in one transaction, on one client from `pool.connect()`, so they commit together or not at all.
- Each event has a `created` time, and the order keeps the time of the event that set its status in `payment_status_at`. Add a condition to the `UPDATE`, so it changes the status only when the event is newer.
