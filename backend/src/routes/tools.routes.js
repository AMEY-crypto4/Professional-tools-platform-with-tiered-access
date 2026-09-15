import { Router } from 'express';
import { pool } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { getEffectiveTier, getTierLimits } from '../services/tiers.service.js';

export const toolsRouter = Router();

// Powers the dashboard grid: every tool in the catalog, whether it's live or
// "coming soon", and — for active tools — the caller's current tier and its
// limits, so the frontend can render "3 / 5 invoices used this month" style
// badges without a second round trip per tool.
toolsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    const { rows: tools } = await pool.query(
      `SELECT slug, name, description, is_active FROM tools ORDER BY sort_order`
    );

    const withTiers = await Promise.all(
      tools.map(async (tool) => {
        if (!tool.is_active) return { ...tool, tier: null, limits: null };
        const { tier, isOwnerBypass } = await getEffectiveTier(req.user, tool.slug);
        const limits = await getTierLimits(tool.slug, tier);
        return { ...tool, tier, isOwnerBypass, limits };
      })
    );

    res.json({ tools: withTiers });
  } catch (err) {
    next(err);
  }
});

// All tiers configured for one tool (for the upgrade modal — price, currency,
// what each tier unlocks).
toolsRouter.get('/:slug/tiers', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT tier, monthly_price_cents, currency, limits FROM tool_tiers WHERE tool_slug = $1 ORDER BY monthly_price_cents ASC`,
      [req.params.slug]
    );
    res.json({ tiers: rows });
  } catch (err) {
    next(err);
  }
});
