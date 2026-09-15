import crypto from 'node:crypto';
import Razorpay from 'razorpay';
import { pool } from '../../db/pool.js';

export const name = 'razorpay';

// Razorpay Subscriptions don't have a real "bill until cancelled" plan the
// way Stripe does — you commit to a total number of billing cycles up
// front. 120 monthly cycles = 10 years, which is "effectively indefinite"
// for this platform; the subscription can still be cancelled at any time
// before then via cancelSubscription().
const TOTAL_BILLING_CYCLES = 120;

function getClient() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    const err = new Error('Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in the backend .env.');
    err.status = 501;
    throw err;
  }
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

export function isConfigured() {
  return !!process.env.RAZORPAY_KEY_ID && !!process.env.RAZORPAY_KEY_SECRET;
}

// The SDK throws Razorpay's raw API error shape ({ statusCode, error: {
// description, code } }), which errorHandler.js doesn't know how to read —
// it would otherwise fall through as an opaque 500. Re-shaping it here means
// a misconfigured key during setup surfaces as "Authentication failed"
// instead of "Internal server error", right when that distinction matters
// most (the first time you plug in real keys).
async function callRazorpay(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.statusCode && err?.error) {
      const wrapped = new Error(`Razorpay error: ${err.error.description || err.error.code}`);
      wrapped.status = err.statusCode >= 400 && err.statusCode < 500 ? 502 : 500;
      throw wrapped;
    }
    throw err;
  }
}

function timingSafeEqualHex(expectedHex, actualHex) {
  if (typeof actualHex !== 'string' || actualHex.length !== expectedHex.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
}

// Razorpay's checkout-completion signature: hex HMAC-SHA256 of
// "{payment_id}|{subscription_id}" using your key_secret. Implemented
// directly against Node's crypto rather than the SDK's internal
// dist/utils/razorpay-utils path, which isn't a documented public export of
// the npm package and isn't safe to depend on across SDK versions — the
// algorithm itself is simple, stable, and documented, so there's nothing
// gained by reaching into SDK internals for it.
function computeCheckoutSignature(paymentId, subscriptionId, keySecret) {
  return crypto.createHmac('sha256', keySecret).update(`${paymentId}|${subscriptionId}`).digest('hex');
}

async function getOwnSubscriptionRow(userId, toolSlug) {
  const { rows } = await pool.query(
    `SELECT * FROM subscriptions WHERE user_id = $1 AND tool_slug = $2 AND provider = 'razorpay'`,
    [userId, toolSlug]
  );
  return rows[0] ?? null;
}

// Creates a Razorpay Subscription and records it as 'pending_payment' —
// the customer hasn't actually authorized a payment method yet at this
// point. That happens client-side via Checkout.js against this
// subscription_id; verifyCheckout() (called right after) or the webhook
// (the eventual source of truth) is what flips it to 'active'.
export async function createCheckoutSession(user, toolSlug, tier) {
  const razorpay = getClient();

  const { rows } = await pool.query(
    `SELECT provider_price_id, monthly_price_cents, currency FROM tool_tiers WHERE tool_slug = $1 AND tier = $2`,
    [toolSlug, tier]
  );
  const tierConfig = rows[0];
  if (!tierConfig) {
    const err = new Error(`Unknown tier "${tier}" for tool "${toolSlug}"`);
    err.status = 400;
    throw err;
  }
  if (!tierConfig.provider_price_id) {
    const err = new Error(`"${tier}" has no Razorpay plan configured yet — run the setup script or set provider_price_id in the tool_tiers table.`);
    err.status = 400;
    throw err;
  }

  const subscription = await callRazorpay(() => razorpay.subscriptions.create({
    plan_id: tierConfig.provider_price_id,
    customer_notify: 1,
    total_count: TOTAL_BILLING_CYCLES,
    notes: { userId: String(user.sub), toolSlug, tier },
  }));

  await pool.query(
    `INSERT INTO subscriptions (user_id, tool_slug, tier, status, provider, provider_subscription_id)
     VALUES ($1,$2,$3,'pending_payment','razorpay',$4)
     ON CONFLICT (user_id, tool_slug) DO UPDATE SET
       tier = EXCLUDED.tier, status = 'pending_payment', provider = 'razorpay',
       provider_subscription_id = EXCLUDED.provider_subscription_id`,
    [user.sub, toolSlug, tier, subscription.id]
  );

  return {
    provider: 'razorpay',
    subscriptionId: subscription.id,
    keyId: process.env.RAZORPAY_KEY_ID,
    name: 'A&A Creations',
    description: `${toolSlug} — ${tier} plan`,
    prefillEmail: user.email,
    prefillName: user.displayName,
  };
}

// Called by the frontend right after Razorpay Checkout's handler fires,
// with the three fields it returns. Verification is computed against the
// subscription_id WE stored at createCheckoutSession time, never the one
// the client sends — a forged request can't just supply someone else's
// subscription_id and a matching signature for it without also knowing the
// key_secret, but there's no reason to trust client-supplied IDs at all
// when we already know which subscription this user/tool pair should be on.
export async function verifyCheckout(user, toolSlug, { razorpay_payment_id, razorpay_subscription_id }, signature) {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    const err = new Error('Razorpay is not configured.');
    err.status = 501;
    throw err;
  }
  const existing = await getOwnSubscriptionRow(user.sub, toolSlug);
  if (!existing?.provider_subscription_id) {
    const err = new Error('No pending Razorpay checkout found for this tool — start the upgrade again.');
    err.status = 400;
    throw err;
  }
  if (existing.provider_subscription_id !== razorpay_subscription_id) {
    const err = new Error('Subscription mismatch — start the upgrade again.');
    err.status = 400;
    throw err;
  }

  const expected = computeCheckoutSignature(razorpay_payment_id, existing.provider_subscription_id, keySecret);
  if (!timingSafeEqualHex(expected, signature)) {
    const err = new Error('Payment signature verification failed.');
    err.status = 400;
    throw err;
  }

  await pool.query(
    `UPDATE subscriptions SET status = 'active' WHERE user_id = $1 AND tool_slug = $2`,
    [user.sub, toolSlug]
  );
  return { ok: true };
}

export async function cancelSubscription(user, toolSlug) {
  const razorpay = getClient();
  const existing = await getOwnSubscriptionRow(user.sub, toolSlug);
  if (!existing?.provider_subscription_id) {
    const err = new Error('No active Razorpay subscription found for this tool.');
    err.status = 400;
    throw err;
  }
  await callRazorpay(() => razorpay.subscriptions.cancel(existing.provider_subscription_id));
  await pool.query(
    `UPDATE subscriptions SET tier = 'free', status = 'canceled' WHERE user_id = $1 AND tool_slug = $2`,
    [user.sub, toolSlug]
  );
}

// Webhook signature: hex HMAC-SHA256 of the RAW request body using the
// webhook secret you set in the Razorpay Dashboard (separate from your API
// key/secret) — must run on the untouched raw bytes, before any JSON.parse.
export function constructWebhookEvent(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('RAZORPAY_WEBHOOK_SECRET is not set — cannot verify webhook signatures.');
    err.status = 501;
    throw err;
  }
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (!timingSafeEqualHex(expected, signature)) {
    const err = new Error('Webhook signature verification failed.');
    err.status = 400;
    throw err;
  }
  return JSON.parse(rawBody.toString('utf8'));
}

export async function handleWebhookEvent(event) {
  const entity = event.payload?.subscription?.entity;
  if (!entity) return; // not a subscription event we act on
  const { userId, toolSlug, tier } = entity.notes || {};
  if (!userId || !toolSlug) return; // not one of ours

  switch (event.event) {
    case 'subscription.activated':
    case 'subscription.charged': {
      await pool.query(
        `UPDATE subscriptions SET tier = $1, status = 'active', provider_subscription_id = $2, current_period_end = $3
         WHERE user_id = $4 AND tool_slug = $5`,
        [tier || 'pro', entity.id, new Date(entity.current_end * 1000), Number(userId), toolSlug]
      );
      break;
    }
    case 'subscription.completed':
    case 'subscription.cancelled': {
      await pool.query(
        `UPDATE subscriptions SET tier = 'free', status = 'canceled' WHERE user_id = $1 AND tool_slug = $2`,
        [Number(userId), toolSlug]
      );
      break;
    }
    case 'subscription.halted':
    case 'subscription.pending': {
      await pool.query(
        `UPDATE subscriptions SET status = 'past_due' WHERE user_id = $1 AND tool_slug = $2`,
        [Number(userId), toolSlug]
      );
      break;
    }
    default:
      break; // ignore event types we don't act on
  }
}
