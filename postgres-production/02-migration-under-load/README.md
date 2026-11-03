# Lab 02: Migration under load

Lesson: [Migrations without downtime](https://atomicly.dev/lessons/zero-downtime-migrations)

## The situation

Release 42 ships with a migration, `migration.sql`, that makes two changes to `orders`:

1. A check constraint, `shipped_on >= ordered_on`. An old import job saved some orders with a ship date before their order date. That data is fixed now, and the constraint stops it from coming back.
2. An index on `shipped_on`, for the new "Shipped this week" page.

On a laptop, the migration takes a moment. In production, it runs while the shop takes orders. That morning, a support agent, Priya, fixed an order in psql. They typed `BEGIN` and an `UPDATE`, then went to a meeting, so their transaction is still open. The deploy runs the migration, and for 3 seconds every checkout, order page, and shipping update hangs.

## What's wrong

`ALTER TABLE ... ADD CONSTRAINT` needs an `ACCESS EXCLUSIVE` lock on `orders`. Priya's open transaction holds a lock on `orders` too, so the `ALTER` waits for them to commit. That's not the whole outage, though. Each request that comes in after the `ALTER` queues behind it, because its lock conflicts with the one the `ALTER` waits for. One waiting `ALTER` stops every query on the table.

The plain `CREATE INDEX` has the same problem in a smaller form. It holds a `SHARE` lock while it builds, and that blocks every `INSERT` and `UPDATE` on `orders` until the build ends.

## What passing looks like

```sh
npm run lab -- 02
```

The test starts 4 app connections that place, read, and ship orders the whole time. It opens Priya's transaction, which updates one order and stays open for 3 more seconds. Then it runs `migration.sql`.

The lab passes when:

- No request of the app waits more than 0.5 seconds for a lock on `orders`. The test looks at `pg_stat_activity` every few milliseconds to see which sessions wait for a lock, and on whom.
- The migration never holds a `SHARE` lock on `orders`.
- When it ends, `orders` has a valid index on `shipped_on`, and a validated check constraint that rejects an order with `shipped_on` before `ordered_on`.

## How the test runs `migration.sql`

The test runs the statements one after another, in one session, the way `psql -f` does:

- Each statement is its own transaction, unless you put statements between `BEGIN` and `COMMIT`. A setting from `SET` lasts for the rest of the session.
- When a statement fails with `55P03 lock_not_available`, the test waits 200 ms and runs it again, up to 100 times. That's what a migration tool with retries does. Inside `BEGIN` ... `COMMIT`, it runs the whole transaction again.
- Any other error stops the migration, and the test reports it with its line.

The constraint and the index can have any name. The test looks for them by what they do.

## Hint

Nothing should wait behind the migration for long. That takes three changes:

- Set `lock_timeout`, so a statement that can't get its lock gives up fast, and the retry tries again a moment later.
- Add the constraint with `NOT VALID`, so the `ALTER` doesn't read the whole table while it holds its lock. Then `ALTER TABLE ... VALIDATE CONSTRAINT` checks the existing rows with a lock that lets the app keep working.
- Build the index with `CREATE INDEX CONCURRENTLY`. It can't run inside `BEGIN` ... `COMMIT`, and it waits for open transactions, like Priya's, to end. Its wait counts against `lock_timeout` too, and a `CONCURRENTLY` build that stops partway leaves an `INVALID` index behind. So turn `lock_timeout` off with `RESET lock_timeout` before it.
