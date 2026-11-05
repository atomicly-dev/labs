// A flash sale: 2 products are on the home page, and their product pages get 50 requests at a
// time. The test counts the product queries that reach the database:
//
// 1. A cold cache: one request for product 1 runs one query.
// 2. A warm cache: 50 requests at once run none.
// 3. Both products' keys expire, as they do after 60 seconds, while 50 requests for each arrive
//    at once. Each key should cost at most 2 queries, and every request should get its product.
// 4. The price of product 1 changes, and its key expires. The next request should get the new
//    price, so the cache still refreshes.
//
// The database pool has 10 connections, as the app's does.

import { connectPool, connectRedis, describeError, loadModule, within } from "../lib/helpers.mjs";
import { PRIMARY_URL, REDIS_URL } from "../lib/urls.mjs";

const AT_ONCE = 50;
const MAX_QUERIES_PER_MISS = 2;
const PRODUCTS = {
  1: { id: 1, name: "Trail running shoes", price: "129.00" },
  4: { id: 4, name: "Head torch", price: "34.00" },
};

export default {
  file: "product-cache.mjs",
  lesson: null,

  async run(ctx) {
    const loaded = await loadModule(ctx.file, ["getProduct"]);
    if (loaded.problems) return loaded.problems;
    const { app } = loaded;

    const pool = await connectPool(ctx, PRIMARY_URL, "the primary", { max: 10 });
    const redis = await connectRedis(ctx, REDIS_URL);
    await pool.query("UPDATE products SET price = 129.00 WHERE id = 1");
    ctx.defer(() => pool.query("UPDATE products SET price = 129.00 WHERE id = 1"));
    await redis.del(["product:1", "product:4"]);

    const queries = { 1: 0, 4: 0 };
    const db = {
      query: (text, values, ...rest) => {
        const id = Number(values?.[0]);
        if (id in queries) queries[id]++;
        return pool.query(text, values, ...rest);
      },
    };
    const get = (id) => within(app.getProduct({ db, redis }, id), 10_000);
    const reset = () => {
      queries[1] = 0;
      queries[4] = 0;
    };
    const problems = [];
    const wrong = (outcome, id) => {
      if (outcome.timedOut) return "didn't answer within 10 seconds";
      if (outcome.error) return `failed with ${describeError(outcome.error)}`;
      const p = outcome.value;
      const want = PRODUCTS[id];
      if (p?.id !== want.id || p?.name !== want.name || Number(p?.price) !== Number(want.price)) {
        return `returned ${JSON.stringify(p)}, and it should return product ${id}, ${want.name}`;
      }
      return null;
    };

    // 1. A cold cache.
    const first = await get(1);
    const firstProblem = wrong(first, 1);
    if (firstProblem) return [`The first request for product 1 ${firstProblem}.`];
    if (queries[1] !== 1) return [`The first request for product 1 ran ${queries[1]} product queries, and it should run 1.`];

    // 2. A warm cache.
    reset();
    await Promise.all(Array.from({ length: AT_ONCE }, () => get(1)));
    if (queries[1] !== 0) {
      problems.push(`With product 1 in the cache, ${AT_ONCE} requests ran ${queries[1]} product queries, and they should run none.`);
      return problems;
    }

    // 3. Both keys expire under load.
    await get(4);
    reset();
    await redis.del(["product:1", "product:4"]);
    const started = performance.now();
    const outcomes = await Promise.all(
      Array.from({ length: AT_ONCE * 2 }, (_, i) => {
        const id = i % 2 ? 4 : 1;
        return get(id).then((outcome) => ({ id, outcome, ms: performance.now() - started }));
      }),
    );
    const slowest = Math.max(...outcomes.map((o) => o.ms));
    const failures = new Map();
    for (const { id, outcome } of outcomes) {
      const reason = wrong(outcome, id);
      if (reason) failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    for (const [reason, n] of failures) problems.push(`${n} of ${AT_ONCE * 2} requests ${reason}.`);
    for (const id of [1, 4]) {
      if (queries[id] > MAX_QUERIES_PER_MISS) {
        problems.push(
          `product:${id} expired while ${AT_ONCE} requests for it arrived, and they ran ${queries[id]} product queries of 300 ms each. ` +
            `One miss should cost at most ${MAX_QUERIES_PER_MISS}.`,
        );
      }
    }
    if (queries[1] > MAX_QUERIES_PER_MISS || queries[4] > MAX_QUERIES_PER_MISS) {
      problems.push(
        `The pool has 10 connections, so the queries waited in line, and the slowest page took ${Math.round(slowest)} ms, ` +
          "where one query takes 300 ms.",
      );
    }
    if (problems.length) return problems;

    // 4. The price changes, and the key expires.
    await pool.query("UPDATE products SET price = 119.00 WHERE id = 1");
    await redis.del("product:1");
    reset();
    const after = await get(1);
    if (after.error || after.timedOut || Number(after.value?.price) !== 119) {
      problems.push(
        `Product 1's price changed to 119.00, and its key expired. The next request should get the new price, and got ` +
          `${after.error ? `an error: ${describeError(after.error)}` : after.timedOut ? "no answer" : JSON.stringify(after.value)}.`,
      );
    }
    return problems;
  },
};
