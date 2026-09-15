import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { assertResourceLimit, hasFeature } from './tiers.service.js';

const TOOL_SLUG = 'staff-attendance';

export async function getOrCreateKioskToken(userId) {
  const { rows } = await pool.query(`SELECT token FROM sa_kiosk_tokens WHERE user_id = $1`, [userId]);
  if (rows.length) return rows[0].token;
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query(`INSERT INTO sa_kiosk_tokens (user_id, token) VALUES ($1,$2)`, [userId, token]);
  return token;
}

export async function rotateKioskToken(userId) {
  const token = crypto.randomBytes(16).toString('hex');
  await pool.query(
    `INSERT INTO sa_kiosk_tokens (user_id, token) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token`,
    [userId, token]
  );
  return token;
}

export async function listEmployees(userId) {
  const { rows } = await pool.query(`SELECT * FROM sa_employees WHERE user_id = $1 AND active = TRUE ORDER BY name ASC`, [userId]);
  return rows;
}

export async function createEmployee(user, { name, employeeCode, email }) {
  if (!name || !employeeCode) { const err = new Error('name and employeeCode are required'); err.status = 400; throw err; }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM sa_employees WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_employees', countRows[0].n);

  try {
    const { rows } = await pool.query(
      `INSERT INTO sa_employees (user_id, name, employee_code, email) VALUES ($1,$2,$3,$4) RETURNING *`,
      [userId, name, employeeCode.trim(), email || null]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') { const e = new Error('An employee with that code already exists'); e.status = 409; throw e; }
    throw err;
  }
}

export async function deactivateEmployee(userId, employeeId) {
  const { rowCount } = await pool.query(`UPDATE sa_employees SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, employeeId]);
  return rowCount > 0;
}

export async function listRecords(userId, { from, to } = {}) {
  const params = [userId];
  let where = 'r.user_id = $1';
  if (from) { params.push(from); where += ` AND r.work_date >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND r.work_date <= $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT r.*, e.name AS employee_name, e.employee_code
     FROM sa_attendance_records r JOIN sa_employees e ON e.id = r.employee_id
     WHERE ${where} ORDER BY r.work_date DESC, e.name ASC`,
    params
  );
  return rows;
}

export async function markAbsent(userId, employeeId, workDate) {
  const { rows: employees } = await pool.query(`SELECT id FROM sa_employees WHERE user_id = $1 AND id = $2`, [userId, employeeId]);
  if (!employees.length) { const err = new Error('Employee not found'); err.status = 404; throw err; }
  const { rows } = await pool.query(
    `INSERT INTO sa_attendance_records (user_id, employee_id, work_date, status) VALUES ($1,$2,$3,'absent')
     ON CONFLICT (employee_id, work_date) DO UPDATE SET status = 'absent', check_in_time = NULL, check_out_time = NULL
     RETURNING *`,
    [userId, employeeId, workDate]
  );
  return rows[0];
}

// The kiosk endpoint — no auth token from a logged-in user, just the
// business's kiosk token plus whatever code the employee enters/scans.
export async function kioskCheckInOut(kioskToken, employeeCode) {
  const { rows: tokenRows } = await pool.query(`SELECT user_id FROM sa_kiosk_tokens WHERE token = $1`, [kioskToken]);
  if (!tokenRows.length) { const err = new Error('Invalid kiosk link'); err.status = 401; throw err; }
  const userId = tokenRows[0].user_id;

  const { rows: employees } = await pool.query(
    `SELECT * FROM sa_employees WHERE user_id = $1 AND employee_code = $2 AND active = TRUE`,
    [userId, employeeCode?.trim()]
  );
  if (!employees.length) { const err = new Error('Employee code not recognized'); err.status = 404; throw err; }
  const employee = employees[0];

  const today = new Date().toISOString().slice(0, 10);
  const { rows: existing } = await pool.query(
    `SELECT * FROM sa_attendance_records WHERE employee_id = $1 AND work_date = $2`,
    [employee.id, today]
  );

  if (!existing.length) {
    const { rows } = await pool.query(
      `INSERT INTO sa_attendance_records (user_id, employee_id, work_date, check_in_time, status)
       VALUES ($1,$2,$3, now(), 'present') RETURNING *`,
      [userId, employee.id, today]
    );
    return { action: 'checked_in', employeeName: employee.name, record: rows[0] };
  }
  if (!existing[0].check_out_time) {
    const { rows } = await pool.query(
      `UPDATE sa_attendance_records SET check_out_time = now() WHERE id = $1 RETURNING *`,
      [existing[0].id]
    );
    return { action: 'checked_out', employeeName: employee.name, record: rows[0] };
  }
  const err = new Error(`${employee.name} has already checked in and out today.`);
  err.status = 409;
  throw err;
}

function csvEscape(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportPayrollCsv(user, { from, to }) {
  const allowed = await hasFeature(user, TOOL_SLUG, 'payroll_export');
  if (!allowed) {
    const err = new Error('Payroll export is a Pro feature — upgrade Staff Attendance to download it.');
    err.status = 402;
    err.code = 'TIER_LIMIT_REACHED';
    throw err;
  }
  const records = await listRecords(user.sub, { from, to });
  const header = ['Employee', 'Code', 'Date', 'Check in', 'Check out', 'Status'];
  const lines = [header.join(',')];
  for (const r of records) {
    lines.push([
      csvEscape(r.employee_name), csvEscape(r.employee_code), csvEscape(r.work_date.toISOString().slice(0, 10)),
      csvEscape(r.check_in_time ? new Date(r.check_in_time).toISOString() : ''),
      csvEscape(r.check_out_time ? new Date(r.check_out_time).toISOString() : ''),
      csvEscape(r.status),
    ].join(','));
  }
  return lines.join('\n');
}
