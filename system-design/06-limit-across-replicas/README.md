# Lab 06: A limit across replicas

Lesson: [Rate limiting: share a budget across replicas](https://atomicly.dev/lessons/sd-rate-limiting).

## The situation

The shop has a partner API, so resellers can read their orders. The contract says 10 requests a minute per API key, and `limiter.mjs` enforces it. It passed every test on a laptop.

In production, the partner API runs as 4 instances behind nginx. A reseller's sync job sends a burst every minute, and the database team asks why that reseller makes 40 requests a minute when the limit is 10.

## Try it

Start the partner API as 4 instances, and send 60 requests with one API key:

```sh
npm run scale -- 4 --lab 06
npm run load -- --path /orders --header "x-api-key: acme" --requests 60 --connections 20
```

Count the `200` answers. Then try `npm run scale -- 1 --lab 06` and a new API key, such as `acme-2`, and count again.

## What's wrong

Each instance keeps its counts in its own memory. nginx sends the requests to the instances in turn, so each instance sees a quarter of them, and allows 10 of its own. With 4 instances, a key gets 4 times its limit. Add instances for Black Friday, and the limit grows with them.

A limit for the whole API needs one count that every instance shares.

## What passing looks like

```sh
npm run lab -- 06
```

The test restarts the API as 4 instances with your `limiter.mjs`. One partner sends 60 requests, 20 at a time, and a second partner sends 30. Each partner should get exactly 10 answers of `200`, and `429` for the rest. Each run uses new API keys, so the counts of one run don't carry into the next.

## Hint

Fix `limiter.mjs`. Every instance already gets a connected Redis client, `redis`, from `server.mjs`. Keep the count in Redis, with a key per API key, and have it expire when its window ends.

Two requests can arrive at the same moment on two instances. If each one reads the count, adds 1, and writes it back, both read the same number, and both get through. `INCR` adds 1 and returns the new count in one step. To set the expiry in the same step, use a short Lua script with `redis.eval`, which Redis runs as one step too.
