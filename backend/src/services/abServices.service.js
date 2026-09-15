import { pool } from '../db/pool.js';
import { assertResourceLimit } from './tiers.service.js';

const TOOL_SLUG = 'appointment-booking';

export async function listServices(userId) {
  const { rows } = await pool.query(`SELECT * FROM ab_services WHERE user_id = $1 AND active = TRUE ORDER BY name ASC`, [userId]);
  return rows;
}

export async function createService(user, { name, durationMinutes, priceCents }) {
  if (!name) {
    const err = new Error('name is required');
    err.status = 400;
    throw err;
  }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ab_services WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_services', countRows[0].n);

  const { rows } = await pool.query(
    `INSERT INTO ab_services (user_id, name, duration_minutes, price_cents) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, name, Number(durationMinutes) || 30, Math.round(Number(priceCents)) || 0]
  );
  return rows[0];
}

export async function deleteService(userId, serviceId) {
  // Soft-delete: past appointments still reference this service, so a hard
  // DELETE would either cascade-destroy history or fail on the FK. Marking
  // it inactive removes it from the booking dropdown without losing records.
  const { rowCount } = await pool.query(`UPDATE ab_services SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, serviceId]);
  return rowCount > 0;
}
