# Lab 03: Transaction pooling

Lesson: [PgBouncer modes](https://atomicly.dev/lessons/pgbouncer-modes)

## The situation

The shop's API has a "My orders" page, `GET /me/orders`. Its handler, `listMyOrders` in `my-orders.mjs`, takes a client from the pool and runs two statements:

1. `SET app.customer_id = '3'` puts the logged-in customer in a setting.
2. `SELECT ... FROM my_orders` reads their orders. The `my_orders` view (see `seed.sql`) returns only the orders of the customer in `app.customer_id`, the way a row-level security policy would.

On a direct connection to PostgreSQL, this works. Then the team puts PgBouncer in front of the database, in transaction pooling mode, and customers start to see other customers' orders.

## What's wrong

The app's client is a connection to PgBouncer, not to PostgreSQL. In transaction mode, PgBouncer gives a client one of its server connections for one transaction, then takes it back. A statement outside a transaction is a transaction of its own.

So the `SET` runs on one server connection, and the `SELECT` can run on another one. That other connection may hold another customer's `SET`, or no customer at all. And the `SET` stays on its server connection after the request ends, for whichever client gets that connection next.

## What passing looks like

```sh
npm run lab -- 03
```

The test makes a pool that connects to PgBouncer, which has 2 server connections (see `pgbouncer.ini`). 7 customers open their orders at the same time, 3 times over. Each customer should get exactly their own orders. Customer 4 has none, so they should get an empty list. When the requests are over, no server connection should still hold a customer in `app.customer_id`.

## Hint

PgBouncer keeps a client on the same server connection until its transaction ends. So put the setting and the query in one transaction, with `BEGIN` and `COMMIT`.

That's half the fix. A plain `SET` still outlives the transaction. There's a form of `SET` that lasts only until the end of the current transaction. `set_config('app.customer_id', $1, true)` does the same, and it takes a parameter.
