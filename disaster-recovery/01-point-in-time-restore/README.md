# Lab 01: Point-in-time restore

Lesson: [Point-in-time recovery: back to one minute before the bad DELETE](https://atomicly.dev/lessons/dr-pitr)

## The situation

The shop's production database archives its WAL: `archive_command` copies each completed WAL segment to `/mnt/archive`. Every night, a job takes a base backup with `pg_basebackup`, into `/backups/base`.

This morning, 30 orders came in. Then a support script that should have deleted a few test orders ran `DELETE FROM orders`, and every order was gone, 1,230 of them. Here's its log, `cleanup-test-orders.log`:

```text
2026-11-11T09:32:08.912+00:00 cleanup-test-orders: started, deleting test orders
2026-11-11T09:32:09.321+00:00 cleanup-test-orders: DELETE 1230
```

The shop kept taking orders after the `DELETE`: production has 5 new ones, and a restore over production would lose them. So you don't restore over it. You restore on a new server beside it, with the runbook's restore script, `restore.sh`. It copies last night's base backup into the new server's empty data directory, and then the server starts.

## What's wrong

The base backup brings back the 1,200 orders from before last night. It doesn't have this morning's 30 orders: they came in after the backup, so they're only in the WAL that production archived since then. A restore that stops at the base backup loses them.

## What passing looks like

```sh
npm run lab -- 01
```

On each run, the test plays the incident again on production: the seed, a new base backup, this morning's orders, the `DELETE`, and the 5 orders after it. Then it runs `restore.sh` on the new server, and starts PostgreSQL there.

The lab passes when:

- Recovery pauses at a target, so you can check the data before the server takes writes.
- While recovery pauses, the restored server has all 1,230 orders the `DELETE` removed, and none of the 5 orders that came in after it.
- After `pg_wal_replay_resume()`, recovery ends, and the server takes writes on a new timeline, timeline 2.

## How the test runs `restore.sh`

The test runs `restore.sh` with `sh`, in the restore container, as the `postgres` user, from this folder. In that container:

- `$PGDATA` is the new server's data directory, and it's empty.
- `/backups/base` is last night's base backup, and `/mnt/archive` is production's WAL archive. Both are read-only, so a restore can't change them.
- `cleanup-test-orders.log` is in the current folder. The test writes it before each run, so the times in it change on every run. Read them from the file, not from an earlier run.

When `restore.sh` is done, the test starts PostgreSQL on `$PGDATA` with `pg_ctl start`, so don't start the server in the script. The server's log shows what recovery did. `npm run log` prints it.

## Do it by hand

Once the lab passes, do the last two steps yourself. Run the incident and your restore, and stop while recovery pauses:

```sh
npm run restore
```

It prints the restored server's log. These lines say where recovery stopped:

```text
LOG:  recovery stopping before commit of transaction 1739, time 2026-11-11 09:32:09.216388+00
LOG:  pausing at the end of recovery
HINT:  Execute pg_wal_replay_resume() to promote.
```

That commit is the `DELETE`'s. Open psql on the restored server, and check the orders:

```sh
npm run db -- restored
```

```sql
SELECT count(*), max(id), max(ordered_at) FROM orders;
```

While recovery pauses, the server takes read-only queries. An `INSERT` fails with `cannot execute INSERT in a read-only transaction`. When the orders look right, end recovery. A moment later, the server is out of recovery, on timeline 2:

```sql
SELECT pg_wal_replay_resume();
SELECT pg_is_in_recovery(), timeline_id FROM pg_control_checkpoint();
```

Production still has its 5 orders from after the `DELETE`, and the restored server has the 1,230 the `DELETE` removed. Both histories exist side by side. Run `npm run db` to look at production's.

## Hint

A point-in-time restore needs three things on the new server, besides the base backup:

- `restore_command` in `postgresql.conf`: the shell command that copies one WAL segment from the archive. `%f` is the segment's file name, and `%p` is the path to copy it to.
- `recovery_target_time` in `postgresql.conf`: where replay stops. Recovery applies every commit up to that time, and stops before the first commit after it. Which line of the support script's log comes before the `DELETE` committed? Keep the time's offset from UTC, as the log writes it.
- An empty `recovery.signal` file in `$PGDATA`, which starts the server in recovery mode. Without it, the server ignores the other two settings.

Leave `recovery_target_action` at its default, `pause`.
