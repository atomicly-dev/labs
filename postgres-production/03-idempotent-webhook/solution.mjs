// POST /webhooks/payments: the payment provider calls this for each payment event. See
// handler.mjs for the event's shape.

export async function handlePaymentWebhook(pool, event) {
  const refund = event.type === "payment.refunded";
  const client = await pool.connect();
  try {
    // One transaction for the whole event: the ledger row, the status, and the record that the
    // event was handled all commit together, or not at all.
    await client.query("BEGIN");

    // The event's id is the idempotency key. The primary key on webhook_events lets one copy
    // insert it. A copy that runs at the same moment waits for the first one's transaction, then
    // inserts nothing. So rowCount is 1 for the first copy and 0 for the others.
    const claimed = await client.query(
      "INSERT INTO webhook_events (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
      [event.id],
    );
    if (claimed.rowCount === 0) {
      await client.query("ROLLBACK");
      return;
    }

    await client.query("INSERT INTO payments (order_id, amount, event_id) VALUES ($1, $2, $3)", [
      event.orderId,
      refund ? -event.amount : event.amount,
      event.id,
    ]);

    // Only a newer event changes the status. An older event that arrives late still goes into
    // the ledger above, because its money moved, but it leaves the status alone.
    await client.query(
      `UPDATE orders SET payment_status = $1, payment_status_at = $2
        WHERE id = $3 AND (payment_status_at IS NULL OR payment_status_at < $2)`,
      [refund ? "refunded" : "paid", event.created, event.orderId],
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
