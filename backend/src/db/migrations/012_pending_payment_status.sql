-- Razorpay's flow has a real gap Stripe's doesn't: a subscription exists
-- (created via API) before the customer has actually authorized a payment
-- method for it — that only happens client-side, after createCheckoutSession
-- already has to write a row. 'pending_payment' represents that in-between
-- state; it should never linger (either verifyCheckout or the
-- subscription.activated/.charged webhook promotes it to 'active' shortly
-- after), but the constraint needs to allow it to exist at all.
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('active', 'past_due', 'canceled', 'pending_payment'));
