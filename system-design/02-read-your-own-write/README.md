# Lab 02: Read your own write

Lessons: [Consistency models: explain a disappearing update](https://atomicly.dev/lessons/sd-consistency-models) and [Replication and failover: find the last durable write](https://atomicly.dev/lessons/sd-replication-failover).

## The situation

The shop's database has a primary and a streaming replica. The primary takes every write, and streams its changes to the replica. The app sends reads to the replica, so the primary has room for checkouts.

Ann opens her settings page, changes her display name from "Ann" to "Ann Lee", and presses Save. The page reloads and shows "Ann". She refreshes a few seconds later, and there's "Ann Lee". Support gets a ticket: "Saving my profile doesn't work, until it does."

## Try it

The replica in this lab applies each change 2 seconds after the primary commits it, so the lag always shows. A real replica lags by a few milliseconds on a quiet day, and by seconds or more under load, or while it replays a big migration.

Change Ann's name on the primary, and read it from the replica right away:

```sh
npm run db -- primary -c "UPDATE profiles SET display_name = 'Ann Lee' WHERE id = 1"
npm run db -- replica -c "SELECT display_name FROM profiles WHERE id = 1"
```

The replica still says "Ann". Run the second line again after 2 seconds. Then run the lab:

```sh
npm run lab -- 02
```

## What's wrong

`profile.mjs` sends every read to the replica, including the read right after a customer's own write. Replication is asynchronous: the primary confirms a commit before the replica has it. So a read from the replica can return a value older than one the same customer just saved.

Customers accept that another customer's change takes a moment to show. They don't accept losing their own.

## What passing looks like

The test calls `updateProfile` with Ann's session, then `getProfile`, as the settings page does. She should see "Ann Lee".

Then Bilal, who changed nothing, loads his own profile and Ann's, 10 times each. All 20 reads should still go to the replica. Sending every read to the primary fixes Ann's page, and takes away the reason the shop has a replica.

## Hint

Fix `profile.mjs`. The app keeps one `session` object per customer between requests, so `updateProfile` can leave a note there for `getProfile`. Which reads need the primary, and for how long? A time window is the simple answer. A more exact one records the primary's write-ahead log position after the write, with `pg_current_wal_lsn()`, and reads from the replica once `pg_last_wal_replay_lsn()` there has reached it.
