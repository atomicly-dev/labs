// The product page's data, with a cache in front of the database. getProduct reads the product
// from Redis. On a miss, it runs the product query, stores the result in Redis for 60 seconds,
// and returns it. This is cache-aside.
//
// db is a pg pool: call db.query(...). redis is a connected client from the redis package
// (node-redis). The product query takes about 300 ms: it joins the reviews to get the rating.
// pg_sleep stands in for that work.

const TTL_SECONDS = 60;

const PRODUCT_QUERY = `
  SELECT id, name, price::text AS price, stock
  FROM products CROSS JOIN pg_sleep(0.3)
  WHERE id = $1`;

// The loads in progress in this instance, by key. Requests that miss the same key while a load
// runs wait for that load, so a hot key costs one query per miss, not one per request.
const loading = new Map();

export async function getProduct({ db, redis }, productId) {
  const key = `product:${productId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  let load = loading.get(key);
  if (!load) {
    load = (async () => {
      const { rows } = await db.query(PRODUCT_QUERY, [productId]);
      const product = rows[0] ?? null;
      await redis.set(key, JSON.stringify(product), { EX: TTL_SECONDS });
      return product;
    })();
    loading.set(key, load);
    // Remove the load when it ends, failed or not, so the next miss runs a new query.
    load.finally(() => loading.delete(key)).catch(() => {});
  }
  return load;
}
