# atomicly labs

Hands-on labs for the courses on [atomicly](https://atomicly.dev). Each lab gives you a small piece of broken code from a real situation. You fix it, run the test, and see it pass.

The lessons in the browser can't do everything. A lab runs on your machine, against a real server, so it can show what happens when two connections hit the same rows at the same time.

| Folder | Course | What you practice |
| --- | --- | --- |
| [postgres-concurrency](postgres-concurrency/) | PostgreSQL, module 13 "Concurrency" | Lost updates, row locks, a job queue, deadlocks, and serialization failures |

## What you need

- Docker, or Podman with `podman compose`.
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

On the first run, every test fails. That's the starting point: each lab's README tells you what's wrong and which file to fix. With Podman, run `podman compose up -d --wait` in place of the `docker compose` line.

When you're done, stop the database with `docker compose down`.

## License

MIT. See [LICENSE](LICENSE).
