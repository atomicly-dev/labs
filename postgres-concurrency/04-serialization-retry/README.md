# Lab 04: Serialization retry

Lesson: [Isolation levels](https://atomicly.dev/lessons/psql-isolation-levels)

## The situation

The coupon `LAUNCH10` works for 3 orders, and 2 orders have used it already. Two customers apply it at the same moment, and each request runs `redeem.sql`:

1. It counts the coupon's uses and works out how many are left.
2. If there's a use left, it adds a row to `coupon_redemptions` for the order.

The transaction runs at `REPEATABLE READ`, so each request works from one consistent snapshot of the data. Even so, both orders get the coupon, and it ends up with 4 uses.

## What's wrong

Both transactions read the count before either one inserts, so both see 1 use left. Each one inserts a different row, so they never touch the same row and never wait for each other. The result is one neither would give if they ran one at a time. That's write skew, and `REPEATABLE READ` allows it.

## What passing looks like

One of the two orders gets the coupon, and `LAUNCH10` ends with 3 uses.

```sh
npm run lab -- 04
```

The test runs `redeem.sql` in 2 sessions with `:coupon_code` `'LAUNCH10'` and `:order_id` 401 and 402. When a session fails with error 40001, the test runs the whole file again in that session, the way your app's retry loop should.

## Hint

There's an isolation level that makes PostgreSQL detect this case and fail one of the transactions with 40001. The retry then sees the other order's redemption.

You can also fix it with a lock: make both orders lock the coupon's row before they count. Watch out, though. Under `REPEATABLE READ`, the second order still counts from its snapshot, taken before the first order committed. A lock only helps at `READ COMMITTED`, where each statement sees the latest committed rows.
