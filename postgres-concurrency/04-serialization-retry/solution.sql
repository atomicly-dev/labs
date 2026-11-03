-- Use coupon :coupon_code on order :order_id, if the coupon has a use left.

-- SERIALIZABLE makes PostgreSQL check that the transactions give the same result as if they ran
-- one at a time. When two orders read the same count and both insert, one of them fails with
-- 40001, and the test runs it again, the way your app's retry loop would. The second time, it
-- sees the other order's redemption.
BEGIN ISOLATION LEVEL SERIALIZABLE;

SELECT c.max_uses - count(r.order_id) AS uses_left
FROM coupons c
LEFT JOIN coupon_redemptions r ON r.coupon_code = c.code
WHERE c.code = :'coupon_code'
GROUP BY c.max_uses \gset

INSERT INTO coupon_redemptions (coupon_code, order_id)
SELECT :'coupon_code', :order_id
WHERE :uses_left > 0;

COMMIT;
