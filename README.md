# atomicly labs

Hands-on labs for the courses on [atomicly](https://atomicly.dev). Each lab gives you a small piece of broken code from a real situation. You fix it, run the test, and see it pass.

The lessons in the browser can't do everything. A lab runs on your machine, against a real server, so it can show what happens when two connections hit the same rows at the same time, when an app runs out of connections, when an API never answers, or when you replay a database's write-ahead log to just before a mistake.

| Folder | Course | What you practice |
| --- | --- | --- |
| [postgres-concurrency](postgres-concurrency/) | PostgreSQL, module 13 "Concurrency" | Lost updates, row locks, a job queue, deadlocks, and serialization failures |
| [postgres-pooling](postgres-pooling/) | PostgreSQL, module 15 "Connection pooling" | A leaked pool client, pool sizes and `max_connections`, and session settings behind PgBouncer |
| [postgres-production](postgres-production/) | PostgreSQL, modules 16 "Designing and changing a live database" and 17 "Diagnosing production" | Finding a slow query with `pg_stat_statements`, a migration that doesn't block live traffic, and an idempotent payment webhook |
| [js-production](js-production/) | JavaScript, modules 11 "Async in production" and 14 "Memory" | A paged import with a concurrency limit and timeouts, a search box that cancels old requests, and a worker's memory leak found with heap snapshots |
| [node-production](node-production/) | Node.js, module 12 "Running Node in production", with modules 7 "HTTP servers and API calls", 8 "Errors in production", and 9 "Testing with node:test" | A receipts service that bounds its uploads under load, shuts down under traffic with a request ID and a trace in every log line, and gets an integration test suite |
| [system-design](system-design/) | System Design | Finding the bottleneck when the API scales, a stale read from a replica, a cache stampede, a worker killed mid-job, a retry storm, and a rate limit across replicas |
| [disaster-recovery](disaster-recovery/) | Backups and disaster recovery, module "Point-in-time recovery" | A point-in-time restore: last night's base backup and production's archived WAL, replayed on a new server to just before a bad `DELETE` |

## What you need

- Docker, or Podman with `podman compose`, for the PostgreSQL, System Design, and disaster recovery labs. The JavaScript and Node.js labs don't need it.
- Node.js 24 or later, with npm.
- Git, to clone this repo.

## Start

```sh
git clone https://github.com/atomicly-dev/labs.git atomicly-labs
cd atomicly-labs/postgres-concurrency
docker compose up -d --wait
npm install
npm test
```

On the first run, every test fails. That's the starting point: each lab's README tells you what's wrong and which file to fix. The other PostgreSQL folders and `disaster-recovery` work the same way: `cd` into one and run the same commands. With Podman, run `podman compose up -d --wait` in place of the `docker compose` line. The `js-production` and `node-production` folders have no database, so skip the `docker compose` line there. In `system-design`, run `npm install` before `docker compose up`, because the API containers use the folder's `node_modules`.

When you're done, stop the database with `docker compose down`.

## License

MIT. See [LICENSE](LICENSE).
