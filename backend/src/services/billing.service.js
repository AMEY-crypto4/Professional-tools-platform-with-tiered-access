import * as stripeProvider from './payments/stripeProvider.js';
import * as razorpayProvider from './payments/razorpayProvider.js';

// The dispatcher every route calls into — nothing outside this file (or the
// two provider modules) ever imports 'stripe' or 'razorpay' directly. That's
// what makes swapping providers, or running with neither configured, a
// change confined to this layer.
//
// PAYMENT_PROVIDER forces a choice when both happen to be configured at
// once. Otherwise Razorpay wins the auto-detect — it's the provider most of
// this platform's early (India-based) users can actually get approved for,
// unlike Stripe's invite-only India access (see docs/ROADMAP.md).
function getActiveProvider() {
  const forced = process.env.PAYMENT_PROVIDER?.toLowerCase();
  if (forced === 'stripe') return stripeProvider;
  if (forced === 'razorpay') return razorpayProvider;
  if (razorpayProvider.isConfigured()) return razorpayProvider;
  if (stripeProvider.isConfigured()) return stripeProvider;
  return null;
}

function requireProvider() {
  const provider = getActiveProvider();
  if (!provider) {
    const err = new Error('Billing is not configured yet — set RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET (or STRIPE_SECRET_KEY) in the backend .env to enable upgrades.');
    err.status = 501;
    throw err;
  }
  return provider;
}

export function isBillingConfigured() {
  return !!getActiveProvider();
}

export function activeProviderName() {
  return getActiveProvider()?.name ?? null;
}

export async function createCheckoutSession(user, toolSlug, tier) {
  return requireProvider().createCheckoutSession(user, toolSlug, tier);
}

// Only meaningful for providers whose checkout needs a client-side confirm
// step (Razorpay); Stripe's implementation is a no-op since its redirect +
// webhook flow already fully confirms the purchase server-side.
export async function verifyCheckout(user, toolSlug, fields, signature) {
  return requireProvider().verifyCheckout(user, toolSlug, fields, signature);
}

export async function cancelSubscription(user, toolSlug) {
  return requireProvider().cancelSubscription(user, toolSlug);
}

// Webhooks are provider-specific by URL (see app.js) so each one's handler
// calls its own provider module directly rather than through this
// dispatcher — a webhook always tells you unambiguously which provider sent
// it, there's nothing to detect.
export { stripeProvider, razorpayProvider };
