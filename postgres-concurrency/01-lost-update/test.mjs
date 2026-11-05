// Three customers check out the same Monitor at the same moment. There are 2 in stock.

import { errorLines } from "../lib/harness.mjs";

const PRODUCT_ID = 3; // Monitor
const START_STOCK = 2;
const ORDER_IDS = [101, 102, 103];

export default {
  file: "checkout.sql",
  lesson: "https://atomicly.dev/lessons/psql-lost-updates",
  setup: `
    DELETE FROM order_items WHERE order_id BETWEEN 100 AND 199;
    DELETE FROM orders WHERE id BETWEEN 100 AND 199;
    INSERT INTO orders (id, customer_id, status, ordered_on) VALUES
      (101, 1, 'pending', current_date),
      (102, 2, 'pending', current_date),
      (103, 3, 'pending', current_date);
    UPDATE products SET stock = ${START_STOCK} WHERE id = ${PRODUCT_ID};
  `,
  sessions: ORDER_IDS.map((orderId, i) => ({
    name: `checkout ${i + 1}`,
    params: { product_id: PRODUCT_ID, quantity: 1, order_id: orderId },
  })),

  async check({ db, sessions }) {
    const problems = errorLines(sessions);
    const {
      rows: [{ stock }],
    } = await db.query("SELECT stock FROM products WHERE id = $1", [PRODUCT_ID]);
    const { rows } = await db.query(
      `SELECT order_id, quantity FROM order_items
        WHERE order_id = ANY($1) AND product_id = $2 ORDER BY order_id`,
      [ORDER_IDS, PRODUCT_ID],
    );
    const sold = rows.reduce((sum, row) => sum + row.quantity, 0);

    if (stock < 0) {
      problems.push(`The Monitor's stock is ${stock}. Stock should never go below 0.`);
    }
    if (sold !== START_STOCK - stock) {
      problems.push(
        `The checkouts sold ${sold} Monitors (orders ${rows.map((row) => row.order_id).join(", ") || "none"}), ` +
          `but the stock went from ${START_STOCK} to ${stock}. ` +
          `${sold > START_STOCK - stock ? "A checkout's stock update was lost." : "The stock went down for a sale that wasn't saved."}`,
      );
    } else if (sold !== START_STOCK && problems.length === 0) {
      problems.push(
        `The checkouts sold ${sold} Monitors, but there were ${START_STOCK} in stock and 3 customers wanted one.`,
      );
    }
    return problems;
  },
};
