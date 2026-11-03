-- Release 42's migration. It runs on the live database while the shop takes orders.
--
-- 1. The "Shipped this week" page filters orders on shipped_on, so it needs an index.
-- 2. An old import job saved some orders with a shipped_on before their ordered_on. The data is
--    fixed now, and a check constraint stops it from happening again.
--
-- The test runs these statements one after another, in one session. Each statement is its own
-- transaction, unless you put statements between BEGIN and COMMIT. When a statement fails with
-- 55P03 lock_not_available, the test pauses for 200 ms and runs it again (or its whole
-- BEGIN ... COMMIT block), up to 100 times. Any other error stops the migration.

ALTER TABLE orders
  ADD CONSTRAINT orders_shipped_after_ordered CHECK (shipped_on >= ordered_on);

CREATE INDEX orders_shipped_on_idx ON orders (shipped_on);
