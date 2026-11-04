# Lab 01: Order import

Lessons: [Limit how many run at once](https://atomicly.dev/lessons/concurrency-limits), [Paged APIs with for await](https://atomicly.dev/lessons/async-iteration), and [Timeouts that clean up](https://atomicly.dev/lessons/timeouts)

## The situation

Each night, the shop copies the orders a partner took for it into its own orders service. `importOrders` in `importer.mjs` does the copy, in two steps:

1. It reads the partner's orders, a page at a time. Each page has a `nextCursor`, the value you send to get the next page.
2. It sends each order to the orders service with a `POST`.

The orders service handles 5 requests at a time. It answers `429 Too Many Requests` to any more, and `422` to an order it can't accept.

## What users see

The import worked in testing, with 3 orders. With a real night's orders, it fails every time, and the ops team can't tell which orders made it. And on a night when one save got stuck, the import never finished at all, and the morning's report showed no orders.

## What's wrong

There are 4 bugs:

- `importOrders` loads every page before it saves a single order. The partner has thousands of pages, so every order sits in memory, and the first save waits for the last page.
- It sends every save at once with `Promise.all`, so the orders service answers 429 to all but 5.
- One failed save rejects `Promise.all`, and that stops the whole import. A bad order should go on the `failed` list, and the import should go on.
- Nothing limits how long a request takes. A save that never gets an answer keeps the import waiting forever.

## What passing looks like

```sh
npm run lab -- 01
```

The test starts two real HTTP servers on random ports: the partner's API, with 60 orders in 6 pages, and the orders service. It calls `importOrders` with their URLs and watches the import from the servers' side:

- Orders 1017 and 1044 are invalid, so the orders service answers 422.
- The orders service never answers the save of order 1033.

The lab passes when:

- The orders service never has more than 5 saves at once, and never answers 429.
- The import asks for a page only after it sent orders from the page before it.
- Every valid order gets saved, and the result's `failed` list has 1017, 1044, and 1033, each with a reason.
- The save of 1033 gives up after 1 second, and its request closes on the server.
- No order gets sent twice.

## Hints

- **Load the pages lazily.** Turn the page loop into an async generator that yields one order at a time. Section 1 of [Paged APIs with for await](https://atomicly.dev/lessons/async-iteration), *Move the paging into an async generator*, shows how, and section 2, *The next page loads when the loop asks for it*, shows why it loads only what the loop needs.
- **Send 5 at a time.** Use a pool of 5 workers. Section 2 of [Limit how many run at once](https://atomicly.dev/lessons/concurrency-limits), *A pool of workers*, shows one over an array. Your workers can share the async generator instead: each `for await` loop on the same generator object gets the next order.
- **Keep going after a failure.** Section 4 of the same lesson, *When a call fails*, shows the choice: stop the pool, or record each outcome and go on. Here you want the second.
- **Give each request 1 second.** Section 3 of [Timeouts that clean up](https://atomicly.dev/lessons/timeouts), *AbortSignal.timeout stops the work*, shows a signal that aborts on its own. `fetch` takes it in its options. Section 2, *A race doesn't stop the loser*, shows why `Promise.race` isn't enough: the request keeps running.
- **Don't retry.** A 422 fails the same way every time. And as the end of section 3 explains, a save that timed out may have gone through, so a second `POST` can save the order twice.
