# Node.js production labs

These labs go with module 12, "Running Node in production", of atomicly's Node.js course, and with the modules before it on HTTP, logging, and testing. Each lesson teaches one concern at a time: a byte limit, a deadline, a shutdown step, a request ID. A real service needs all of them at once, under traffic, against an API that's slow or fails. That's what these labs give you.

All 3 labs use one small service, `receipts-service`. The mobile app uploads photos of receipts to it. It saves each file to storage, asks a flaky tax API for the VAT, and writes the receipt to a ledger in the background. Do the labs in order. Lab 03 tests the service as lab 01 left it. Lab 02's file leaves out lab 01's limits, to stay short.

| Lab | Goal | You edit | Lesson |
| --- | --- | --- | --- |
| [01-upload-under-load](01-upload-under-load/) | The service runs out of memory at the end of the month, and keeps working for clients that left. Stream the upload with a byte limit, give each request one deadline, stop when the client leaves, and turn away what it can't serve. | `service.mjs` | [Bounded request handling](https://atomicly.dev/lessons/request-limits) |
| [02-shutdown-and-context](02-shutdown-and-context/) | Deploys drop uploads and ledger entries, and the logs can't connect a failed upload to its tax call. Shut down in order under one deadline, and carry the request ID and the trace through every log line and call. | `service.mjs` | [Shutdown under traffic](https://atomicly.dev/lessons/shutdown-under-load) |
| [03-test-suite](03-test-suite/) | A broken byte limit went out, and nothing in CI failed. Write the `node:test` suite that catches it, and two other bugs, and leaves nothing open. | `receipts.test.mjs` | [node:test and assert](https://atomicly.dev/lessons/node-test) |

## Start

You need Node.js 24 or later. The labs have no dependencies and no database, so there's nothing to start first:

```sh
npm install
npm run lab -- 01
```

Lab 02 sends the service `SIGTERM`, so it needs macOS or Linux. On Windows, use WSL.

## Commands

| Command | What it does |
| --- | --- |
| `npm run lab -- 01` | Runs one lab, and tells you what to do next. Start here. |
| `npm test` | Runs every lab. |
| `npm test -- 01-upload-under-load` | Runs one lab. `npm test -- 01` works too. |
| `npm test -- 01 --repeat 20` | Runs a lab 20 times, to check that your fix holds every time. |
| `npm test -- --solution` | Runs the solutions. Try the lab yourself first. |

## How a test runs your file

Labs 01 and 02 start your `service.mjs` in a Node process of its own, the way production runs it. The test calls `createService` with fakes it controls, listens on a random port, and talks to the service over real HTTP. The tax API is a real HTTP server in the test's process, on a random port too, and records every call from its side:

- **Lab 01**: the test sends uploads the way phones do: big files, a slow network, an app that gives up. It counts the bytes the service holds in memory, what storage keeps, and the tax calls that run for clients that left.
- **Lab 02**: the test plays the load balancer and Kubernetes. It sends steady traffic, sends `SIGTERM`, and kills the process if it's still running 5 seconds later. The fake pool and telemetry record when they close, and the test reads every log line the service printed.
- **Lab 03**: the test runs your suite against the real service, and against 3 copies with a bug each.

The fakes' delays are under the test's control, so a lab passes or fails the same way on a slow machine. The top of each file, and each lab's README, say exactly how the test runs it.

When something goes wrong, the test says what the app's users, or the on-call engineer, would see:

```
FAIL 01-upload-under-load (service.mjs)
     The tax API never answered r-1005. The mobile app waited 5 seconds and got no response. It should get 503 { error: "Timed out" } within the 1.5-second deadline, while the app still waits.
```

Each run gets its own Node process, so nothing your code leaves behind changes the next run. A lab stops after 30 seconds, so a stuck test never hangs. When the lab ends, pass or fail, the test stops the service's process, and closes every server and socket it opened.

## If something doesn't work

- **`These labs need Node.js 24 or later`**: run `node --version`, and install a newer Node.js.
- **The output shows `console.log` lines**: those come from your file. The test doesn't hide them, so you can log while you work. In labs 01 and 02, the service's JSON log lines go to the test instead.
