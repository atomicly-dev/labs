# System Design labs

These labs go with atomicly's System Design course. A lesson can show you the numbers. A lab lets you watch a design fail on real servers: a database out of connections, a replica that's behind, a cache key expiring under load, a worker killed mid-job, retries piling onto a slow service, and a rate limit that 4 instances each enforce alone.

Each lab is an experiment. You break it, measure it, and fix it, in 20 to 40 minutes. Do them in any order:

| Lab | Goal | You edit | Lesson |
| --- | --- | --- | --- |
| [01-find-the-bottleneck](01-find-the-bottleneck/) | Doubling the API's instances brings "too many clients" errors and no more throughput. Size the pools so 4 instances serve every request. | `config.mjs` | [System design: find what breaks first at 10x traffic](https://atomicly.dev/lessons/sd-first-bottleneck) |
| [02-read-your-own-write](02-read-your-own-write/) | A customer saves their profile, and the page shows the old name, read from a replica. Route the read after a write to the primary. | `profile.mjs` | Module 2, "Consistency and failure" |
| [03-cache-stampede](03-cache-stampede/) | A hot key expires, and 50 requests run the same slow query at once. Make one miss cost one query. | `product-cache.mjs` | Module 5, "Caching" |
| [04-kill-the-worker](04-kill-the-worker/) | A worker dies mid-job, the queue redelivers the job, and a customer gets the same email twice. Make the job safe to run twice. | `worker.mjs` | [Idempotent writes](https://atomicly.dev/lessons/idempotency) |
| [05-retry-storm](05-retry-storm/) | A slow dependency gets 9 calls per checkout from retries at 2 layers. Keep the retries for blips, and stop them in an outage. | `retry.mjs` | [Call an API with fetch](https://atomicly.dev/lessons/fetch-api-calls) |
| [06-limit-across-replicas](06-limit-across-replicas/) | A limit of 10 requests a minute lets 40 through with 4 instances. Share one count in Redis. | `limiter.mjs` | Module 7, "Bounding failure" |

## Start the services

```sh
npm install
docker compose up -d --wait
```

Run `npm install` first: the API containers run this folder's code, with its `node_modules`. With Podman, use `podman compose` in place of `docker compose`. The first `up` downloads the images, about 700 MB on disk.

This starts every lab's services on 127.0.0.1:

| Service | Port | Used by |
| --- | --- | --- |
| nginx, in front of the API containers (2 to start with) | 8090 | Labs 01 and 06 |
| PostgreSQL 18, with `max_connections` set to 20 | 5443 | Lab 01 |
| PostgreSQL 18 primary, and a streaming replica of it | 5444 and 5445 | Labs 02, 03, and 04 |
| Redis 8 | 6390 | Labs 03 and 06 |
| Toxiproxy's API, and its proxy to the inventory service | 8475 and 8666 | Lab 05 |
| The inventory service, past Toxiproxy | 8091 | Lab 05 |

Every service keeps its data in memory. `docker compose down` stops them and throws the data away, and the next `up` starts from the seed in `postgres/seed.sql`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lab -- 01` | Runs one lab, start to finish: starts the services if they aren't running, runs the lab, and tells you what to do next. Start here. |
| `npm test` | Runs every lab. |
| `npm test -- 01-find-the-bottleneck` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 5` | Runs a lab 5 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |
| `npm run scale -- 4` | Restarts the API as 4 instances, with your file. Add `--lab 06` for lab 06's API. |
| `npm run load` | Sends 800 requests to the API through nginx, 64 at a time, and prints the throughput and the errors. Run `npm run load -- --help` for its options. |
| `npm run db` | Opens psql in the primary. `npm run db -- replica` and `npm run db -- postgres` open the replica and lab 01's database. |

## How a test runs your file

Each lab has one file for you to edit, and the test drives it the way production would:

- **Labs 01 and 06** run your file in the API containers. The test removes the old containers, starts new ones with your file, scales them to 4 behind nginx, and sends load through nginx.
- **Labs 02 and 03** import your file and call it with pools to the real primary and replica, and a real Redis client.
- **Lab 04** starts 3 worker processes with your file, and kills 2 of them mid-job.
- **Lab 05** runs two services with your file, one copy each, in front of the real inventory service, and slows it down with Toxiproxy.

The tests count things, such as failed requests, database queries, emails, and calls, so a lab passes or fails the same way on a slow machine. The README in each lab says exactly what the test does.

When something goes wrong, the test says what users or on-call would see:

```
FAIL 05-retry-storm (retry.mjs)
     During the outage, 30 checkouts made 270 calls to the inventory service, 9 per checkout. They should make at most 45. The service was already too slow, and the retries sent it more work.
```

Each run gets its own Node process. A lab stops after 60 seconds, so a stuck test never hangs. When the lab ends, pass or fail, the test closes its connections and stops the workers it started.

## If something doesn't work

- **`Can't connect to ...` or `Can't reach ...`**: a service isn't running. Run `docker compose up -d --wait` in this folder.
- **`docker compose up` fails on the `api` service**: run `npm install` first, then `up` again.
- **A port is in use**: change it in `compose.yaml`, and set the matching variable from `lib/urls.mjs`, such as `PRIMARY_URL`, when you run the tests.
- **Lab 01 or 06 can't start the API**: look at `docker compose logs api nginx`. A file that doesn't load stops the container, and its error shows there.
- **With Podman, `podman compose down` leaves some `api` containers running**: podman-compose stops only the instances `compose.yaml` starts. Run `npm run scale -- 2` first, then `down`.
