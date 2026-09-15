import { pool } from '../db/pool.js';

export async function listClients(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM ig_clients WHERE user_id = $1 ORDER BY name ASC`,
    [userId]
  );
  return rows;
}

export async function getClient(userId, clientId) {
  const { rows } = await pool.query(
    `SELECT * FROM ig_clients WHERE user_id = $1 AND id = $2`,
    [userId, clientId]
  );
  return rows[0] ?? null;
}

export async function createClient(userId, { name, email, phone, address }) {
  const { rows } = await pool.query(
    `INSERT INTO ig_clients (user_id, name, email, phone, address) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [userId, name, email || null, phone || null, address || null]
  );
  return rows[0];
}

export async function updateClient(userId, clientId, { name, email, phone, address }) {
  const { rows } = await pool.query(
    `UPDATE ig_clients SET name = COALESCE($1, name), email = $2, phone = $3, address = $4
     WHERE user_id = $5 AND id = $6 RETURNING *`,
    [name || null, email ?? null, phone ?? null, address ?? null, userId, clientId]
  );
  return rows[0] ?? null;
}

export async function deleteClient(userId, clientId) {
  const { rowCount } = await pool.query(
    `DELETE FROM ig_clients WHERE user_id = $1 AND id = $2`,
    [userId, clientId]
  );
  return rowCount > 0;
}
