# Lab 01: Lost update

Lesson: [Lost updates](https://atomicly.dev/lessons/lost-updates)

## The situation

The shop has 2 Monitors left. Three customers click "Buy" at the same moment, and each request runs `checkout.sql`:

1. It reads the Monitor's stock.
2. If there's enough, it adds a Monitor to the customer's order.
3. It saves the new stock: the stock it read, minus 1.

With one customer at a time, this works. With three at once, the shop sells 3 Monitors and the stock goes from 2 to 1.

## What's wrong

All three checkouts read the stock before any of them saves it. Each one reads 2, so each one sells a Monitor and saves 2 - 1 = 1. The second and third updates overwrite the first, so two sales never come off the stock. That's a lost update.

## What passing looks like

Two checkouts sell a Monitor, the third sells nothing, and the stock ends at 0. Stock never goes below 0, and every sale comes off the stock.

```sh
npm run lab -- 01
```

The test runs `checkout.sql` in 3 sessions with `:product_id` 3 (the Monitor), `:quantity` 1, and `:order_id` 101, 102, and 103.

## Hint

The checkout makes its decision from a value it read earlier. Either make sure no other checkout can change the row between the read and the write, or do the check and the write in one `UPDATE` that works from the row's current stock, not from `:stock`.

If you go with one `UPDATE`, the order item still has to be saved only when the `UPDATE` changed a row. A `WITH` query can do both: `WITH sold AS (UPDATE ... RETURNING id, price) INSERT INTO order_items ... SELECT ... FROM sold`.
