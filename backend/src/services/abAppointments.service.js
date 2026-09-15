import { pool } from '../db/pool.js';
import { assertWithinLimitAndIncrement } from './tiers.service.js';
import { getClient } from './abClients.service.js';

const TOOL_SLUG = 'appointment-booking';

async function fetchFull(userId, id) {
  const { rows } = await pool.query(
    `SELECT a.*, c.name AS client_name, s.name AS service_name, s.duration_minutes
     FROM ab_appointments a
     JOIN ab_clients c ON c.id = a.client_id
     JOIN ab_services s ON s.id = a.service_id
     WHERE a.user_id = $1 AND a.id = $2`,
    [userId, id]
  );
  return rows[0] ?? null;
}

export async function listAppointments(userId, { status, from, to } = {}) {
  const params = [userId];
  let where = 'a.user_id = $1';
  if (status) { params.push(status); where += ` AND a.status = $${params.length}`; }
  if (from) { params.push(from); where += ` AND a.start_time >= $${params.length}`; }
  if (to) { params.push(to); where += ` AND a.start_time < $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT a.*, c.name AS client_name, s.name AS service_name, s.duration_minutes
     FROM ab_appointments a
     JOIN ab_clients c ON c.id = a.client_id
     JOIN ab_services s ON s.id = a.service_id
     WHERE ${where} ORDER BY a.start_time ASC`,
    params
  );
  return rows;
}

async function getService(userId, serviceId) {
  const { rows } = await pool.query(`SELECT * FROM ab_services WHERE user_id = $1 AND id = $2`, [userId, serviceId]);
  return rows[0] ?? null;
}

export async function createAppointment(user, { clientId, serviceId, startTime, notes }) {
  const userId = user.sub;
  if (!clientId || !serviceId || !startTime) {
    const err = new Error('clientId, serviceId, and startTime are required');
    err.status = 400;
    throw err;
  }
  const client = await getClient(userId, clientId);
  if (!client) { const err = new Error('Client not found'); err.status = 404; throw err; }
  const service = await getService(userId, serviceId);
  if (!service) { const err = new Error('Service not found'); err.status = 404; throw err; }

  const start = new Date(startTime);
  if (Number.isNaN(start.getTime())) {
    const err = new Error('startTime must be a valid date/time');
    err.status = 400;
    throw err;
  }
  const end = new Date(start.getTime() + service.duration_minutes * 60000);

  // Double-booking guard: no two scheduled appointments for the same
  // business may overlap in time, regardless of client/service.
  const { rows: overlaps } = await pool.query(
    `SELECT id FROM ab_appointments
     WHERE user_id = $1 AND status = 'scheduled' AND start_time < $2 AND end_time > $3`,
    [userId, end.toISOString(), start.toISOString()]
  );
  if (overlaps.length) {
    const err = new Error('This time slot overlaps with an existing appointment.');
    err.status = 409;
    throw err;
  }

  await assertWithinLimitAndIncrement(user, TOOL_SLUG, 'appointments_created', 'max_appointments_per_month');

  const { rows } = await pool.query(
    `INSERT INTO ab_appointments (user_id, client_id, service_id, start_time, end_time, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [userId, clientId, serviceId, start.toISOString(), end.toISOString(), notes || null]
  );
  return fetchFull(userId, rows[0].id);
}

const VALID_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];
export async function updateStatus(userId, id, status) {
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const { rowCount } = await pool.query(`UPDATE ab_appointments SET status = $1 WHERE user_id = $2 AND id = $3`, [status, userId, id]);
  if (!rowCount) return null;
  return fetchFull(userId, id);
}

export async function deleteAppointment(userId, id) {
  const existing = await fetchFull(userId, id);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status === 'completed' || existing.status === 'no_show') {
    return { ok: false, reason: 'has_history' };
  }
  await pool.query(`DELETE FROM ab_appointments WHERE user_id = $1 AND id = $2`, [userId, id]);
  return { ok: true };
}
