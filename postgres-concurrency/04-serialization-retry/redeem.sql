-- Use coupon :coupon_code on order :order_id, if the coupon has a use left.
--
-- Try it in psql (npm run db):
--   \set coupon_code 'LAUNCH10'
--   \set order_id 1
-- then paste the SQL below.

BEGIN ISOLATION LEVEL REPEATABLE READ;

-- How many uses does the coupon have left?
SELECT c.max_uses - count(r.order_id) AS uses_left
FROM coupons c
LEFT JOIN coupon_redemptions r ON r.coupon_code = c.code
WHERE c.code = :'coupon_code'
GROUP BY c.max_uses \gset

-- Use it if there's a use left.
INSERT INTO coupon_redemptions (coupon_code, order_id)
SELECT :'coupon_code', :order_id
WHERE :uses_left > 0;

COMMIT;
