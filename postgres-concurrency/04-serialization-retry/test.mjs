// Two customers use the LAUNCH10 coupon at the same moment. It works for 3 orders, and 2 have
// used it already.

import { errorLines } from "../lib/harness.mjs";

const MAX_USES = 3;
const ORDER_IDS = [401, 402];

export default {
  file: "redeem.sql",
  setup: `
    DELETE FROM coupon_redemptions WHERE coupon_code = 'LAUNCH10' OR order_id BETWEEN 400 AND 499;
    DELETE FROM orders WHERE id BETWEEN 400 AND 499;
    INSERT INTO orders (id, customer_id, status, ordered_on) VALUES
      (401, 5, 'pending', current_date),
      (402, 8, 'pending', current_date);
    UPDATE coupons SET max_uses = ${MAX_USES} WHERE code = 'LAUNCH10';
    INSERT INTO coupon_redemptions (coupon_code, order_id) VALUES ('LAUNCH10', 9), ('LAUNCH10', 12);
  `,
  sessions: ORDER_IDS.map((orderId) => ({
    name: `order ${orderId}`,
    params: { coupon_code: "LAUNCH10", order_id: orderId },
  })),

  async check({ db, sessions }) {
    const problems = errorLines(sessions);
    const { rows } = await db.query(
      "SELECT order_id FROM coupon_redemptions WHERE coupon_code = 'LAUNCH10' ORDER BY order_id",
    );
    const orders = rows.map((row) => row.order_id).join(", ");
    if (rows.length > MAX_USES) {
      problems.push(
        `LAUNCH10 was used ${rows.length} times (orders ${orders}), but it works for only ${MAX_USES} orders.`,
      );
    } else if (rows.length < MAX_USES && problems.length === 0) {
      problems.push(
        `LAUNCH10 was used ${rows.length} times (orders ${orders}). It had a use left, so one of the two new orders should get it.`,
      );
    }
    return problems;
  },
};
