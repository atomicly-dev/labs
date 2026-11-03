-- The shop's database got slow. A teammate looked at the queries, saw that the sales report takes
-- the longest each time it runs, and added an index for its date filter.
--
-- Find the query that costs the database the most time in total, with pg_stat_statements, and
-- change this file to speed it up. The test runs this file, then runs the app's queries again.
--
-- Try your change in psql (npm run db) first, with EXPLAIN. The test drops the indexes you add,
-- in psql or here, before each run.

CREATE INDEX orders_ordered_on_idx ON orders (ordered_on);
