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

export async function getProduct({ db, redis }, productId) {
  const key = `product:${productId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const { rows } = await db.query(PRODUCT_QUERY, [productId]);
  const product = rows[0] ?? null;
  await redis.set(key, JSON.stringify(product), { EX: TTL_SECONDS });
  return product;
}
