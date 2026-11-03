// POST /webhooks/payments: the payment provider calls this for each payment event. The route
// calls handlePaymentWebhook with the app's pool and the event, and answers 200 when it returns.
// When the provider gets an error, or no answer in time, it sends the same event again.
//
// An event looks like this:
//   {
//     id: "evt_paid_101",           // the provider's id for the event, the same in every copy
//     type: "payment.succeeded",    // or "payment.refunded"
//     created: "2026-10-01T09:41:00.000Z",  // when the provider created the event
//     orderId: 101,
//     amount: 49,
//   }
//
// Each event does two things:
// 1. It adds a row to the payments ledger: the amount, or minus the amount for a refund.
// 2. It sets the order's payment_status to "paid" or "refunded", and payment_status_at to the
//    time of the event.
//
// The tables are in seed.sql: webhook_events (its id is the primary key), payments, and orders.

export async function handlePaymentWebhook(pool, event) {
  // Skip an event the shop has handled before.
  const seen = await pool.query("SELECT 1 FROM webhook_events WHERE id = $1", [event.id]);
  if (seen.rowCount > 0) return;

  const refund = event.type === "payment.refunded";
  await pool.query("INSERT INTO payments (order_id, amount, event_id) VALUES ($1, $2, $3)", [
    event.orderId,
    refund ? -event.amount : event.amount,
    event.id,
  ]);
  await pool.query("UPDATE orders SET payment_status = $1, payment_status_at = $2 WHERE id = $3", [
    refund ? "refunded" : "paid",
    event.created,
    event.orderId,
  ]);

  // Remember the event, so the next copy skips it.
  await pool.query("INSERT INTO webhook_events (id) VALUES ($1)", [event.id]);
}
