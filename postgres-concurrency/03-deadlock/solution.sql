-- Move :amount of store credit from account :from_id to account :to_id.

BEGIN;

-- Lock both accounts first, lowest id first. Every transfer takes its locks in the same order,
-- so two transfers can't each hold the lock the other one waits for.
SELECT id FROM accounts WHERE id IN (:from_id, :to_id) ORDER BY id FOR UPDATE;

UPDATE accounts SET balance = balance - :amount WHERE id = :from_id;

UPDATE accounts SET balance = balance + :amount WHERE id = :to_id;

COMMIT;
