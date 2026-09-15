import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as invoicesService from '../services/igInvoices.service.js';
import { getUsageSummary } from '../services/tiers.service.js';

export const igInvoicesRouter = Router();
igInvoicesRouter.use(requireAuth);

igInvoicesRouter.get('/usage', async (req, res, next) => {
  try {
    const usage = await getUsageSummary(req.user, 'invoice-generator', 'invoices_created', 'max_invoices_per_month');
    res.json({ usage });
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    res.json({ invoices: await invoicesService.listInvoices(req.user.sub, { status }) });
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.get('/:id', async (req, res, next) => {
  try {
    const invoice = await invoicesService.getInvoice(req.user.sub, req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.get('/:id/pdf', async (req, res, next) => {
  try {
    await invoicesService.renderInvoicePdf(req.user, req.params.id, res);
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.post('/', async (req, res, next) => {
  try {
    const invoice = await invoicesService.createInvoice(req.user, req.body);
    res.status(201).json({ invoice });
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.patch('/:id', async (req, res, next) => {
  try {
    const invoice = await invoicesService.updateInvoiceDraft(req.user, req.params.id, req.body);
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.patch('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const invoice = await invoicesService.updateInvoiceStatus(req.user.sub, req.params.id, status);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    res.json({ invoice });
  } catch (err) {
    next(err);
  }
});

igInvoicesRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await invoicesService.deleteInvoice(req.user.sub, req.params.id);
    if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Invoice not found' });
    if (!result.ok && result.reason === 'not_draft') {
      return res.status(409).json({ error: 'Only draft invoices can be deleted — void it instead to keep the record.' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
