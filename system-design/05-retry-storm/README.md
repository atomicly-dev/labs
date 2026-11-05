# Lab 05: Retry storm

Lesson: [Call an API with fetch](https://atomicly.dev/lessons/node-fetch-api-calls) (section 4, *Retry within a budget*). Also [Retry storms: stop multiplying an outage](https://atomicly.dev/lessons/sd-retry-storms) and [Circuit breaker: stop calling a failing dependency](https://atomicly.dev/lessons/sd-circuit-breaker).

## The situation

Before the checkout page offers "Buy now", the storefront API asks the orders service whether the product can ship, and the orders service asks the inventory service for the stock:

```
storefront API  ->  orders service  ->  inventory service
(2 s a try)         (250 ms a try)
```

Both services call their dependency through the same helper, `retry.mjs`, which tries each call up to 3 times. Each team added it after a flaky week, and it fixed their blips.

One evening, the inventory service's database gets slow, and the inventory service answers in 3 seconds instead of 20 ms. Its dashboard shows 9 times its usual traffic, which keeps it slow long after its database recovers. The on-call engineer can't find where the extra traffic comes from: checkout traffic is normal.

## Try it

```sh
npm run lab -- 05
```

[Toxiproxy](https://github.com/Shopify/toxiproxy) sits between the orders service and the inventory service, and the test tells it to delay every answer by 3 seconds. The inventory service counts every call it gets. You can do the same by hand, and look at the count:

```sh
curl -X POST localhost:8475/proxies/inventory/toxics -d '{"name":"slow","type":"latency","attributes":{"latency":3000}}'
curl localhost:8091/stats
curl -X DELETE localhost:8475/proxies/inventory/toxics/slow
```

## What's wrong

Retries multiply across layers. The orders service tries 3 times, and each of the storefront's 3 tries starts all 3 of them again: 9 calls per checkout. With 5 layers, it would be 243. The retries also go out at once, with no pause, so they arrive while the service is at its slowest.

A retry helps when a failure is rare and short. When the dependency is down or overloaded, every retry is more load on the part that's already failing.

## What passing looks like

The test runs both services with your `retry.mjs`, one copy each, as two processes would:

- On a normal day, 10 checkouts make exactly 10 inventory calls.
- When the inventory service answers 503 once, the checkout still succeeds.
- During the outage, 30 checkouts, 10 at a time, all fail, and make at most 45 inventory calls in all.
- Within 10 seconds after the inventory service recovers, checkouts succeed again.

## Hint

Fix `retry.mjs`. Keep the retries for blips, and stop them from multiplying an outage. Two well-known tools do that:

- **A retry budget:** each retrier allows retries only up to a small share of its calls, such as 10%, so retries can never multiply the load.
- **A circuit breaker:** after several failures in a row, stop calling for a moment and fail at once. Then let one trial call through to see if the dependency is back.

Add backoff with jitter too: wait before each retry, longer each time, with a random part, so the retries don't arrive all at once.
