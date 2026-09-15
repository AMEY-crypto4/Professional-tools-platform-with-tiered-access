import { pool } from '../db/pool.js';

export async function listClients(userId) {
  const { rows } = await pool.query(`SELECT * FROM ab_clients WHERE user_id = $1 ORDER BY name ASC`, [userId]);
  return rows;
}
export async function getClient(userId, clientId) {
  const { rows } = await pool.query(`SELECT * FROM ab_clients WHERE user_id = $1 AND id = $2`, [userId, clientId]);
  return rows[0] ?? null;
}
export async function createClient(userId, { name, email, phone }) {
  const { rows } = await pool.query(
    `INSERT INTO ab_clients (user_id, name, email, phone) VALUES ($1,$2,$3,$4) RETURNING *`,
    [userId, name, email || null, phone || null]
  );
  return rows[0];
}
export async function deleteClient(userId, clientId) {
  const { rowCount } = await pool.query(`DELETE FROM ab_clients WHERE user_id = $1 AND id = $2`, [userId, clientId]);
  return rowCount > 0;
}
