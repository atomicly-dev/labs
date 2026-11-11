# Backups and disaster recovery labs

These labs go with atomicly's Backups and disaster recovery course. The course's lessons run in your browser, where nothing can archive PostgreSQL's write-ahead log (WAL). Here, you run two real PostgreSQL servers: production, which archives its WAL, and a new server beside it, where you restore.

| Lab | Goal | You edit | Lesson |
| --- | --- | --- | --- |
| [01-point-in-time-restore](01-point-in-time-restore/) | A support script deleted every order. Restore the database to just before the `DELETE`, on a new server beside production, and check it before recovery ends. | `restore.sh` | [Point-in-time recovery](https://atomicly.dev/lessons/dr-pitr) |

## Start the servers

```sh
docker compose up -d --wait
npm install
```

With Podman, use `podman compose` in place of `docker compose`. This starts two PostgreSQL 18 servers on 127.0.0.1:

| Server | Port | What it is |
| --- | --- | --- |
| `production` | 5446 | The shop's database, with `archive_mode` on. Its `archive_command` copies each completed WAL segment to `/mnt/archive`. |
| `restore` | 5447 | A new server beside production. It has no database until you restore one. It can read production's WAL archive and base backups, and can't change them. |

Everything lives in memory: production's data, its WAL archive, its base backups, and the restored server.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lab -- 01` | Runs one lab, start to finish: starts the servers if they aren't running, runs the lab, and tells you what to do next. Start here. |
| `npm test` | Runs every lab. |
| `npm test -- 01-point-in-time-restore` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 5` | Runs a lab 5 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |
| `npm run restore` | Lab 01 by hand: runs the incident and your `restore.sh`, then stops while recovery pauses, so you can check the orders and end recovery yourself. |
| `npm run db` | Opens psql in production. `npm run db -- restored` opens it in the restored server. |
| `npm run log` | Prints the restored server's log, from its last start. |

## How a test runs your file

Each lab has one shell script for you to edit, and its test drives it the way an incident would:

1. The test plays the incident on production. It puts the orders back to the seed, takes a new base backup with `pg_basebackup`, and then makes the changes and the mistake the lab's README describes. Production archives every WAL segment.
2. On the new server, it runs your script as the `postgres` user, with an empty data directory in `$PGDATA`. Then it starts PostgreSQL there.
3. It checks the restored server the way you would: where recovery stopped, which orders it has, and what happens when recovery ends.

Each run starts again from step 1, so you never need to reset anything. When something goes wrong, the test says what you'd find on the restored server:

```
FAIL 01-point-in-time-restore (restore.sh)
     The restored server has the 1,200 orders from last night's base backup, but none of the 30 orders placed this morning, before the DELETE. It started from the base backup alone, and didn't replay production's archived WAL.
```

A run takes a few seconds. A lab stops after 60 seconds, so a stuck test never hangs. The restored server keeps running after a test, so you can look at it with `npm run db -- restored` and `npm run log`.

## If something doesn't work

- **`Can't connect to production` or `Can't run a command in the restore container`**: the servers aren't running. Run `docker compose up -d --wait` in this folder.
- **Port 5446 or 5447 is in use**: change the port in `compose.yaml`, and run the tests with `PRODUCTION_URL=postgres://postgres:postgres@localhost:<port>/shop` or `RESTORED_URL=...` set.
- **`The test couldn't put production's orders back to the start`**: a transaction you opened in psql on production holds a lock. End it with `COMMIT` or `ROLLBACK`.
- **The restored server stopped**: the test shows the errors from its log. `npm run log` prints the whole log.

## When you're done

```sh
docker compose down -v
```

This stops both servers, and throws away everything they had in memory: the data, the archive, and the backups. The next `up` starts from the seed again.
