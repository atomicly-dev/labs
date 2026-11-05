# Lab 01: Find the bottleneck

Lessons: [System design: find what breaks first at 10x traffic](https://atomicly.dev/lessons/sd-first-bottleneck) and [Connections and pools](https://atomicly.dev/lessons/psql-connections-and-pools)

## The situation

The shop's API runs as 2 instances behind nginx. Each instance keeps a pool of 8 PostgreSQL connections, set in `config.mjs`. The cart page calls `GET /cart-total`, and each call holds a connection for 100 ms.

Black Friday is coming. The API's CPU is busy at peak, so the team plans to double it to 4 instances. Before the big day, you run the load test yourself.

## Try it

Start with today's setup, 2 instances, and send 800 requests, 64 at a time:

```sh
npm run scale -- 2
npm run load
```

Write down the requests a second. Then do what the team plans:

```sh
npm run scale -- 4
npm run load
```

Look at 3 things:

- **The throughput.** Twice the instances didn't bring twice the successful requests a second. Why not?
- **The errors.** Most requests now fail with `sorry, too many clients already` or `remaining connection slots are reserved for roles with the SUPERUSER attribute`.
- **The connections.** `npm run scale` prints how many connections the pools can open. Compare it with `max_connections` in `compose.yaml`.

While the load runs, you can watch the connections from a second terminal:

```sh
npm run db -- postgres -c "SELECT usename, state, count(*) FROM pg_stat_activity WHERE usename = 'shop_app' GROUP BY 1, 2"
```

## What's wrong

PostgreSQL allows 20 connections, and keeps the last 3 for superusers. The API connects as `shop_app`, so it gets 17. Each instance opens its own pool, so the total grows with every instance you add. The connection slots were the bottleneck all along, and more API instances can't raise it.

## What passing looks like

```sh
npm run lab -- 01
```

The test restarts the API as 4 instances with your `config.mjs`, and sends 600 requests, 64 at a time. The lab passes when every request succeeds, with the right total, and the API serves at least 110 requests a second. A pool too small leaves database connections unused, and requests wait in line inside the instances.

## Hint

Fix `config.mjs`. Work out the pool size from the numbers: the connections the app gets, and the number of instances. A request that finds the pool busy waits for a free connection. It doesn't fail. What's the most requests a second this database can serve, whatever the number of instances?
