import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  createCheckoutSession,
  verifyCheckout,
  cancelSubscription,
  isBillingConfigured,
  activeProviderName,
  stripeProvider,
  razorpayProvider,
} from '../services/billing.service.js';

export const billingRouter = Router();

billingRouter.get('/status', (req, res) => {
  res.json({ configured: isBillingConfigured(), provider: activeProviderName() });
});

billingRouter.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const { toolSlug, tier } = req.body || {};
    if (!toolSlug || !tier) {
      return res.status(400).json({ error: 'toolSlug and tier are required' });
    }
    const result = await createCheckoutSession(req.user, toolSlug, tier);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Called by the frontend right after Razorpay's Checkout widget returns —
// see razorpayProvider.verifyCheckout for why this step exists and why it's
// safe (verification is against the subscription id WE stored, not the
// client-supplied one). No-op for Stripe.
billingRouter.post('/verify', requireAuth, async (req, res, next) => {
  try {
    const { toolSlug, razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body || {};
    if (!toolSlug) return res.status(400).json({ error: 'toolSlug is required' });
    const result = await verifyCheckout(
      req.user, toolSlug,
      { razorpay_payment_id, razorpay_subscription_id },
      razorpay_signature
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

billingRouter.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const { toolSlug } = req.body || {};
    if (!toolSlug) return res.status(400).json({ error: 'toolSlug is required' });
    await cancelSubscription(req.user, toolSlug);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Both mounted separately in app.js with express.raw() BEFORE the global
// JSON body parser — both providers sign the exact raw request bytes, and
// express.json() would have already consumed/parsed the stream by the time
// a normally-mounted route saw it. See the app.js comment for why route
// order matters here.
export async function stripeWebhookHandler(req, res) {
  let event;
  try {
    event = stripeProvider.constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    console.error('[billing] Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }
  try {
    await stripeProvider.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] Stripe webhook handling failed:', err);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
}

export async function razorpayWebhookHandler(req, res) {
  let event;
  try {
    event = razorpayProvider.constructWebhookEvent(req.body, req.headers['x-razorpay-signature']);
  } catch (err) {
    console.error('[billing] Razorpay webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
  }
  try {
    await razorpayProvider.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] Razorpay webhook handling failed:', err);
    res.status(500).json({ error: 'Webhook handling failed' });
  }
}
