# Lab 01: Find the slow query

Lesson: [Finding and fixing slow queries](https://atomicly.dev/lessons/psql-slow-query-workflow)

## The situation

The shop's database got slow, and its CPU is busy all day. The app runs a handful of queries: the customer and order pages, the login, the product page, a customer's "My orders" page, and a sales report.

A teammate timed a few queries by hand. The sales report took the longest each time, so they added an index for its date filter. That's the `fix.sql` you start with. The database is just as busy as before.

## What's wrong

The teammate fixed the query that's slowest per call. The query that costs the database the most is the one with the most total time: its time per call, times how often the app runs it. A fast query that runs thousands of times can cost more than a slow one that runs twice.

`pg_stat_statements` keeps both numbers for every query the server runs: `calls`, `total_exec_time`, and `mean_exec_time`.

## What passing looks like

```sh
npm run lab -- 01
```

The test runs the app's queries from 4 connections, about 1,000 queries in all, and measures them with `pg_stat_statements`. Then it runs `fix.sql` and runs the same queries again.

The lab passes when the query with the most total time uses an index for its filter, checked with `EXPLAIN`, and its total time drops to under a third of what it was.

After each run, `pg_stat_statements` holds the numbers from the last round of queries, so you can look at them in psql.

## Hint

Run the lab once, then open psql with `npm run db` and sort the queries by total time:

```sql
SELECT calls,
       round(total_exec_time) AS total_ms,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 5;
```

Then sort them by `mean_exec_time` and see which query comes first. Take the top query by total time, put a real value in place of each parameter, such as `$1` and `$2`, and run it with `EXPLAIN ANALYZE`. A `Seq Scan` that reads the whole table to return a few rows needs an index on the column it filters by. Try your index in psql, check the plan again, then put it in `fix.sql`.
