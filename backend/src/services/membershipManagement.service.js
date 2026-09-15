import { pool } from '../db/pool.js';
import { assertResourceLimit } from './tiers.service.js';

const TOOL_SLUG = 'membership-management';

function statusFor(periodEnd) {
  if (!periodEnd) return 'no_payment';
  const end = new Date(periodEnd);
  const today = new Date(new Date().toISOString().slice(0, 10));
  const daysLeft = Math.round((end - today) / 86400000);
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= 7) return 'expiring_soon';
  return 'active';
}

export async function listMembers(userId) {
  const { rows } = await pool.query(
    `SELECT m.*, MAX(p.period_end) AS current_period_end
     FROM mm_members m LEFT JOIN mm_payments p ON p.member_id = m.id
     WHERE m.user_id = $1 AND m.active = TRUE
     GROUP BY m.id ORDER BY m.name ASC`,
    [userId]
  );
  return rows.map((m) => ({ ...m, membership_status: statusFor(m.current_period_end) }));
}

export async function getMember(userId, memberId) {
  const { rows } = await pool.query(`SELECT * FROM mm_members WHERE user_id = $1 AND id = $2`, [userId, memberId]);
  return rows[0] ?? null;
}

export async function createMember(user, { name, email, phone, membershipType }) {
  if (!name) { const err = new Error('name is required'); err.status = 400; throw err; }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM mm_members WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_members', countRows[0].n);

  const { rows } = await pool.query(
    `INSERT INTO mm_members (user_id, name, email, phone, membership_type) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, name, email || null, phone || null, membershipType || 'standard']
  );
  return rows[0];
}

export async function deactivateMember(userId, memberId) {
  const { rowCount } = await pool.query(`UPDATE mm_members SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, memberId]);
  return rowCount > 0;
}

// Recording a payment is not tier-limited — the member-count cap already
// bounds how much a free-tier account can do; charging an existing member
// for renewal shouldn't stop working mid-cycle.
export async function recordPayment(userId, memberId, { amountCents, periodStart, periodEnd }) {
  const member = await getMember(userId, memberId);
  if (!member) { const err = new Error('Member not found'); err.status = 404; throw err; }
  if (!(Number(amountCents) > 0) || !periodStart || !periodEnd) {
    const err = new Error('amountCents, periodStart, and periodEnd are required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO mm_payments (member_id, amount_cents, period_start, period_end) VALUES ($1,$2,$3,$4) RETURNING *`,
    [memberId, Math.round(Number(amountCents)), periodStart, periodEnd]
  );
  return rows[0];
}

export async function listPayments(userId, memberId) {
  const member = await getMember(userId, memberId);
  if (!member) { const err = new Error('Member not found'); err.status = 404; throw err; }
  const { rows } = await pool.query(`SELECT * FROM mm_payments WHERE member_id = $1 ORDER BY period_start DESC`, [memberId]);
  return rows;
}
