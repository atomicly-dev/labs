-- One checkout: sell :quantity of product :product_id on order :order_id.

BEGIN;

-- FOR UPDATE locks the product's row until COMMIT. Another checkout's FOR UPDATE on the same
-- row waits here, then reads the stock this checkout saved.
SELECT stock FROM products WHERE id = :product_id FOR UPDATE \gset

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT :order_id, id, :quantity, price
FROM products
WHERE id = :product_id AND :stock >= :quantity;

UPDATE products
SET stock = :stock - :quantity
WHERE id = :product_id AND :stock >= :quantity;

COMMIT;
