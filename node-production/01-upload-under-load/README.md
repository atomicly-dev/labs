# Lab 01: Upload under load

Lessons: [Bounded request handling](https://atomicly.dev/lessons/request-limits), [Streaming across HTTP](https://atomicly.dev/lessons/streaming-http), and [Call an API with fetch](https://atomicly.dev/lessons/fetch-api-calls)

## The situation

Customers photograph their receipts in the mobile app, and the app uploads each one to the receipts service. `createService` in `service.mjs` handles the upload, in two steps:

1. It saves the file to storage.
2. It asks the tax API for the receipt's VAT, and answers `201` with `{ id, bytes, vat }`.

The tax API is flaky. Some calls get a `503`, and some get no answer at all. The mobile app gives up after 2 seconds.

## What users and on-call see

The service worked fine in testing. At the end of the month, when everyone uploads their expenses, it falls over:

- The service's memory climbs with every upload, and the container gets killed for using too much.
- Someone uploaded a 40 MB scan, and storage kept it, though the app promises 10 MB at most.
- During a tax API outage, the app shows a spinner, then "No connection". On-call sees requests that run for minutes, still retrying the tax API long after the customer closed the app.
- When traffic doubles, the service takes every upload, and runs out of memory instead of turning some away.

## What's wrong

There are 4 bugs:

- The route collects the whole body in an array before it saves a byte, and has no byte limit.
- Nothing limits how long a request takes. The body read can wait forever for a slow phone, and `getVat` retries forever, with no timeout on each call.
- When the client leaves, the work goes on. Nobody waits for the answer, but the service keeps calling the tax API.
- Nothing limits how many uploads run at once.

## What passing looks like

```sh
npm run lab -- 01
```

The test starts the service in a process of its own, with fake storage that takes a millisecond per chunk, and a real tax API on a random port. Each upload gets a connection of its own, the way separate phones send them. The lab passes when:

- A 300 KB receipt gets `201` with its VAT.
- While an 8 MB receipt uploads, the service never holds more than 1 MB of it in memory. The test counts the bytes the service has read from its sockets and not yet passed to storage.
- A 12 MB upload gets `413 { error: "Body too large" }`, and storage doesn't keep it.
- When the tax API answers `503` once, the upload still gets `201`, after a retry.
- When the tax API never answers, the upload gets `503 { error: "Timed out" }` within the 1.5-second deadline, with at most 3 tax calls, all closed.
- When a phone sends 1 KB of its upload and then nothing, the service answers or closes the connection by the deadline, and storage doesn't keep the half file.
- When the client leaves during a tax call, the service makes no more tax calls for it, and the open call closes.
- When 6 uploads arrive at once, the service works on at most 4, and answers `503 { error: "Server busy" }` to the rest right away.

## Hints

- **Stream the upload.** Section 1 of [Streaming across HTTP](https://atomicly.dev/lessons/streaming-http), *Stream an upload into storage*, shows `pipeline` from `req` into a storage stream, with an async generator that counts the bytes and throws past the limit. When it throws, `pipeline` destroys the storage stream, so storage discards the file.
- **One deadline for the whole request.** Section 1 of [Bounded request handling](https://atomicly.dev/lessons/request-limits), *One deadline for the whole request*, shows one signal for the body read and every try, with `AbortSignal.any` to give each try its own 500 ms. `pipeline` takes the signal in its options, as section 3 of Streaming across HTTP shows. Section 4 of [Call an API with fetch](https://atomicly.dev/lessons/fetch-api-calls), *Retry within a budget*, shows why the retries need that budget too.
- **Stop when the client leaves.** Section 2 of Bounded request handling, *Stop when the client leaves*, shows why `req`'s `close` event is the wrong one, and how `res`'s `close` with `res.writableFinished` aborts a controller. Combine it with the deadline, and pass the one signal to every step, the sleep between tries too.
- **Tell a timeout from a client that left.** The same section shows how: `signal.reason.name` is `"TimeoutError"` when the deadline passed, and the client still waits for its `503`. A client that left gets no answer.
- **Turn away what you can't serve.** Section 3, *Turn away what you can't serve*, shows a count of the requests in progress, and a `503` with `Retry-After` past the limit. Count down when the handler finishes, not when `res` closes.
