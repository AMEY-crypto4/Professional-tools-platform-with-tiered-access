import PDFDocument from 'pdfkit';
import { pool, withTransaction } from '../db/pool.js';
import { assertWithinLimitAndIncrement, hasFeature } from './tiers.service.js';
import { getClient } from './igClients.service.js';

const TOOL_SLUG = 'invoice-generator';

function advanceDate(dateStr, interval) {
  const d = new Date(dateStr);
  if (interval === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (interval === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (interval === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

async function fetchInvoiceFull(q, userId, invoiceId) {
  const { rows } = await q.query(
    `SELECT i.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.address AS client_address
     FROM ig_invoices i JOIN ig_clients c ON c.id = i.client_id
     WHERE i.user_id = $1 AND i.id = $2`,
    [userId, invoiceId]
  );
  if (!rows.length) return null;
  const invoice = rows[0];
  const { rows: items } = await q.query(
    `SELECT * FROM ig_invoice_items WHERE invoice_id = $1 ORDER BY sort_order ASC`,
    [invoiceId]
  );
  return { ...invoice, items };
}

export async function listInvoices(userId, { status } = {}) {
  const params = [userId];
  let where = 'i.user_id = $1';
  if (status) {
    params.push(status);
    where += ` AND i.status = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.status, i.issue_date, i.due_date, i.currency, i.total_cents,
            i.is_recurring, i.recurrence_interval, c.name AS client_name
     FROM ig_invoices i JOIN ig_clients c ON c.id = i.client_id
     WHERE ${where} ORDER BY i.issue_date DESC, i.id DESC`,
    params
  );
  return rows;
}

export async function getInvoice(userId, invoiceId) {
  return fetchInvoiceFull(pool, userId, invoiceId);
}

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error('At least one line item is required');
    err.status = 400;
    throw err;
  }
  for (const item of items) {
    if (!item.description || !(Number(item.quantity) > 0) || !(Number(item.unitPriceCents) >= 0)) {
      const err = new Error('Each line item needs a description, a positive quantity, and a unit price');
      err.status = 400;
      throw err;
    }
  }
}

function computeTotals(items, taxPercent) {
  const priced = items.map((item, i) => ({
    description: item.description,
    quantity: Number(item.quantity),
    unitPriceCents: Math.round(Number(item.unitPriceCents)),
    amountCents: Math.round(Number(item.quantity) * Number(item.unitPriceCents)),
    sortOrder: i,
  }));
  const subtotalCents = priced.reduce((sum, i) => sum + i.amountCents, 0);
  const tax = Number(taxPercent) || 0;
  const totalCents = Math.round(subtotalCents * (1 + tax / 100));
  return { priced, subtotalCents, tax, totalCents };
}

export async function createInvoice(user, input) {
  const { clientId, issueDate, dueDate, currency, taxPercent, notes, isRecurring, recurrenceInterval, items } = input || {};
  const userId = user.sub;

  if (!clientId) {
    const err = new Error('clientId is required');
    err.status = 400;
    throw err;
  }
  const client = await getClient(userId, clientId);
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  validateItems(items);

  if (isRecurring) {
    const allowed = await hasFeature(user, TOOL_SLUG, 'recurring_invoices');
    if (!allowed) {
      const err = new Error('Recurring invoices are a Pro feature — upgrade Invoice Generator to enable them.');
      err.status = 402;
      err.code = 'TIER_LIMIT_REACHED';
      throw err;
    }
    if (!['weekly', 'monthly', 'yearly'].includes(recurrenceInterval)) {
      const err = new Error('recurrenceInterval must be weekly, monthly, or yearly');
      err.status = 400;
      throw err;
    }
  }

  // Validated everything that can fail before this point — the limit check
  // below both enforces AND consumes this month's allowance, so it must run
  // only once we're confident the insert that follows will succeed.
  await assertWithinLimitAndIncrement(user, TOOL_SLUG, 'invoices_created', 'max_invoices_per_month');

  const { priced, subtotalCents, tax, totalCents } = computeTotals(items, taxPercent);
  const effectiveIssueDate = issueDate || new Date().toISOString().slice(0, 10);
  const nextRecurrenceDate = isRecurring ? advanceDate(effectiveIssueDate, recurrenceInterval) : null;

  return withTransaction(async (tx) => {
    const { rows: countRows } = await tx.query('SELECT COUNT(*)::int AS n FROM ig_invoices WHERE user_id = $1', [userId]);
    const invoiceNumber = `INV-${String(countRows[0].n + 1).padStart(4, '0')}`;

    const { rows } = await tx.query(
      `INSERT INTO ig_invoices
         (user_id, client_id, invoice_number, status, issue_date, due_date, currency, subtotal_cents, tax_percent, total_cents, notes, is_recurring, recurrence_interval, next_recurrence_date)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [userId, clientId, invoiceNumber, effectiveIssueDate, dueDate || null, currency || 'usd', subtotalCents, tax, totalCents, notes || null, !!isRecurring, recurrenceInterval || null, nextRecurrenceDate]
    );
    const invoiceId = rows[0].id;

    for (const item of priced) {
      await tx.query(
        `INSERT INTO ig_invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, item.description, item.quantity, item.unitPriceCents, item.amountCents, item.sortOrder]
      );
    }

    return fetchInvoiceFull(tx, userId, invoiceId);
  });
}

// Full edits (line items, amounts, client) are only allowed while an invoice
// is still a draft — once it's been sent, changing the total behind the
// client's back is exactly the kind of silent-drift bug this platform is
// supposed to prevent. Status/notes/due-date changes go through
// updateInvoiceStatus instead, which works at any status.
export async function updateInvoiceDraft(user, invoiceId, input) {
  const userId = user.sub;
  const existing = await getInvoice(userId, invoiceId);
  if (!existing) {
    const err = new Error('Invoice not found');
    err.status = 404;
    throw err;
  }
  if (existing.status !== 'draft') {
    const err = new Error('Only draft invoices can be edited — change its status instead, or void it and create a new one.');
    err.status = 409;
    throw err;
  }

  const { clientId, issueDate, dueDate, currency, taxPercent, notes, items } = input || {};
  const effectiveClientId = clientId || existing.client_id;
  if (clientId) {
    const client = await getClient(userId, clientId);
    if (!client) {
      const err = new Error('Client not found');
      err.status = 404;
      throw err;
    }
  }
  const effectiveItems = items || existing.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceCents: i.unit_price_cents }));
  validateItems(effectiveItems);
  const { priced, subtotalCents, tax, totalCents } = computeTotals(effectiveItems, taxPercent ?? existing.tax_percent);

  return withTransaction(async (tx) => {
    await tx.query(
      `UPDATE ig_invoices SET client_id=$1, issue_date=$2, due_date=$3, currency=$4, subtotal_cents=$5, tax_percent=$6, total_cents=$7, notes=$8
       WHERE id = $9`,
      [effectiveClientId, issueDate || existing.issue_date, dueDate ?? existing.due_date, currency || existing.currency, subtotalCents, tax, totalCents, notes ?? existing.notes, invoiceId]
    );
    await tx.query('DELETE FROM ig_invoice_items WHERE invoice_id = $1', [invoiceId]);
    for (const item of priced) {
      await tx.query(
        `INSERT INTO ig_invoice_items (invoice_id, description, quantity, unit_price_cents, amount_cents, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, item.description, item.quantity, item.unitPriceCents, item.amountCents, item.sortOrder]
      );
    }
    return fetchInvoiceFull(tx, userId, invoiceId);
  });
}

const VALID_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'];

export async function updateInvoiceStatus(userId, invoiceId, status) {
  if (!VALID_STATUSES.includes(status)) {
    const err = new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const { rows } = await pool.query(
    `UPDATE ig_invoices SET status = $1, paid_at = CASE WHEN $1 = 'paid' THEN now() ELSE NULL END
     WHERE user_id = $2 AND id = $3 RETURNING id`,
    [status, userId, invoiceId]
  );
  if (!rows.length) return null;
  return fetchInvoiceFull(pool, userId, invoiceId);
}

export async function deleteInvoice(userId, invoiceId) {
  const existing = await getInvoice(userId, invoiceId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (existing.status !== 'draft') {
    return { ok: false, reason: 'not_draft' };
  }
  await pool.query('DELETE FROM ig_invoices WHERE user_id = $1 AND id = $2', [userId, invoiceId]);
  return { ok: true };
}

// Run periodically (see src/jobs/generateRecurringInvoices.js) — clones each
// due recurring invoice into a fresh draft for the new period and advances
// the template's own next_recurrence_date. If the owner has since dropped to
// the free tier, the invoice is left in place but stops advancing (skipped),
// so nothing is silently created outside what they're paying for.
export async function generateDueRecurringInvoices(today = new Date().toISOString().slice(0, 10)) {
  const { rows: due } = await pool.query(
    `SELECT i.*, u.id AS owner_id, u.email AS owner_email, u.display_name AS owner_display_name, u.is_owner AS owner_is_owner
     FROM ig_invoices i JOIN users u ON u.id = i.user_id
     WHERE i.is_recurring = TRUE AND i.next_recurrence_date <= $1`,
    [today]
  );

  const results = [];
  for (const template of due) {
    const owner = { sub: template.owner_id, email: template.owner_email, displayName: template.owner_display_name, isOwner: template.owner_is_owner };
    const allowed = await hasFeature(owner, TOOL_SLUG, 'recurring_invoices');
    if (!allowed) {
      results.push({ templateId: template.id, skipped: true, reason: 'downgraded' });
      continue;
    }

    const { rows: items } = await pool.query('SELECT * FROM ig_invoice_items WHERE invoice_id = $1 ORDER BY sort_order', [template.id]);
    const created = await createInvoice(owner, {
      clientId: template.client_id,
      issueDate: today,
      dueDate: template.due_date,
      currency: template.currency,
      taxPercent: template.tax_percent,
      notes: template.notes,
      isRecurring: false,
      items: items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceCents: i.unit_price_cents })),
    });

    const nextDate = advanceDate(today, template.recurrence_interval);
    await pool.query('UPDATE ig_invoices SET next_recurrence_date = $1 WHERE id = $2', [nextDate, template.id]);
    results.push({ templateId: template.id, createdInvoiceId: created.id });
  }
  return results;
}

const CURRENCY_SYMBOLS = { usd: '$', eur: '€', gbp: '£', inr: '₹', ngn: '₦' };
function formatMoney(cents, currency) {
  const symbol = CURRENCY_SYMBOLS[currency?.toLowerCase()] || `${(currency || 'USD').toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

// Streams a PDF straight to the response: new PDFDocument -> doc.pipe(res)
// -> build content -> doc.end(). Free-tier invoices carry a small platform
// credit line; Pro-tier invoices (remove_branding) omit it.
export async function renderInvoicePdf(user, invoiceId, res) {
  const invoice = await fetchInvoiceFull(pool, user.sub, invoiceId);
  if (!invoice) {
    const err = new Error('Invoice not found');
    err.status = 404;
    throw err;
  }
  const showBranding = !(await hasFeature(user, TOOL_SLUG, 'remove_branding'));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoice.invoice_number}.pdf"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  doc.fontSize(20).text(user.companyName || user.displayName || 'Invoice', { align: 'left' });
  doc.fontSize(10).fillColor('#647085').text(user.email);
  doc.moveDown(1.5);

  doc.fontSize(16).fillColor('#000').text(`Invoice ${invoice.invoice_number}`);
  doc.fontSize(10).fillColor('#647085')
    .text(`Status: ${invoice.status.toUpperCase()}`)
    .text(`Issue date: ${invoice.issue_date.toISOString().slice(0, 10)}`)
    .text(invoice.due_date ? `Due date: ${new Date(invoice.due_date).toISOString().slice(0, 10)}` : 'Due date: —');
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#000').text('Bill to:', { continued: false });
  doc.fontSize(10).fillColor('#333').text(invoice.client_name);
  if (invoice.client_email) doc.text(invoice.client_email);
  if (invoice.client_phone) doc.text(invoice.client_phone);
  if (invoice.client_address) doc.text(invoice.client_address);
  doc.moveDown(1.5);

  doc.fontSize(10).fillColor('#000');
  const tableTop = doc.y;
  doc.text('Description', 50, tableTop, { width: 260 });
  doc.text('Qty', 310, tableTop, { width: 50, align: 'right' });
  doc.text('Unit price', 360, tableTop, { width: 90, align: 'right' });
  doc.text('Amount', 450, tableTop, { width: 95, align: 'right' });
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
  doc.moveDown(0.5);

  for (const item of invoice.items) {
    const rowY = doc.y;
    doc.text(item.description, 50, rowY, { width: 260 });
    doc.text(String(item.quantity), 310, rowY, { width: 50, align: 'right' });
    doc.text(formatMoney(item.unit_price_cents, invoice.currency), 360, rowY, { width: 90, align: 'right' });
    doc.text(formatMoney(item.amount_cents, invoice.currency), 450, rowY, { width: 95, align: 'right' });
    doc.moveDown(0.7);
  }

  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ddd').stroke();
  doc.moveDown(0.5);
  doc.text(`Subtotal: ${formatMoney(invoice.subtotal_cents, invoice.currency)}`, { align: 'right' });
  if (Number(invoice.tax_percent) > 0) {
    doc.text(`Tax (${invoice.tax_percent}%): ${formatMoney(invoice.total_cents - invoice.subtotal_cents, invoice.currency)}`, { align: 'right' });
  }
  doc.fontSize(13).text(`Total: ${formatMoney(invoice.total_cents, invoice.currency)}`, { align: 'right' });

  if (invoice.notes) {
    doc.moveDown(1.5);
    doc.fontSize(10).fillColor('#647085').text('Notes:');
    doc.fillColor('#333').text(invoice.notes);
  }

  if (showBranding) {
    doc.fontSize(8).fillColor('#aaa').text('Created with A&A Creations — Invoice Generator', 50, 760, { align: 'center', width: 495 });
  }

  doc.end();
}
