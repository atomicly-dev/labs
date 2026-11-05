# Lab 01: Leaked client

Lesson: [Connections and pools](https://atomicly.dev/lessons/psql-connections-and-pools)

## The situation

The shop's API has an order page, `GET /orders/:id`. Its handler, `getOrder` in `orders.mjs`, takes a client from the app's `pg.Pool` with `pool.connect()`:

1. It reads the order.
2. If there's no such order, it throws `OrderNotFoundError`, and the route sends a 404.
3. It reads the order's items, calls `client.release()`, and returns the order.

The pool has 3 clients. The page works fine for a while. Then a few people open links to orders that don't exist, and from then on every request to the API hangs.

## What's wrong

`client.release()` gives the client back to the pool, and only the last lines of `getOrder` call it. When the handler throws, or when a query fails, the function ends before it gets there. That client stays checked out for good, with no request using it.

After 3 of those, the pool has no client left to give. The next `pool.connect()` waits for one to come back, and none ever does. By default, `pg.Pool` waits forever, so the request hangs with no error.

## What passing looks like

```sh
npm run lab -- 01
```

The test makes a pool with 3 clients and sends 8 requests, one after another: some for orders that exist, two for orders that don't, and one with a broken id, `"12abc"`, the way it comes from a URL. The requests for missing or broken ids should fail, and every request should give its client back, so the later ones still finish within 2 seconds.

## Hint

Release the client on every path out of the function: the return, the `throw`, and a query that fails. JavaScript has a block that runs whichever way a `try` ends.
