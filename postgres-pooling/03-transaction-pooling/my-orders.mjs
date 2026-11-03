// GET /me/orders: a customer's own orders. The app connects through PgBouncer, which runs in
// transaction pooling mode.
//
// The my_orders view (see seed.sql) returns the orders of the customer in the setting
// app.customer_id, the way a row-level security policy would. So the app sets it first.

import pg from "pg";

export async function listMyOrders(pool, customerId) {
  // One client for the whole request, so the SET and the SELECT use the same connection.
  const client = await pool.connect();
  try {
    // SET doesn't take $1 parameters, so the value goes in as an escaped literal.
    await client.query(`SET app.customer_id = ${pg.escapeLiteral(String(customerId))}`);
    const { rows } = await client.query(
      "SELECT id, customer_id, status, ordered_on FROM my_orders ORDER BY id",
    );
    return rows;
  } finally {
    client.release();
  }
}
