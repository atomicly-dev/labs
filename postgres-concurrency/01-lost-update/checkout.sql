-- One checkout: sell :quantity of product :product_id on order :order_id.
--
-- Try it in psql (npm run db):
--   \set product_id 3
--   \set quantity 1
--   \set order_id 11
-- then paste the SQL below.

BEGIN;

-- Read the stock, the way the app does before it shows "In stock".
SELECT stock FROM products WHERE id = :product_id \gset

-- If there's enough stock, add the product to the order.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT :order_id, id, :quantity, price
FROM products
WHERE id = :product_id AND :stock >= :quantity;

-- Then save the new stock.
UPDATE products
SET stock = :stock - :quantity
WHERE id = :product_id AND :stock >= :quantity;

COMMIT;
