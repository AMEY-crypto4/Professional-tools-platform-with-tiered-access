import { pool } from '../db/pool.js';
import { assertWithinLimitAndIncrement, hasFeature } from './tiers.service.js';

const TOOL_SLUG = 'expense-tracker';

export async function listExpenses(userId, { month } = {}) {
  const params = [userId];
  let where = 'user_id = $1';
  if (month) { params.push(`${month}-01`); where += ` AND date_trunc('month', expense_date) = $${params.length}::date`; }
  const { rows } = await pool.query(`SELECT * FROM et_expenses WHERE ${where} ORDER BY expense_date DESC, id DESC`, params);
  return rows;
}

export async function createExpense(user, { category, amountCents, expenseDate, note }) {
  if (!category || !(Number(amountCents) > 0)) {
    const err = new Error('category and a positive amountCents are required');
    err.status = 400;
    throw err;
  }
  await assertWithinLimitAndIncrement(user, TOOL_SLUG, 'expenses_created', 'max_expenses_per_month');
  const { rows } = await pool.query(
    `INSERT INTO et_expenses (user_id, category, amount_cents, expense_date, note) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [user.sub, category, Math.round(Number(amountCents)), expenseDate || new Date().toISOString().slice(0, 10), note || null]
  );
  return rows[0];
}

export async function deleteExpense(userId, id) {
  const { rowCount } = await pool.query(`DELETE FROM et_expenses WHERE user_id = $1 AND id = $2`, [userId, id]);
  return rowCount > 0;
}

export async function listBudgets(userId) {
  const { rows } = await pool.query(`SELECT * FROM et_budgets WHERE user_id = $1 ORDER BY category ASC`, [userId]);
  return rows;
}

export async function setBudget(user, { category, monthlyLimitCents }) {
  const allowed = await hasFeature(user, TOOL_SLUG, 'budgets');
  if (!allowed) {
    const err = new Error('Budgets are a Pro feature — upgrade Expense Tracker to set spending limits per category.');
    err.status = 402;
    err.code = 'TIER_LIMIT_REACHED';
    throw err;
  }
  if (!category || !(Number(monthlyLimitCents) > 0)) {
    const err = new Error('category and a positive monthlyLimitCents are required');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO et_budgets (user_id, category, monthly_limit_cents) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, category) DO UPDATE SET monthly_limit_cents = EXCLUDED.monthly_limit_cents
     RETURNING *`,
    [user.sub, category, Math.round(Number(monthlyLimitCents))]
  );
  return rows[0];
}

// month = 'YYYY-MM'. Returns per-category totals, and — on Pro — how each
// compares to its budget.
export async function getSummary(user, month) {
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const { rows: totals } = await pool.query(
    `SELECT category, SUM(amount_cents)::bigint AS total_cents, COUNT(*)::int AS count
     FROM et_expenses WHERE user_id = $1 AND to_char(expense_date, 'YYYY-MM') = $2
     GROUP BY category ORDER BY total_cents DESC`,
    [user.sub, targetMonth]
  );
  const grandTotalCents = totals.reduce((sum, r) => sum + Number(r.total_cents), 0);

  const canUseBudgets = await hasFeature(user, TOOL_SLUG, 'budgets');
  let budgetsByCategory = {};
  if (canUseBudgets) {
    const budgets = await listBudgets(user.sub);
    budgetsByCategory = Object.fromEntries(budgets.map((b) => [b.category, Number(b.monthly_limit_cents)]));
  }

  return {
    month: targetMonth,
    grandTotalCents,
    categories: totals.map((r) => ({
      category: r.category,
      totalCents: Number(r.total_cents),
      count: r.count,
      budgetCents: budgetsByCategory[r.category] ?? null,
      overBudget: budgetsByCategory[r.category] != null && Number(r.total_cents) > budgetsByCategory[r.category],
    })),
  };
}
