// GET /me/orders: a customer's own orders. The app connects through PgBouncer, which runs in
// transaction pooling mode.
//
// The my_orders view (see seed.sql) returns the orders of the customer in the setting
// app.customer_id, the way a row-level security policy would. So the app sets it first.

import pg from "pg";

export async function listMyOrders(pool, customerId) {
  const client = await pool.connect();
  try {
    // PgBouncer keeps a client on one server connection until the transaction ends. So the SET
    // and the SELECT go in one transaction, and SET LOCAL ends with it.
    await client.query("BEGIN");
    await client.query(`SET LOCAL app.customer_id = ${pg.escapeLiteral(String(customerId))}`);
    const { rows } = await client.query(
      "SELECT id, customer_id, status, ordered_on FROM my_orders ORDER BY id",
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
