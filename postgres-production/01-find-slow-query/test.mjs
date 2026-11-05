// The shop's app runs its usual mix of queries, twice: once on the seed's schema, and once after
// fix.sql. pg_stat_statements measures both runs. The lab passes when the query with the most
// total time uses an index for its filter, and its total time drops to under a third.

import pg from "pg";
import { DATABASE_URL, describeError, dropAddedIndexes, ms, readSqlFile, setUp } from "../lib/harness.mjs";

const TABLES = ["customers", "products", "orders", "order_items"];

// The app's queries, and how many times each page asks for them in one run.
const QUERIES = {
  customer: {
    calls: 300,
    sql: "SELECT id, name, email, city FROM customers WHERE id = $1",
    params: (i) => [1 + ((i * 337) % 50000)],
  },
  login: {
    calls: 100,
    sql: "SELECT id, name FROM customers WHERE email = $1",
    params: (i) => [`customer${1 + ((i * 541) % 50000)}@example.com`],
  },
  order: {
    calls: 200,
    sql: "SELECT id, customer_id, status, ordered_on, shipped_on FROM orders WHERE id = $1",
    params: (i) => [1 + ((i * 1009) % 300000)],
  },
  orderItems: {
    calls: 200,
    sql:
      "SELECT p.name, oi.quantity, oi.unit_price FROM order_items AS oi " +
      "JOIN products AS p ON p.id = oi.product_id WHERE oi.order_id = $1",
    params: (i) => [1 + ((i * 2003) % 300000)],
  },
  product: {
    calls: 150,
    sql: "SELECT id, name, category, price, stock FROM products WHERE id = $1",
    params: (i) => [1 + ((i * 13) % 500)],
  },
  // The "My orders" page. Each customer has 6 orders, and nothing indexes orders.customer_id.
  orderHistory: {
    calls: 120,
    sql: "SELECT id, status, ordered_on FROM orders WHERE customer_id = $1 ORDER BY ordered_on DESC LIMIT 20",
    // pg_stat_statements shows each constant as a parameter.
    stat: "SELECT id, status, ordered_on FROM orders WHERE customer_id = $1 ORDER BY ordered_on DESC LIMIT $2",
    params: (i) => [1 + ((i * 4217) % 50000)],
  },
  // The sales report. It's the slowest query per call, but it runs rarely.
  salesReport: {
    calls: 2,
    sql:
      "SELECT p.category, sum(oi.quantity * oi.unit_price) AS revenue FROM orders AS o " +
      "JOIN order_items AS oi ON oi.order_id = o.id JOIN products AS p ON p.id = oi.product_id " +
      "WHERE o.ordered_on >= $1 GROUP BY p.category ORDER BY revenue DESC",
    params: () => ["2025-11-01"],
  },
};
const SLOW = QUERIES.orderHistory;

export default {
  file: "fix.sql",
  lesson: "https://atomicly.dev/lessons/psql-slow-query-workflow",

  async run({ file, db, connect, track }) {
    const read = await readSqlFile(file);
    if (read.problems) return read.problems;

    await setUp(db, () => dropAddedIndexes(db, TABLES));

    const before = await measure(db, track);

    // fix.sql runs in a session of its own, like a migration.
    const session = await connect("fix.sql");
    for (const statement of read.statements) {
      try {
        await session.query(statement.sql);
      } catch (error) {
        return [`fix.sql failed at line ${statement.line} (${statement.text}): ${describeError(error)}`];
      }
    }

    const after = await measure(db, track);
    const plan = await planOf(db, SLOW.sql, SLOW.params(1));

    const problems = [];
    const slowBefore = before.get(SLOW.stat);
    const slowAfter = after.get(SLOW.stat);
    const usesIndex = plan.some((node) => /customer_id/.test(node["Index Cond"] ?? ""));
    if (!usesIndex || slowAfter.steady * 3 > slowBefore.steady) {
      const sum = (stats) => [...stats.values()].reduce((total, stat) => total + stat.total, 0);
      problems.push(
        `The app's queries spent ${ms(sum(before))} in the database before fix.sql, and ${ms(sum(after))} after it.`,
        "The query with the most total time isn't any faster.",
        "Find it in pg_stat_statements: run `npm run db`, then the query in the README's hint.",
      );
    }
    return problems;
  },
};

// Empties pg_stat_statements, runs the app's queries from 4 connections, and returns each query's
// calls and times in ms, by the query's text in pg_stat_statements.
async function measure(db, track) {
  await db.query("SELECT pg_stat_statements_reset()");
  const pool = track(new pg.Pool({ connectionString: DATABASE_URL, max: 4, application_name: "lab: app" }));
  // The pages interleave, the way they would in production, in the same order on every run.
  const jobs = Object.values(QUERIES).flatMap((query) =>
    Array.from({ length: query.calls }, (_, i) => ({ query, i, key: (i * 7919 + query.calls) % 997 })),
  );
  jobs.sort((a, b) => a.key - b.key);
  const queue = jobs.values();
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (const { query, i } of queue) await pool.query(query.sql, query.params(i));
    }),
  );
  await pool.end();

  const { rows } = await db.query(
    "SELECT query, calls, total_exec_time, max_exec_time FROM pg_stat_statements WHERE query = ANY ($1)",
    [Object.values(QUERIES).map((query) => query.stat ?? query.sql)],
  );
  // `steady` leaves out the slowest call, so one pause of a busy machine can't decide the lab.
  return new Map(
    rows.map((row) => [
      row.query,
      { calls: Number(row.calls), total: row.total_exec_time, steady: row.total_exec_time - row.max_exec_time },
    ]),
  );
}

// The query's plan, as a flat list of plan nodes.
async function planOf(db, sql, params) {
  const { rows } = await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  const nodes = [];
  const walk = (node) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(rows[0]["QUERY PLAN"][0].Plan);
  return nodes;
}
