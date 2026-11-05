# Lab 02: Shutdown and request context

Lessons: [Shutdown under traffic](https://atomicly.dev/lessons/node-shutdown-under-load), [Logging](https://atomicly.dev/lessons/node-logging), and [Metrics and traces for an incident](https://atomicly.dev/lessons/node-metrics-and-traces)

## The situation

The receipts service runs in Kubernetes, behind a load balancer, and deploys several times a day. `createService` in `service.mjs` handles an upload:

1. It saves the file to storage, and asks the tax API for the VAT, with up to 3 tries.
2. It answers `201`, then starts a background job that writes the receipt to the ledger with `pool.query`.

It logs one JSON line per event, with a `requestId`. On `SIGTERM`, it closes the server, then the pool, as the lesson [Graceful shutdown](https://atomicly.dev/lessons/node-graceful-shutdown) shows.

## What users and on-call see

- On every deploy, a few uploads fail with a connection error, though the old pod is still running.
- After a deploy, some receipts got their `201`, but never reached the ledger. Finance finds the gaps at the end of the month.
- Some pods take 10 seconds to stop, with no request in progress.
- The traces from a deploy's last seconds are missing, the ones on-call needs to see what the deploy broke.
- An upload failed with "Tax API failed". On-call searches the logs for its `requestId`, and finds lines from other uploads, but not its own tax calls. The tax API team can't find the calls either: they carry no trace.

## What's wrong

There are 6 bugs:

- On `SIGTERM`, the server stops taking connections right away. `/ready` never fails, so the load balancer keeps sending uploads, and they're refused.
- Nothing waits for the background jobs. The pool closes while they still need it, and the process exits.
- Nothing flushes the telemetry before the process exits.
- No deadline covers the shutdown. A connection that stays open, or a job that never finishes, keeps it waiting until the platform kills it.
- The log's `requestId` comes from a module variable, so a request that waits at an `await` logs with the ID of the request that started after it.
- The tax calls carry no `traceparent`, and the log lines no trace ID.

## What passing looks like

```sh
npm run lab -- 02
```

The test starts the service in a process of its own, with a real tax API on a random port, a fake pool whose queries take 150 ms, and fake telemetry. It sends 3 uploads at once, then `r-2004`, whose ledger query never finishes, as when a row lock holds it up. Then it plays the load balancer: 4 uploads at a time, 2 on keep-alive connections and 2 on new ones, and a call to `/ready` every 50 ms. 300 ms in, it sends the service `SIGTERM`. The load balancer stops sending after 2 failed `/ready` checks, and the test kills the process if it's still running 5 seconds after `SIGTERM`, as Kubernetes does at the end of its grace period. The lab passes when:

- Every upload the load balancer sent after `SIGTERM` got its `201`.
- `/ready` answered `503` after `SIGTERM`, while the server still took uploads.
- Every receipt that got `201` reached the ledger, except `r-2004`, and no ledger job lost its pool.
- The telemetry flushed after the pool closed, and the process exited with code `0` within 5 seconds.
- The log lines of each upload, its background job's included, carry the same `requestId`, and no other upload's lines carry it.
- Each tax call carries a valid `traceparent` with its upload's trace ID, and the upload's log lines carry that `traceId` too. `r-2003` arrives with a `traceparent` from the mobile app, and keeps its trace ID and flags.

The top of `service.mjs` lists the shutdown's steps and their deadlines.

## Hints

- **Fail the readiness check first.** Section 1 of [Shutdown under traffic](https://atomicly.dev/lessons/node-shutdown-under-load), *New requests arrive after SIGTERM*, shows why uploads still arrive after `SIGTERM`, and how a `/ready` that answers `503` lets the load balancer stop sending. Section 2, *Close the load balancer's connections*, shows the `Connection: close` header for the keep-alive connections.
- **Finish background work, then close the pool.** Section 3, *Finish background work, then close the pool*, shows a `Set` of running jobs, why the handlers go in it too, and the order: the server, then the jobs, then the pool.
- **Flush telemetry last.** Section 4, *Flush telemetry last*, shows why `telemetry.shutdown()` comes after everything that makes spans.
- **One deadline for every step.** Section 5, *One deadline for every step*, shows `upTo` and two deadlines that start at `SIGTERM`: one for the requests, the jobs, and the pool, and a later one for the whole shutdown. `r-2004`'s job never finishes, so a shutdown that waits for it without a deadline never ends.
- **Carry the request ID without passing it.** Section 2 of [Logging](https://atomicly.dev/lessons/node-logging), *Pass the request ID without passing it*, shows this exact bug, and `AsyncLocalStorage`. Start the handler, and the job it starts, inside `run`, so the job's line carries the ID too.
- **Pass the trace on.** Section 4 of [Metrics and traces for an incident](https://atomicly.dev/lessons/node-metrics-and-traces), *Follow one request across services*, shows how to check an incoming `traceparent`, keep its trace ID and flags, make a span ID of your own, and send the header on an outbound call. Keep the trace ID and the span ID in the same store as the request ID, and put the trace ID in each log line.
