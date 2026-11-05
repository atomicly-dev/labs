# PostgreSQL connection pooling labs

These labs go with module 15, "Connection pooling", of atomicly's PostgreSQL course. In each one, a small piece of an app's data layer works fine with one request at a time, and breaks under load. Pooling bugs live in app code, not in SQL, so here you edit a Node module that uses [`pg`](https://node-postgres.com/). The test imports your module and sends it requests the way a busy app would.

Do them in order:

| Lab | Goal | Lesson |
| --- | --- | --- |
| [01-leaked-client](01-leaked-client/) | After a few failed requests, the API hangs. Make every request give its client back to the pool. | [Connections and pools](https://atomicly.dev/lessons/psql-connections-and-pools) |
| [02-pool-size](02-pool-size/) | 4 instances of the API run out of PostgreSQL connections. Size the pools so every request succeeds. | [Connections and pools](https://atomicly.dev/lessons/psql-connections-and-pools) |
| [03-transaction-pooling](03-transaction-pooling/) | Behind PgBouncer, customers see each other's orders. Make each request see only its own customer. | [PgBouncer and transaction pooling](https://atomicly.dev/lessons/psql-pgbouncer-modes) |

## Start the database

```sh
docker compose up -d --wait
npm install
```

This starts two things, with a small shop database of customers, products, and orders:

- PostgreSQL 18 on port 5441, with `max_connections` set to 20.
- PgBouncer on port 6441, in front of the same database. It runs in transaction pooling mode, with 2 server connections. Its settings are in `pgbouncer.ini`.

With Podman, use `podman compose` in place of `docker compose`.

The database keeps its data in memory. `docker compose down` stops both and throws the data away, and the next `up` starts from the seed again.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lab -- 01` | Runs one lab, start to finish: starts PostgreSQL and PgBouncer if they aren't running, runs the lab, and tells you what to do next. Start here. |
| `npm test` | Runs every lab. |
| `npm test -- 01-leaked-client` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 20` | Runs a lab 20 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |
| `npm run db` | Opens psql in the database, so you can look at the tables. |
| `npm run reset` | Puts the whole database back to the seed, if you've changed it by hand. |

## How a test runs your code

Each lab has one `.mjs` file for you to edit. It exports a function from the app, such as a request handler that takes a pool. The test makes the pools, calls your function many times, at once or one after another, and checks what comes back.

When something goes wrong, the test says what a user of the app would see:

```
FAIL 02-pool-size (pool.mjs)
     22 of 40 requests failed with 53300 too_many_connections: sorry, too many clients already.
     The pools that connect to PostgreSQL itself can open up to 40 connections (4 pools × 10), and PostgreSQL allows 20.
```

A request that waits too long counts as a failure, and a lab stops after 15 seconds, so a stuck test never hangs. When the lab ends, the test closes every connection your code opened, even the ones it never gave back.

## If something doesn't work

- **`Can't connect to PostgreSQL` or `Can't connect to PgBouncer`**: they aren't running. Run `docker compose up -d --wait` in this folder.
- **Port 5441 or 6441 is in use**: change the port in `compose.yaml`, and run the tests with `DATABASE_URL=postgres://postgres:postgres@localhost:<port>/shop` or `PGBOUNCER_URL=...` set.
- **Lab 02 fails with your fix while you have psql open**: psql takes one of the 20 connections too. Close it, or leave more room.
- **Lab 03 can't get PgBouncer's server connections**: a transaction you opened through PgBouncer holds one. End it with `COMMIT` or `ROLLBACK`.
