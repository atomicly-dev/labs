# JavaScript production labs

These labs go with modules 11, "Async in production", and 14, "Memory", of atomicly's JavaScript course. Each lesson teaches one mechanism at a time: a timeout, a cancel, a concurrency limit, a cache with a limit. Real code needs several of them at once, against a real server that's slow, fails, or never answers. That's what these labs give you.

Do them in any order. Each one goes with a lesson:

| Lab | Goal | You edit | Lesson |
| --- | --- | --- | --- |
| [01-order-import](01-order-import/) | A nightly import fails on every real night, or never finishes. Make it stream pages, send 5 saves at a time, time out, and report bad orders without stopping. | `importer.mjs` | [Limit how many run at once](https://atomicly.dev/lessons/concurrency-limits) |
| [02-search-box](02-search-box/) | A search box shows results for an old query, and leaves old requests running. Make it show only the newest search, and stop the ones it replaced. | `search.mjs` | [Cancel work you no longer need](https://atomicly.dev/lessons/cancellation) |
| [03-memory-leak](03-memory-leak/) | An upload worker's memory grows all week. Find which structures leak with heap snapshots, and fix them. | `worker.mjs` | [Find a memory leak](https://atomicly.dev/lessons/finding-a-leak) |

## Start

You need Node.js 24 or later. The labs have no dependencies and no database, so there's nothing to start first:

```sh
npm install
npm run lab -- 01
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run lab -- 01` | Runs one lab, and tells you what to do next. Start here. |
| `npm test` | Runs every lab. |
| `npm test -- 01-order-import` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 20` | Runs a lab 20 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |
| `npm run snapshots` | Runs lab 03's worker and writes two heap snapshots, for Chrome DevTools. |

## How a test runs your file

Each lab has one file for you to edit. Its test imports your module, starts real HTTP servers on random ports, and drives your code the way production would. Your code uses the real `fetch`, over real sockets, and the servers record each request from their side:

- **Lab 01, `importer.mjs`**: the test calls `importOrders` with the URLs of a paged partner API and an orders service. The servers count how many saves run at once, which pages load when, and which requests stay open.
- **Lab 02, `search.mjs`**: the test plays the search page. It calls `search` as a user types, with answers from the search API in a fixed order, and records what the page shows and which requests the client closed.
- **Lab 03, `worker.mjs`**: the test runs 300 upload jobs through `handle`, then runs the garbage collector and counts, with `WeakRef`, which objects are still alive.

The servers' delays are under the test's control, so a lab passes or fails the same way on a slow machine. The top of each file, and each lab's README, say exactly how the test runs it.

When something goes wrong, the test says what the app's users would see:

```
FAIL 02-search-box (search.mjs)
     The user typed "laptop", and the page ends up showing the results for "lap": Lap desk, Laptop, and Laptop stand. The older search answered last, and its results replaced the newer ones.
```

Each run gets its own Node process, started with `--expose-gc`, so nothing your code leaves behind changes the next run. A lab stops after 30 seconds, so a stuck test never hangs. When the lab ends, pass or fail, the test closes every server and socket it opened.

## If something doesn't work

- **`These labs need Node.js 24 or later`**: run `node --version`, and install a newer Node.js.
- **The output shows `console.log` lines**: those come from your file. The test doesn't hide them, so you can log while you work.
