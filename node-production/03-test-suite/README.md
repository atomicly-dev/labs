# Lab 03: An integration test suite

Lessons: [node:test and assert](https://atomicly.dev/lessons/node-test), [Mocks and fake timers](https://atomicly.dev/lessons/mocks-and-timers), and [Bounded request handling](https://atomicly.dev/lessons/request-limits)

## The situation

`service.mjs` is the receipts service, with the fixes from lab 01: a byte limit, one deadline for the body and the tax calls, and a stop when the client leaves. Last month, a refactor broke the byte limit, and nobody noticed for a week. The service has one test, in `receipts.test.mjs`, and it only checks that a normal upload works.

Your job is the suite that would have caught it. It starts the real service on a random port, with in-memory storage and a fake tax API, and sends it real HTTP requests. Don't change `service.mjs`: it's the code under test.

## What on-call sees

- A 40 MB upload got `201`, and nothing in CI failed.
- The one test passes, but `node --test` never exits. The CI job runs until it times out, so everyone has learned to ignore it.

## What to do

Edit `receipts.test.mjs`:

1. Fix what it leaves open. `after` closes the service, but not everything `before` started.
2. Add a test that a receipt over 10 MB gets `413 { error: "Body too large" }`, and that storage doesn't keep it.
3. Add a test that an upload gets `503 { error: "Timed out" }` when the tax API never answers.
4. Add a test that the service stops calling the tax API when the client leaves during a tax call.

The top of `service.mjs` lists what the service answers, and `fakes.mjs` has the storage. `storage.files` is a `Map` from each receipt's ID to its bytes.

## What passing looks like

```sh
npm run lab -- 03
```

The test runs your suite 4 times at once, each in its own Node process:

- Against `service.mjs`, where every test must pass. When the tests end, the process must exit on its own: no server, socket, or timer may stay open.
- Against 3 copies of the service in `broken/`, each with one bug. Against each copy, at least one of your tests must fail. Try the lab before you read them.

A run that doesn't end within 20 seconds is stopped. To run your suite on its own, as CI would:

```sh
node --test 03-test-suite/receipts.test.mjs
```

## Hints

- **Start and stop the servers.** [`before(fn)` and `after(fn)`][hooks] from `node:test` run `fn` once, before the first test and after the last one in the file. They wait for a promise, like a test does. `listen(0, "127.0.0.1")` asks the operating system for any unused port, so two suites never fight over one. `server.close()` waits for the connections that are still busy, so a call your test leaves hanging keeps it waiting. `server.closeAllConnections()` closes them first.
- **Fake the tax API.** The fake is an HTTP server you control, like the dependencies in section 1 of [Mocks and fake timers](https://atomicly.dev/lessons/mocks-and-timers), *Fake a dependency with mock.fn*. To make one test's call hang or fail, keep a variable the fake checks, such as a function that gets each call. Reset it when the test ends, with `t.after`, so the next test gets the normal fake. Section 3, *Restore what you replace*, shows why.
- **The timeout.** A fake that never answers makes the service wait for its deadline, 1.5 seconds. Check what the client gets, not how long it took. Section 1 of [Bounded request handling](https://atomicly.dev/lessons/request-limits), *One deadline for the whole request*, shows the `503`.
- **The client leaves.** Give the client's `fetch` an `AbortController`'s signal, and abort it from inside the fake, when the tax call arrives. Then have the fake answer `503`, which the service retries within 150 ms, and check that no second call came. Section 2 of Bounded request handling, *Stop when the client leaves*, shows what the service does. `fetch` rejects with an `AbortError`, so `await assert.rejects(...)`, as section 3 of [node:test and assert](https://atomicly.dev/lessons/node-test), *Await what you test*, shows.
- **A test that can't fail.** If your suite passes against a broken copy, read that copy's bug in the lab's message, and ask what your test checks. A test that only checks the status can pass for the wrong reason.

[hooks]: https://nodejs.org/docs/latest-v24.x/api/test.html#beforefn-options
