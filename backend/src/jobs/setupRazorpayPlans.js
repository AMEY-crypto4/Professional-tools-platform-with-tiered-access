// Run once after you've set RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET in .env:
//   npm run setup:razorpay-plans
//
// Creates a Razorpay Plan for every Pro tier that doesn't have one yet
// (provider_price_id IS NULL) and writes the returned plan id back to
// tool_tiers. Safe to re-run — it only touches rows that are still NULL, so
// it will never create a duplicate plan for a tool you've already set up.
import 'dotenv/config';
import Razorpay from 'razorpay';
import { pool } from '../db/pool.js';

async function run() {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    console.error('[setup-razorpay-plans] Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env first.');
    process.exit(1);
  }
  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  const { rows: pending } = await pool.query(
    `SELECT tt.id, tt.tool_slug, tt.monthly_price_cents, tt.currency, t.name
     FROM tool_tiers tt JOIN tools t ON t.slug = tt.tool_slug
     WHERE tt.tier = 'pro' AND tt.provider_price_id IS NULL`
  );

  if (!pending.length) {
    console.log('[setup-razorpay-plans] Every Pro tier already has a plan configured — nothing to do.');
    await pool.end();
    return;
  }

  for (const row of pending) {
    const plan = await razorpay.plans.create({
      period: 'monthly',
      interval: 1,
      item: {
        name: `${row.name} — Pro`,
        amount: row.monthly_price_cents,       // smallest currency unit (paise for INR)
        currency: row.currency.toUpperCase(),
      },
      notes: { toolSlug: row.tool_slug },
    });
    await pool.query(`UPDATE tool_tiers SET provider_price_id = $1 WHERE id = $2`, [plan.id, row.id]);
    console.log(`[setup-razorpay-plans] ${row.tool_slug}: created plan ${plan.id} (${row.currency.toUpperCase()} ${(row.monthly_price_cents / 100).toFixed(2)}/mo)`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error('[setup-razorpay-plans] failed:', err);
  process.exit(1);
});
