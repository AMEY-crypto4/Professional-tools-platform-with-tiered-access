import crypto from 'node:crypto';
import { pool, withTransaction } from '../db/pool.js';
import { assertResourceLimit } from './tiers.service.js';

const TOOL_SLUG = 'queue-management';

export async function listQueues(userId) {
  const { rows } = await pool.query(
    `SELECT q.*, COUNT(t.id) FILTER (WHERE t.status = 'waiting')::int AS waiting_count
     FROM qm_queues q LEFT JOIN qm_tickets t ON t.queue_id = q.id AND t.created_at::date = CURRENT_DATE
     WHERE q.user_id = $1 AND q.active = TRUE GROUP BY q.id ORDER BY q.name ASC`,
    [userId]
  );
  return rows;
}

async function getQueueForUser(userId, queueId) {
  const { rows } = await pool.query(`SELECT * FROM qm_queues WHERE user_id = $1 AND id = $2`, [userId, queueId]);
  return rows[0] ?? null;
}

export async function createQueue(user, { name }) {
  if (!name) { const err = new Error('name is required'); err.status = 400; throw err; }
  const userId = user.sub;
  const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM qm_queues WHERE user_id = $1 AND active = TRUE`, [userId]);
  await assertResourceLimit(user, TOOL_SLUG, 'max_active_queues', countRows[0].n);

  const joinToken = crypto.randomBytes(12).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO qm_queues (user_id, name, join_token) VALUES ($1,$2,$3) RETURNING *`,
    [userId, name, joinToken]
  );
  return rows[0];
}

export async function deactivateQueue(userId, queueId) {
  const { rowCount } = await pool.query(`UPDATE qm_queues SET active = FALSE WHERE user_id = $1 AND id = $2`, [userId, queueId]);
  return rowCount > 0;
}

export async function listTickets(userId, queueId, { status } = {}) {
  const queue = await getQueueForUser(userId, queueId);
  if (!queue) { const err = new Error('Queue not found'); err.status = 404; throw err; }
  const params = [queueId];
  let where = 'queue_id = $1 AND created_at::date = CURRENT_DATE';
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  const { rows } = await pool.query(`SELECT * FROM qm_tickets WHERE ${where} ORDER BY ticket_number ASC`, params);
  return rows;
}

// Public — called from a "take a ticket" link/QR with no login. Locks the
// queue row for the duration of the transaction so two customers tapping
// the link at the same instant can never be handed the same ticket number.
export async function joinQueue(joinToken, customerName) {
  return withTransaction(async (tx) => {
    const { rows: queues } = await tx.query(`SELECT * FROM qm_queues WHERE join_token = $1 AND active = TRUE FOR UPDATE`, [joinToken]);
    if (!queues.length) { const err = new Error('This queue link is not valid or is no longer active.'); err.status = 404; throw err; }
    const queue = queues[0];

    const { rows: countRows } = await tx.query(
      `SELECT COUNT(*)::int AS n FROM qm_tickets WHERE queue_id = $1 AND created_at::date = CURRENT_DATE`,
      [queue.id]
    );
    const ticketNumber = countRows[0].n + 1;
    const { rows } = await tx.query(
      `INSERT INTO qm_tickets (queue_id, ticket_number, customer_name) VALUES ($1,$2,$3) RETURNING *`,
      [queue.id, ticketNumber, customerName || null]
    );
    return { queueName: queue.name, ticket: rows[0], position: ticketNumber };
  });
}

// Public — lets a customer poll their own status without an account. No
// real-time push (that needs an SMS/email provider, not wired up here) —
// this is "refresh to check", the same honest limitation noted elsewhere in
// this codebase for anything that would otherwise need outbound
// SMS/email/push infrastructure.
export async function getPublicTicketStatus(joinToken, ticketId) {
  const { rows } = await pool.query(
    `SELECT t.*, q.name AS queue_name FROM qm_tickets t JOIN qm_queues q ON q.id = t.queue_id
     WHERE q.join_token = $1 AND t.id = $2`,
    [joinToken, ticketId]
  );
  if (!rows.length) { const err = new Error('Ticket not found'); err.status = 404; throw err; }
  const ticket = rows[0];
  const { rows: aheadRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM qm_tickets WHERE queue_id = $1 AND status = 'waiting' AND ticket_number < $2 AND created_at::date = CURRENT_DATE`,
    [ticket.queue_id, ticket.ticket_number]
  );
  return { ...ticket, peopleAhead: ticket.status === 'waiting' ? aheadRows[0].n : 0 };
}

export async function callNext(userId, queueId) {
  const queue = await getQueueForUser(userId, queueId);
  if (!queue) { const err = new Error('Queue not found'); err.status = 404; throw err; }
  const { rows } = await pool.query(
    `UPDATE qm_tickets SET status = 'called', called_at = now()
     WHERE id = (SELECT id FROM qm_tickets WHERE queue_id = $1 AND status = 'waiting' AND created_at::date = CURRENT_DATE ORDER BY ticket_number ASC LIMIT 1)
     RETURNING *`,
    [queueId]
  );
  return rows[0] ?? null;
}

export async function markServed(userId, ticketId) {
  const { rows } = await pool.query(
    `SELECT t.id FROM qm_tickets t JOIN qm_queues q ON q.id = t.queue_id WHERE q.user_id = $1 AND t.id = $2`,
    [userId, ticketId]
  );
  if (!rows.length) return null;
  const { rows: updated } = await pool.query(
    `UPDATE qm_tickets SET status = 'served', served_at = now() WHERE id = $1 RETURNING *`,
    [ticketId]
  );
  return updated[0];
}
