# Lab 02: Search box

Lessons: [Cancel work you no longer need](https://atomicly.dev/lessons/js-cancellation) and [Timeouts that clean up](https://atomicly.dev/lessons/js-timeouts)

## The situation

The shop's search box sends a search on each input. `createSearchBox` in `search.mjs` is the part of the page that does it. The page calls `search(query)` as the user types, and shows what the two callbacks get: `onResults(query, products)` and `onError(error)`. When the user leaves the search page, the page calls `destroy()`.

A search that takes longer than 1 second should give up and show an error. Right now, `withTimeout` does that with `Promise.race`.

## What users see

- A user types `laptop`, and the page shows the results for `lap`: a lap desk.
- The search API's logs show every search the user typed on the way, each one run to the end, though nobody sees the results.
- A search that times out shows its error, but the search API keeps working on it.
- A user leaves the search page, and the search API keeps working on the search they left.

## What's wrong

Each call to `search` runs on its own. Nothing ties it to the search after it, so the results show in the order the responses arrive, and nothing stops a request the page no longer needs. `withTimeout` only stops the wait: the request keeps running, and so does the timer, for a full second after each search. And `destroy()` hides the results, but the request keeps running.

## What passing looks like

```sh
npm run lab -- 02
```

The test starts a real search API on a random port, and plays the page. The API answers each query when the test says so, so the order is the same on every run:

1. The user types `l`, `la`, `lap`, and `laptop`. The API answers `laptop` right away, and the 3 older searches only after that.
2. The user searches for `printer ink`, and the API never answers.
3. The user searches for `monitor`, then leaves the page before the answer.

The lab passes when:

- The page ends up showing the results for `laptop`, and nothing from an older search after them.
- The requests for `l`, `la`, and `lap` close on the server as soon as the next search starts.
- No timer is left waiting when the `laptop` results show.
- The `printer ink` search shows an error after 1 second, and its request closes on the server.
- `destroy()` closes the `monitor` request on the server, and nothing shows after it.
- The page never shows an error for a search that a newer search, or `destroy()`, stopped, and no promise rejects with no handler.

## Hints

- **The slower response wins.** Section 1 of [Cancel work you no longer need](https://atomicly.dev/lessons/js-cancellation), *The slower response wins*, shows this exact bug, and section 2, *Ignore a response that's out of date*, shows why ignoring the old response isn't enough here.
- **Stop the old request.** Section 3, *Abort the search you replaced*, shows an `AbortController` for each search, and what to do with the `AbortError` it causes. `destroy()` can use the same controller.
- **A timeout that stops the request.** Section 3 of [Timeouts that clean up](https://atomicly.dev/lessons/js-timeouts), *AbortSignal.timeout stops the work*, shows a signal that aborts after a time limit. Section 4, *Tell a timeout from a cancel*, shows how to combine it with your controller's signal, and how to tell the two apart: one is worth an error message, and the other isn't.
- **An error with no handler.** If you let an `AbortError` escape `search`, the page's promise rejects with no handler. [Errors in async code](https://atomicly.dev/lessons/js-async-errors), section 1, *A rejection nobody handles stops the server*, shows what that does.
