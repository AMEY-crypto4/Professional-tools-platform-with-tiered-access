import { pool } from '../db/pool.js';
import { assertResourceLimit } from './tiers.service.js';

const TOOL_SLUG = 'property-management';

// Every unit/tenant/maintenance-request lookup below joins back up to
// pm_properties.user_id rather than trusting a bare id from the URL — that
// join is the only thing standing between "my own unit" and "any unit in
// the database" for these deeper-nested resources.

export async function listProperties(userId) {
  const { rows } = await pool.query(
    `SELECT p.*, COUNT(u.id)::int AS unit_count
     FROM pm_properties p LEFT JOIN pm_units u ON u.property_id = p.id
     WHERE p.user_id = $1 AND p.active = TRUE GROUP BY p.id ORDER BY p.name ASC`,
    [userId]
  );
  return rows;
}

async function getPropertyForUser(userId, propertyId) {
  const { rows } = await pool.query(`SELECT * FROM pm_properties WHERE user_id = $1 AND id = $2`, [userId, propertyId]);
  return rows[0] ?? null;
}

export async function createProperty(user, { name, address }) {
  if (!name) { const err = new Error('name is required'); err.status = 400; throw err; }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM pm_properties WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_properties', countRows[0].n);

  const { rows } = await pool.query(
    `INSERT INTO pm_properties (user_id, name, address) VALUES ($1,$2,$3) RETURNING *`,
    [userId, name, address || null]
  );
  return rows[0];
}

export async function deactivateProperty(userId, propertyId) {
  const { rowCount } = await pool.query(`UPDATE pm_properties SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, propertyId]);
  return rowCount > 0;
}

export async function listUnits(userId, propertyId) {
  const property = await getPropertyForUser(userId, propertyId);
  if (!property) { const err = new Error('Property not found'); err.status = 404; throw err; }
  const { rows } = await pool.query(`SELECT * FROM pm_units WHERE property_id = $1 ORDER BY unit_label ASC`, [propertyId]);
  return rows;
}

export async function createUnit(userId, propertyId, { unitLabel, monthlyRentCents }) {
  const property = await getPropertyForUser(userId, propertyId);
  if (!property) { const err = new Error('Property not found'); err.status = 404; throw err; }
  if (!unitLabel) { const err = new Error('unitLabel is required'); err.status = 400; throw err; }
  const { rows } = await pool.query(
    `INSERT INTO pm_units (property_id, unit_label, monthly_rent_cents) VALUES ($1,$2,$3) RETURNING *`,
    [propertyId, unitLabel, Math.round(Number(monthlyRentCents)) || 0]
  );
  return rows[0];
}

async function getUnitForUser(userId, unitId) {
  const { rows } = await pool.query(
    `SELECT u.* FROM pm_units u JOIN pm_properties p ON p.id = u.property_id WHERE p.user_id = $1 AND u.id = $2`,
    [userId, unitId]
  );
  return rows[0] ?? null;
}

export async function listTenants(userId, unitId) {
  const unit = await getUnitForUser(userId, unitId);
  if (!unit) { const err = new Error('Unit not found'); err.status = 404; throw err; }
  const { rows } = await pool.query(`SELECT * FROM pm_tenants WHERE unit_id = $1 AND active = TRUE ORDER BY name ASC`, [unitId]);
  return rows;
}

export async function createTenant(userId, unitId, { name, email, phone, leaseStart, leaseEnd }) {
  const unit = await getUnitForUser(userId, unitId);
  if (!unit) { const err = new Error('Unit not found'); err.status = 404; throw err; }
  if (!name) { const err = new Error('name is required'); err.status = 400; throw err; }
  const { rows } = await pool.query(
    `INSERT INTO pm_tenants (unit_id, name, email, phone, lease_start, lease_end) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [unitId, name, email || null, phone || null, leaseStart || null, leaseEnd || null]
  );
  return rows[0];
}

export async function deactivateTenant(userId, tenantId) {
  const { rows } = await pool.query(
    `SELECT t.id FROM pm_tenants t JOIN pm_units u ON u.id = t.unit_id JOIN pm_properties p ON p.id = u.property_id
     WHERE p.user_id = $1 AND t.id = $2`,
    [userId, tenantId]
  );
  if (!rows.length) return false;
  await pool.query(`UPDATE pm_tenants SET active = FALSE WHERE id = $1`, [tenantId]);
  return true;
}

export async function listMaintenanceRequests(userId, { status } = {}) {
  const params = [userId];
  let where = 'pr.user_id = $1';
  if (status) { params.push(status); where += ` AND m.status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT m.*, u.unit_label, pr.name AS property_name
     FROM pm_maintenance_requests m
     JOIN pm_units u ON u.id = m.unit_id
     JOIN pm_properties pr ON pr.id = u.property_id
     WHERE ${where} ORDER BY m.created_at DESC`,
    params
  );
  return rows;
}

export async function createMaintenanceRequest(userId, unitId, { description }) {
  const unit = await getUnitForUser(userId, unitId);
  if (!unit) { const err = new Error('Unit not found'); err.status = 404; throw err; }
  if (!description) { const err = new Error('description is required'); err.status = 400; throw err; }
  const { rows } = await pool.query(
    `INSERT INTO pm_maintenance_requests (unit_id, description) VALUES ($1,$2) RETURNING *`,
    [unitId, description]
  );
  return rows[0];
}

export async function updateMaintenanceStatus(userId, requestId, status) {
  if (!['open', 'in_progress', 'resolved'].includes(status)) {
    const err = new Error('status must be open, in_progress, or resolved');
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `SELECT m.id FROM pm_maintenance_requests m JOIN pm_units u ON u.id = m.unit_id JOIN pm_properties p ON p.id = u.property_id
     WHERE p.user_id = $1 AND m.id = $2`,
    [userId, requestId]
  );
  if (!rows.length) return null;
  const { rows: updated } = await pool.query(
    `UPDATE pm_maintenance_requests SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END
     WHERE id = $2 RETURNING *`,
    [status, requestId]
  );
  return updated[0];
}
