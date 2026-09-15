import { pool, withTransaction } from '../db/pool.js';
import { assertResourceLimit } from './tiers.service.js';

const TOOL_SLUG = 'inventory-management';

export async function listProducts(userId) {
  const { rows } = await pool.query(`SELECT * FROM inv_products WHERE user_id = $1 AND active = TRUE ORDER BY name ASC`, [userId]);
  return rows;
}

export async function lowStockProducts(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM inv_products WHERE user_id = $1 AND active = TRUE AND quantity_on_hand <= low_stock_threshold ORDER BY quantity_on_hand ASC`,
    [userId]
  );
  return rows;
}

async function getProduct(userId, productId) {
  const { rows } = await pool.query(`SELECT * FROM inv_products WHERE user_id = $1 AND id = $2`, [userId, productId]);
  return rows[0] ?? null;
}

export async function createProduct(user, { name, sku, priceCents, quantityOnHand, lowStockThreshold }) {
  if (!name) { const err = new Error('name is required'); err.status = 400; throw err; }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM inv_products WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_products', countRows[0].n);

  const { rows } = await pool.query(
    `INSERT INTO inv_products (user_id, name, sku, price_cents, quantity_on_hand, low_stock_threshold)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, name, sku || null, Math.round(Number(priceCents)) || 0, Number(quantityOnHand) || 0, Number(lowStockThreshold) || 5]
  );
  return rows[0];
}

export async function deactivateProduct(userId, productId) {
  const { rowCount } = await pool.query(`UPDATE inv_products SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, productId]);
  return rowCount > 0;
}

const VALID_REASONS = ['restock', 'sale', 'adjustment'];

// The one place quantity_on_hand is ever written — always alongside the
// movement row that explains why, inside one transaction so the two can
// never disagree.
export async function adjustStock(userId, productId, { changeQty, reason, note }) {
  if (!VALID_REASONS.includes(reason)) {
    const err = new Error(`reason must be one of: ${VALID_REASONS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const delta = Math.round(Number(changeQty));
  if (!delta) {
    const err = new Error('changeQty must be a non-zero integer');
    err.status = 400;
    throw err;
  }
  return withTransaction(async (tx) => {
    const { rows } = await tx.query(`SELECT * FROM inv_products WHERE user_id = $1 AND id = $2 FOR UPDATE`, [userId, productId]);
    if (!rows.length) { const err = new Error('Product not found'); err.status = 404; throw err; }
    const newQty = rows[0].quantity_on_hand + delta;
    if (newQty < 0) {
      const err = new Error(`Insufficient stock: ${rows[0].name} has ${rows[0].quantity_on_hand} on hand, cannot reduce by ${-delta}.`);
      err.status = 409;
      throw err;
    }
    await tx.query(`UPDATE inv_products SET quantity_on_hand = $1 WHERE id = $2`, [newQty, productId]);
    await tx.query(
      `INSERT INTO inv_stock_movements (product_id, change_qty, reason, note) VALUES ($1,$2,$3,$4)`,
      [productId, delta, reason, note || null]
    );
    const { rows: updated } = await tx.query(`SELECT * FROM inv_products WHERE id = $1`, [productId]);
    return updated[0];
  });
}

export async function listMovements(userId, productId) {
  const product = await getProduct(userId, productId);
  if (!product) { const err = new Error('Product not found'); err.status = 404; throw err; }
  const { rows } = await pool.query(`SELECT * FROM inv_stock_movements WHERE product_id = $1 ORDER BY created_at DESC`, [productId]);
  return rows;
}
