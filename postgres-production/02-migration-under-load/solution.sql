-- Release 42's migration, safe to run while the shop takes orders.

-- 1. The check constraint.
--
-- ADD CONSTRAINT needs an ACCESS EXCLUSIVE lock on orders. While the support session's
-- transaction is open, the ALTER waits for it, and every query on orders waits behind the ALTER.
-- lock_timeout makes the ALTER give up after 100 ms, and the test runs it again until it gets the
-- lock. So the app's queries wait 100 ms at most.
SET lock_timeout = '100ms';

-- NOT VALID adds the constraint without reading the 300,000 rows already there, so it holds the
-- ACCESS EXCLUSIVE lock for a moment. New and updated rows must pass the check from now on.
ALTER TABLE orders
  ADD CONSTRAINT orders_shipped_after_ordered CHECK (shipped_on >= ordered_on) NOT VALID;

-- VALIDATE reads the existing rows with a SHARE UPDATE EXCLUSIVE lock, which lets the app read
-- and write orders the whole time.
ALTER TABLE orders VALIDATE CONSTRAINT orders_shipped_after_ordered;

-- 2. The index.
--
-- A plain CREATE INDEX holds a SHARE lock, which blocks every write to orders until the build
-- ends. CONCURRENTLY builds the index without blocking writes. It waits for the transactions
-- that are open on orders to end, the support session's too, but nothing waits behind it.
-- lock_timeout would cut that wait short and leave an INVALID index behind, so turn it off first.
RESET lock_timeout;

CREATE INDEX CONCURRENTLY orders_shipped_on_idx ON orders (shipped_on);
