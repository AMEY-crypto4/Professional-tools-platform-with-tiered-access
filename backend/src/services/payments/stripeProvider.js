import Stripe from 'stripe';
import { pool } from '../../db/pool.js';

export const name = 'stripe';

// Constructed (and only throws) the moment something actually tries to
// charge money — every tool still works free with zero Stripe setup.
function getClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    const err = new Error('Stripe is not configured — set STRIPE_SECRET_KEY in the backend .env.');
    err.status = 501;
    throw err;
  }
  return new Stripe(key);
}

export function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

async function findOrCreateCustomer(stripe, user) {
  const { rows } = await pool.query(
    `SELECT provider_customer_id FROM subscriptions WHERE user_id = $1 AND provider = 'stripe' AND provider_customer_id IS NOT NULL LIMIT 1`,
    [user.sub]
  );
  if (rows[0]?.provider_customer_id) return rows[0].provider_customer_id;

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.displayName,
    metadata: { userId: String(user.sub) },
  });
  return customer.id;
}

// Stripe Checkout — a hosted page the frontend redirects to. Only paid tiers
// (a non-null provider_price_id) can be checked out; downgrading happens via
// cancelSubscription instead.
export async function createCheckoutSession(user, toolSlug, tier) {
  const stripe = getClient();

  const { rows } = await pool.query(
    `SELECT provider_price_id FROM tool_tiers WHERE tool_slug = $1 AND tier = $2`,
    [toolSlug, tier]
  );
  const tierConfig = rows[0];
  if (!tierConfig) {
    const err = new Error(`Unknown tier "${tier}" for tool "${toolSlug}"`);
    err.status = 400;
    throw err;
  }
  if (!tierConfig.provider_price_id) {
    const err = new Error(`"${tier}" has no Stripe price configured yet — set provider_price_id in the tool_tiers table.`);
    err.status = 400;
    throw err;
  }

  const customerId = await findOrCreateCustomer(stripe, user);
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:8080';

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price: tierConfig.provider_price_id, quantity: 1 }],
    success_url: `${frontendUrl}/?billing=success&tool=${toolSlug}`,
    cancel_url: `${frontendUrl}/?billing=cancelled&tool=${toolSlug}`,
    client_reference_id: String(user.sub),
    metadata: { userId: String(user.sub), toolSlug, tier },
    subscription_data: { metadata: { userId: String(user.sub), toolSlug, tier } },
  });

  return { provider: 'stripe', url: session.url };
}

// Razorpay's checkout needs a client-side confirm step (verifyCheckout);
// Stripe's redirect + webhook already fully confirms the purchase, so this
// is a no-op that the dispatcher still calls uniformly.
export async function verifyCheckout() {
  return { ok: true };
}

export async function cancelSubscription(user, toolSlug) {
  const stripe = getClient();
  const { rows } = await pool.query(
    `SELECT provider_subscription_id FROM subscriptions WHERE user_id = $1 AND tool_slug = $2 AND provider = 'stripe'`,
    [user.sub, toolSlug]
  );
  if (!rows[0]?.provider_subscription_id) {
    const err = new Error('No active Stripe subscription found for this tool.');
    err.status = 400;
    throw err;
  }
  await stripe.subscriptions.cancel(rows[0].provider_subscription_id);
  await pool.query(
    `UPDATE subscriptions SET tier = 'free', status = 'canceled' WHERE user_id = $1 AND tool_slug = $2`,
    [user.sub, toolSlug]
  );
}

async function upsertSubscription({ userId, toolSlug, tier, status, customerId, subscriptionId, currentPeriodEnd }) {
  await pool.query(
    `INSERT INTO subscriptions (user_id, tool_slug, tier, status, provider, provider_customer_id, provider_subscription_id, current_period_end)
     VALUES ($1,$2,$3,$4,'stripe',$5,$6,$7)
     ON CONFLICT (user_id, tool_slug) DO UPDATE SET
       tier = EXCLUDED.tier,
       status = EXCLUDED.status,
       provider = 'stripe',
       provider_customer_id = COALESCE(EXCLUDED.provider_customer_id, subscriptions.provider_customer_id),
       provider_subscription_id = COALESCE(EXCLUDED.provider_subscription_id, subscriptions.provider_subscription_id),
       current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end)`,
    [userId, toolSlug, tier, status, customerId ?? null, subscriptionId ?? null, currentPeriodEnd ?? null]
  );
}

function mapStripeStatus(stripeStatus) {
  if (['active', 'trialing'].includes(stripeStatus)) return 'active';
  if (['past_due', 'unpaid', 'incomplete'].includes(stripeStatus)) return 'past_due';
  return 'canceled';
}

// Verifies the webhook signature (never trust an unverified request body for
// something that changes billing state). Stripe retries failed webhook
// deliveries, so handleWebhookEvent must be safe to run twice for the same
// event — upsertSubscription is (idempotent upsert).
export function constructWebhookEvent(rawBody, signature) {
  const stripe = getClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    const err = new Error('STRIPE_WEBHOOK_SECRET is not set — cannot verify webhook signatures.');
    err.status = 501;
    throw err;
  }
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

export async function handleWebhookEvent(event) {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { userId, toolSlug, tier } = session.metadata || {};
      if (!userId || !toolSlug || !tier) break; // not one of ours
      await upsertSubscription({
        userId: Number(userId), toolSlug, tier, status: 'active',
        customerId: session.customer, subscriptionId: session.subscription,
      });
      break;
    }
    case 'customer.subscription.updated': {
      const sub = event.data.object;
      const { userId, toolSlug, tier } = sub.metadata || {};
      if (!userId || !toolSlug) break;
      await upsertSubscription({
        userId: Number(userId), toolSlug, tier: tier || 'pro', status: mapStripeStatus(sub.status),
        customerId: sub.customer, subscriptionId: sub.id, currentPeriodEnd: new Date(sub.current_period_end * 1000),
      });
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object;
      const { userId, toolSlug } = sub.metadata || {};
      if (!userId || !toolSlug) break;
      await upsertSubscription({
        userId: Number(userId), toolSlug, tier: 'free', status: 'canceled',
        customerId: sub.customer, subscriptionId: null,
      });
      break;
    }
    default:
      break; // ignore event types we don't act on
  }
}
