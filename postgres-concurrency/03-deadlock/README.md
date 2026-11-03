# Lab 03: Deadlock

Lesson: [Deadlocks](https://atomicly.dev/lessons/deadlocks)

## The situation

Customers can send store credit to each other. Ana and Ben both start with 50.00. At the same moment, Ana sends Ben 10.00 and Ben sends Ana 5.00. Each transfer runs `transfer.sql`:

1. It takes the amount off the sender's account.
2. It adds the amount to the receiver's account.

One of the two transfers fails with error 40P01, "deadlock detected", and its customer sees an error.

## What's wrong

Each `UPDATE` locks the account's row until the transaction ends. Ana's transfer locks Ana's account first, and Ben's transfer locks Ben's account first. Then each one waits for the account the other has locked. Neither can go on, so PostgreSQL cancels one of them.

PostgreSQL checks for a deadlock after a session has waited `deadlock_timeout`, 1 second by default. The test sets it to 100 ms so it runs fast.

## What passing looks like

Both transfers finish with no error. Ana ends with 45.00 and Ben with 55.00.

```sh
npm test -- 03-deadlock
```

The test runs `transfer.sql` in 2 sessions: one with `:from_id` 1, `:to_id` 2, and `:amount` 10, and one with `:from_id` 2, `:to_id` 1, and `:amount` 5.

## Hint

A deadlock needs two transactions that take the same locks in a different order. Make every transfer lock both accounts in the same order, whichever way the money goes, before it changes either one.
