-- Adds Razorpay as a second payment provider (Stripe requires an invite for
-- new India-based merchants — see docs/ROADMAP.md). Renames the
-- Stripe-specific columns to provider-neutral ones so either provider's IDs
-- can live in them, and records which provider each subscription/price
-- actually belongs to.
--
-- Existing Pro prices were seeded in USD against Stripe, which no India
-- account can use yet — this also reseeds them in INR, since Razorpay's
-- Indian payment methods (UPI, cards, netbanking) settle in INR. These are
-- placeholder price points; adjust them in the tool_tiers table once you
-- have real pricing decided.

ALTER TABLE subscriptions RENAME COLUMN stripe_customer_id TO provider_customer_id;
ALTER TABLE subscriptions RENAME COLUMN stripe_subscription_id TO provider_subscription_id;
ALTER TABLE subscriptions ADD COLUMN provider TEXT CHECK (provider IN ('stripe', 'razorpay'));

ALTER TABLE tool_tiers RENAME COLUMN stripe_price_id TO provider_price_id;
COMMENT ON COLUMN tool_tiers.provider_price_id IS
  'Whatever the currently active PAYMENT_PROVIDER calls its price/plan id (Stripe Price ID or Razorpay Plan ID). Switching providers means re-entering these — a Stripe price id is meaningless to Razorpay and vice versa.';

UPDATE tool_tiers SET currency = 'inr', monthly_price_cents = CASE tool_slug
  WHEN 'invoice-generator'     THEN 29900
  WHEN 'appointment-booking'   THEN 24900
  WHEN 'expense-tracker'       THEN 19900
  WHEN 'membership-management' THEN 19900
  WHEN 'leave-management'      THEN 19900
  WHEN 'inventory-management'  THEN 24900
  WHEN 'staff-attendance'      THEN 24900
  WHEN 'property-management'   THEN 29900
  WHEN 'queue-management'      THEN 19900
  ELSE monthly_price_cents
END
WHERE tier = 'pro';
