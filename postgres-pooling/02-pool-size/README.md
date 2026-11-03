# Lab 02: Pool size

Lesson: [Connections and pools](https://atomicly.dev/lessons/connections-and-pools)

## The situation

The shop's API runs as 4 instances behind a load balancer. When an instance starts, it calls `createPool` in `pool.mjs` once, and serves every request with that pool. Each pool allows 10 connections.

On a quiet day, all is well. Then a sale starts, every instance gets 10 requests at the same moment, and about half of the requests fail with:

```
sorry, too many clients already
```

## What's wrong

Each connection is a process on the PostgreSQL server, so PostgreSQL limits how many it accepts with `max_connections`. Here it's 20 (see `compose.yaml`). It's 100 by default.

A pool opens connections as requests need them, up to its `max`. 4 pools with 10 each can open 40 connections, twice what PostgreSQL allows. Each pool is fine on its own. Together, they're too big.

## What passing looks like

```sh
npm run lab -- 02
```

The test calls `createPool` 4 times, once per instance, and sends 10 requests to each pool at the same time. Each request holds its connection for about 200 ms. Every request should succeed.

## Hint

Add up the connections of every pool that connects to PostgreSQL, and keep the total under 20. Leave some room for psql, migrations, and PgBouncer, which connect too. A smaller pool doesn't fail a request. The request waits a moment for a free connection.

There's a second way out: `pool.mjs` imports `PGBOUNCER_URL` too. PgBouncer takes many client connections and shares a few PostgreSQL connections between them.
