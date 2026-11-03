# PostgreSQL production labs

These labs go with modules 16, "Designing and changing a live database", and 17, "Diagnosing production", of atomicly's PostgreSQL course. Each one puts you in front of a database with real traffic on it: an app's queries, a migration next to live requests, or a payment provider's webhooks. The database is big enough that a missing index really shows: 50,000 customers, 300,000 orders, and 600,000 order items.

Do them in any order. Each one goes with a lesson:

| Lab | Goal | You edit | Lesson |
| --- | --- | --- | --- |
| [01-find-slow-query](01-find-slow-query/) | The shop's database got slow. Find the query that costs it the most time, and fix it. | `fix.sql` | [The slow-query workflow](https://atomicly.dev/lessons/slow-query-workflow) |
| [02-migration-under-load](02-migration-under-load/) | A migration takes the shop down for 3 seconds. Rewrite it so the app never waits. | `migration.sql` | [Zero-downtime migrations](https://atomicly.dev/lessons/zero-downtime-migrations) |
| [03-idempotent-webhook](03-idempotent-webhook/) | A payment webhook counts money twice, and a late event undoes a refund. Make the handler safe to retry. | `handler.mjs` | [Idempotency](https://atomicly.dev/lessons/idempotency) |

## Start the database

```sh
docker compose up -d --wait
npm install
```

This starts PostgreSQL 18 on port 5442 with the shop database, and with `pg_stat_statements` loaded, so lab 01 can see which queries cost the most. The seed makes the rows with `generate_series` and takes a few seconds. With Podman, use `podman compose` in place of `docker compose`.

The database keeps its data in memory. `docker compose down` stops it and throws the data away, and the next `up` starts from the seed again.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lab -- 01` | Runs one lab, start to finish: starts the database if it isn't running, runs the lab, and tells you what to do next. Start here. |
| `npm test` | Runs every lab. |
| `npm test -- 01-find-slow-query` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 20` | Runs a lab 20 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |
| `npm run db` | Opens psql in the database, so you can look at the tables, the plans, and `pg_stat_statements`. |
| `npm run reset` | Puts the whole database back to the seed, if you've changed it by hand. |

You don't need `npm run reset` between test runs. Each test puts its own tables back before it runs, and drops the indexes you added, in the lab's file or in psql.

## How a test runs your file

Each lab has one file for you to edit, and its test drives it the way production would:

- **Lab 01, `fix.sql`**: the test runs the app's usual mix of queries and measures them with `pg_stat_statements`. Then it runs your file and the same queries again, and compares.
- **Lab 02, `migration.sql`**: the test starts the app's traffic and a long transaction, then runs your file's statements one after another, in one session. It watches how long the app's requests wait for a lock while the migration runs.
- **Lab 03, `handler.mjs`**: the test imports your module and calls `handlePaymentWebhook` with a `pg` pool and an event, many times, the way a payment provider delivers webhooks.

The SQL files are plain SQL, so you can paste them into psql too. Each lab's README and the top of its file say exactly how the test runs it.

When something goes wrong, the test says what the app's users would see:

```
FAIL 02-migration-under-load (migration.sql)
     While the migration ran, the app's requests waited up to 3.1 s for a lock on orders. Each request should wait 500 ms at most.
     They queued behind migration.sql line 12 (ALTER TABLE orders ADD CONSTRAINT ...).
```

A lab stops after 30 seconds, so a stuck test never hangs. When the lab ends, the test closes every connection it opened, even ones that wait for a lock.

## If something doesn't work

- **`Can't connect to PostgreSQL`**: the database isn't running, or its seed hasn't finished. Run `docker compose up -d --wait` in this folder.
- **Port 5442 is in use**: change the port in `compose.yaml`, and run the tests with `DATABASE_URL=postgres://postgres:postgres@localhost:<port>/shop npm test`.
- **`The test couldn't put the lab's tables back to the start`**: a transaction you opened in psql holds a lock. End it with `COMMIT` or `ROLLBACK`.
- **A table looks wrong after you tried something in psql**: run `npm run reset`.
