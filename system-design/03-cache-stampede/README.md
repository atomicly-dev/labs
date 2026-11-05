# Lab 03: Cache stampede

Goes with module 5 of the System Design course, "Caching".

## The situation

The product page reads each product through a Redis cache, in `product-cache.mjs`. On a miss, it runs the product query, which joins the reviews and takes about 300 ms, and stores the result for 60 seconds. On a normal day, the cache answers almost every request, and the database barely notices the product pages.

Then a flash sale puts 2 products on the home page. Once a minute, the database's CPU jumps, the pool runs out of connections, and checkout slows down with it.

## Try it

```sh
npm run lab -- 03
```

The test sends 50 requests at once for each hot product, then lets both keys expire, the way they do every 60 seconds, while the next 50 arrive. It counts the product queries that reach the database.

You can watch a key's countdown yourself:

```sh
docker compose exec redis redis-cli TTL product:1
```

## What's wrong

When a hot key expires, every request that arrives before the first query finishes misses. Each one runs the same 300 ms query, so one expiry turns into 50 queries for the same row. This is a cache stampede, also known as a thundering herd. The more traffic a key gets, the worse its expiry hits the database.

## What passing looks like

- A cold cache costs 1 query, and a warm cache costs none.
- When a key expires under 50 requests at once, it costs at most 2 queries, and every request still gets its product.
- When a product's price changes and its key expires, the next request gets the new price. The cache still refreshes.

## Hint

Fix `product-cache.mjs`. The requests that miss the same key at the same moment all want the same answer. Let one request load it, and let the others wait for that load, instead of starting their own. That's request coalescing, and a `Map` of the loads in progress is enough inside one instance. Across many instances, a short lock in Redis, with `SET` and the `NX` and `PX` options, does the same job.

Once the load ends, failed or not, the next miss should start a new one.
