// GET /orders/:id: the order page of the shop's API. The route calls getOrder with the app's pool
// and the id from the URL, and turns an OrderNotFoundError into a 404.

export class OrderNotFoundError extends Error {}

export async function getOrder(pool, orderId) {
  // One client for both queries.
  const client = await pool.connect();
  try {
    const { rows: orders } = await client.query(
      "SELECT id, customer_id, status, ordered_on FROM orders WHERE id = $1",
      [orderId],
    );
    if (orders.length === 0) {
      throw new OrderNotFoundError(`Order ${orderId} not found`);
    }

    const { rows: items } = await client.query(
      `SELECT p.name, oi.quantity, oi.unit_price
       FROM order_items AS oi
       JOIN products AS p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY p.name`,
      [orderId],
    );

    return { ...orders[0], items };
  } finally {
    // finally runs on every path: the return, the throw, and a query that fails.
    client.release();
  }
}
