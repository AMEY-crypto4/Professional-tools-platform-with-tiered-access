import { pool } from '../db/pool.js';
import { assertResourceLimit } from './tiers.service.js';

const TOOL_SLUG = 'leave-management';

export async function listEmployees(userId) {
  const { rows } = await pool.query(`SELECT * FROM lm_employees WHERE user_id = $1 AND active = TRUE ORDER BY name ASC`, [userId]);
  return rows;
}

export async function createEmployee(user, { name, email }) {
  if (!name) { const err = new Error('name is required'); err.status = 400; throw err; }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM lm_employees WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_employees', countRows[0].n);

  const { rows } = await pool.query(
    `INSERT INTO lm_employees (user_id, name, email) VALUES ($1,$2,$3) RETURNING *`,
    [userId, name, email || null]
  );
  return rows[0];
}

export async function deactivateEmployee(userId, employeeId) {
  const { rowCount } = await pool.query(`UPDATE lm_employees SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, employeeId]);
  return rowCount > 0;
}

export async function listRequests(userId, { status } = {}) {
  const params = [userId];
  let where = 'r.user_id = $1';
  if (status) { params.push(status); where += ` AND r.status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT r.*, e.name AS employee_name FROM lm_leave_requests r JOIN lm_employees e ON e.id = r.employee_id
     WHERE ${where} ORDER BY r.start_date DESC`,
    params
  );
  return rows;
}

export async function createRequest(userId, { employeeId, startDate, endDate, reason }) {
  if (!employeeId || !startDate || !endDate) {
    const err = new Error('employeeId, startDate, and endDate are required');
    err.status = 400;
    throw err;
  }
  const { rows: employees } = await pool.query(`SELECT id FROM lm_employees WHERE user_id = $1 AND id = $2`, [userId, employeeId]);
  if (!employees.length) { const err = new Error('Employee not found'); err.status = 404; throw err; }
  if (new Date(endDate) < new Date(startDate)) {
    const err = new Error('endDate must be on or after startDate');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `INSERT INTO lm_leave_requests (user_id, employee_id, start_date, end_date, reason) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [userId, employeeId, startDate, endDate, reason || null]
  );
  const { rows: full } = await pool.query(
    `SELECT r.*, e.name AS employee_name FROM lm_leave_requests r JOIN lm_employees e ON e.id = r.employee_id WHERE r.id = $1`,
    [rows[0].id]
  );
  return full[0];
}

export async function decideRequest(userId, requestId, status) {
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    const err = new Error('status must be approved, rejected, or pending');
    err.status = 400;
    throw err;
  }
  const { rowCount } = await pool.query(
    `UPDATE lm_leave_requests SET status = $1, decided_at = CASE WHEN $1 = 'pending' THEN NULL ELSE now() END
     WHERE user_id = $2 AND id = $3`,
    [status, userId, requestId]
  );
  if (!rowCount) return null;
  const { rows } = await pool.query(
    `SELECT r.*, e.name AS employee_name FROM lm_leave_requests r JOIN lm_employees e ON e.id = r.employee_id WHERE r.id = $1`,
    [requestId]
  );
  return rows[0];
}
