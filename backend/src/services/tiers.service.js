import { pool } from '../db/pool.js';

// The generic tier/usage engine every tool plugs into. A tool never
// hardcodes "5 invoices on free tier" in its route handler — it calls
// assertWithinLimit()/hasFeature() with a key that means something to that
// tool, and this file resolves it against whatever tool_tiers.limits says,
// against whichever tier the user is actually on, with the owner bypass
// applied uniformly. This is what lets tool #2 onward add billing behavior
// by inserting rows, not by writing new limit-checking code.

function periodStart(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Returns { tier, status } for a user+tool. A user with no subscriptions row
// yet is implicitly on the free tier — tools don't need to insert one at
// signup. Owners are reported as their tool's highest configured tier so
// hasFeature() checks pass without special-casing every feature flag.
export async function getEffectiveTier(user, toolSlug) {
  if (user.isOwner || user.is_owner) {
    const { rows } = await pool.query(
      `SELECT tier FROM tool_tiers WHERE tool_slug = $1 ORDER BY monthly_price_cents DESC LIMIT 1`,
      [toolSlug]
    );
    return { tier: rows[0]?.tier || 'free', status: 'active', isOwnerBypass: true };
  }

  const { rows } = await pool.query(
    `SELECT tier, status FROM subscriptions WHERE user_id = $1 AND tool_slug = $2`,
    [user.sub ?? user.id, toolSlug]
  );
  if (!rows.length || rows[0].status !== 'active') {
    return { tier: 'free', status: rows[0]?.status || 'active', isOwnerBypass: false };
  }
  return { tier: rows[0].tier, status: rows[0].status, isOwnerBypass: false };
}

export async function getTierLimits(toolSlug, tier) {
  const { rows } = await pool.query(
    `SELECT limits FROM tool_tiers WHERE tool_slug = $1 AND tier = $2`,
    [toolSlug, tier]
  );
  if (!rows.length) throw new Error(`No tier config for ${toolSlug}/${tier}`);
  return rows[0].limits;
}

// Boolean feature flags, e.g. hasFeature(user, 'invoice-generator', 'recurring_invoices').
export async function hasFeature(user, toolSlug, featureKey) {
  const { tier, isOwnerBypass } = await getEffectiveTier(user, toolSlug);
  if (isOwnerBypass) return true;
  const limits = await getTierLimits(toolSlug, tier);
  return !!limits[featureKey];
}

// Throws a 402 if incrementing `metric` this period would exceed the tier's
// `limitKey` cap, otherwise increments the counter and returns the new
// count. A limit value of `null`/undefined in the tier config means
// unlimited. Call this at the point of creation (e.g. right before an INSERT
// commits), not just in the UI, so the cap can't be bypassed by calling the
// API directly.
export async function assertWithinLimitAndIncrement(user, toolSlug, metric, limitKey) {
  const { tier, isOwnerBypass } = await getEffectiveTier(user, toolSlug);
  const limits = await getTierLimits(toolSlug, tier);
  const cap = limits[limitKey];

  const userId = user.sub ?? user.id;
  const period = periodStart();

  if (!isOwnerBypass && cap != null) {
    const { rows } = await pool.query(
      `SELECT count FROM usage_counters WHERE user_id = $1 AND tool_slug = $2 AND metric = $3 AND period_start = $4`,
      [userId, toolSlug, metric, period]
    );
    const current = rows[0]?.count || 0;
    if (current >= cap) {
      const err = new Error(
        `You've reached your ${tier} plan's limit of ${cap} for ${metric.replace(/_/g, ' ')} this month. Upgrade to Pro for unlimited use.`
      );
      err.status = 402;
      err.code = 'TIER_LIMIT_REACHED';
      throw err;
    }
  }

  await pool.query(
    `INSERT INTO usage_counters (user_id, tool_slug, metric, period_start, count)
     VALUES ($1,$2,$3,$4,1)
     ON CONFLICT (user_id, tool_slug, metric, period_start)
     DO UPDATE SET count = usage_counters.count + 1
     RETURNING count`,
    [userId, toolSlug, metric, period]
  );
}

// For caps on a standing count of records rather than a monthly rate — "1
// service on free tier", "3 units", "5 employees", "15 members". Unlike
// assertWithinLimitAndIncrement, this never writes anything: the caller
// already knows the current count (a simple COUNT(*) query, since deleting a
// record should free up the slot again, which a rolling usage_counters row
// would not). Call it right before the INSERT that would create the (cap+1)th
// record.
export async function assertResourceLimit(user, toolSlug, limitKey, currentCount) {
  const { tier, isOwnerBypass } = await getEffectiveTier(user, toolSlug);
  if (isOwnerBypass) return;
  const limits = await getTierLimits(toolSlug, tier);
  const cap = limits[limitKey];
  if (cap != null && currentCount >= cap) {
    const err = new Error(
      `You've reached your ${tier} plan's limit of ${cap} for ${limitKey.replace(/_/g, ' ')}. Upgrade to Pro for more.`
    );
    err.status = 402;
    err.code = 'TIER_LIMIT_REACHED';
    throw err;
  }
}

// For dashboards: how much of this period's allowance has been used, plus
// the cap (null = unlimited).
export async function getUsageSummary(user, toolSlug, metric, limitKey) {
  const { tier, isOwnerBypass } = await getEffectiveTier(user, toolSlug);
  const limits = await getTierLimits(toolSlug, tier);
  const cap = isOwnerBypass ? null : (limits[limitKey] ?? null);
  const userId = user.sub ?? user.id;
  const { rows } = await pool.query(
    `SELECT count FROM usage_counters WHERE user_id = $1 AND tool_slug = $2 AND metric = $3 AND period_start = $4`,
    [userId, toolSlug, metric, periodStart()]
  );
  return { tier, used: rows[0]?.count || 0, cap };
}
