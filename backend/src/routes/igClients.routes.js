import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as clientsService from '../services/igClients.service.js';

export const igClientsRouter = Router();
igClientsRouter.use(requireAuth);

igClientsRouter.get('/', async (req, res, next) => {
  try {
    res.json({ clients: await clientsService.listClients(req.user.sub) });
  } catch (err) {
    next(err);
  }
});

igClientsRouter.post('/', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json({ client: await clientsService.createClient(req.user.sub, req.body) });
  } catch (err) {
    next(err);
  }
});

igClientsRouter.patch('/:id', async (req, res, next) => {
  try {
    const client = await clientsService.updateClient(req.user.sub, req.params.id, req.body || {});
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json({ client });
  } catch (err) {
    next(err);
  }
});

igClientsRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await clientsService.deleteClient(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ error: 'This client has invoices on file and cannot be deleted.' });
    }
    next(err);
  }
});
