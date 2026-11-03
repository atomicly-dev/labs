-- pg_stat_statements, sorted by total_exec_time, puts the "My orders" query first:
--
--   SELECT id, status, ordered_on FROM orders WHERE customer_id = $1
--   ORDER BY ordered_on DESC LIMIT 20
--
-- Each call takes a few milliseconds, and the app runs it 120 times per round. The sales report
-- takes longer per call (its mean_exec_time is the highest), but it runs twice.
--
-- EXPLAIN shows a Seq Scan on orders: to find one customer's 6 orders, the query reads all
-- 300,000. An index on customer_id finds them directly. With ordered_on as its second column,
-- the index also returns them newest first, so the query doesn't sort them.

CREATE INDEX orders_customer_id_ordered_on_idx ON orders (customer_id, ordered_on DESC);
