-- Move :amount of store credit from account :from_id to account :to_id.
--
-- Try it in psql (npm run db):
--   \set from_id 1
--   \set to_id 2
--   \set amount 10
-- then paste the SQL below.

BEGIN;

UPDATE accounts SET balance = balance - :amount WHERE id = :from_id;

UPDATE accounts SET balance = balance + :amount WHERE id = :to_id;

COMMIT;
