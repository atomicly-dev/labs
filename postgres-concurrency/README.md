# PostgreSQL concurrency labs

These labs go with module 13, "Concurrency", of atomicly's PostgreSQL course. In each one, a piece of SQL works fine when one customer uses it, and breaks when several use it at the same moment. You fix the SQL, and the test runs it in several sessions at once to check your fix.

Do them in order:

| Lab | Goal | Lesson |
| --- | --- | --- |
| [01-lost-update](01-lost-update/) | Two checkouts sell the last Monitors. Make sure stock never goes wrong and no sale is lost. | [Lost updates](https://atomicly.dev/lessons/lost-updates) |
| [02-job-queue](02-job-queue/) | Several workers take jobs from a queue. Make sure no job runs twice and no worker waits for another. | [Row locks](https://atomicly.dev/lessons/row-locks) |
| [03-deadlock](03-deadlock/) | Two store-credit transfers go in opposite directions and deadlock. Make them both finish. | [Deadlocks](https://atomicly.dev/lessons/deadlocks) |
| [04-serialization-retry](04-serialization-retry/) | Two orders use the last use of a coupon. Make sure the coupon isn't used too often. | [Isolation levels](https://atomicly.dev/lessons/isolation-levels) |

## Start the database

```sh
docker compose up -d --wait
npm install
```

This starts PostgreSQL 18 on port 5440 with a small shop database: customers, products, orders, and the tables the labs use. With Podman, use `podman compose` in place of `docker compose`.

The database keeps its data in memory. `docker compose down` stops it and throws the data away, and the next `up` starts from the seed again.

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | Runs every lab. |
| `npm test -- 01-lost-update` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 20` | Runs a lab 20 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |
| `npm run db` | Opens psql in the database, so you can look at the tables. |
| `npm run reset` | Puts the whole database back to the seed, if you've changed it by hand. |

You don't need `npm run reset` between test runs. Each test puts its own rows back before it runs.

## How a test runs your SQL

Each lab has one `.sql` file for you to edit. The test opens a few connections, one per customer or worker, and runs your file in each of them at the same time.

The sessions run your file in lockstep. A session starts its next statement only when every other session has finished the one before it, waits for a lock, or is done. So every session reads before any of them writes, and a race shows up on every run, not on one run in a hundred. A real server gets the same interleaving under load, just not every time.

Once the sessions are done, the test checks the tables and reports what went wrong:

```
FAIL 01-lost-update (checkout.sql)
     The checkouts sold 3 Monitors (orders 101, 102, 103), but the stock went from 2 to 1. A checkout's stock update was lost.
```

### Variables

Your file is plain SQL with psql variables, so you can paste it into psql too:

- `:order_id` puts the value in as it is, such as `101`.
- `:'worker'` puts it in as a quoted string, such as `'worker-1'`.
- A query that ends with `\gset` in place of `;` stores its row's columns in variables. `SELECT stock FROM products WHERE id = 3 \gset` sets `:stock`.

The test sets each session's variables, such as `:product_id` and `:order_id`. The top of each lab's file lists them. In psql, set them yourself with `\set product_id 3`.

The test runs SQL and `\gset` only, not other psql commands such as `\set` or `\if`.

### Errors and retries

When a statement fails, the session rolls back and stops, like a request in your app that throws. The test reports the error and its line.

The one exception is a serialization failure, error 40001. Your app should retry a transaction that fails with 40001, so the test does too: it rolls back and runs the whole file again in that session, up to 5 times.

A session gives up on a lock after 10 seconds, and a lab stops after 15 seconds, so a stuck test never hangs.

## If something doesn't work

- **`Can't connect to PostgreSQL`**: the database isn't running. Run `docker compose up -d --wait` in this folder.
- **Port 5440 is in use**: change the port in `compose.yaml`, and run the tests with `DATABASE_URL=postgres://postgres:postgres@localhost:<port>/shop npm test`.
- **A table looks wrong after you tried something in psql**: run `npm run reset`.
