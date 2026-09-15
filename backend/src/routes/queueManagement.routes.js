import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/queueManagement.service.js';

// Public — no requireAuth. Mounted at a more specific path than
// queueManagementRouter and BEFORE it in app.js (same route-ordering reason
// documented in staffAttendance.routes.js / app.js).
export const queueManagementPublicRouter = Router();
queueManagementPublicRouter.post('/:joinToken/join', async (req, res, next) => {
  try {
    const result = await service.joinQueue(req.params.joinToken, (req.body || {}).customerName);
    res.status(201).json(result);
  } catch (err) { next(err); }
});
queueManagementPublicRouter.get('/:joinToken/tickets/:ticketId', async (req, res, next) => {
  try { res.json({ ticket: await service.getPublicTicketStatus(req.params.joinToken, req.params.ticketId) }); } catch (err) { next(err); }
});

export const queueManagementRouter = Router();
queueManagementRouter.use(requireAuth);

queueManagementRouter.get('/queues', async (req, res, next) => {
  try { res.json({ queues: await service.listQueues(req.user.sub) }); } catch (err) { next(err); }
});
queueManagementRouter.post('/queues', async (req, res, next) => {
  try { res.status(201).json({ queue: await service.createQueue(req.user, req.body) }); } catch (err) { next(err); }
});
queueManagementRouter.delete('/queues/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateQueue(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Queue not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
queueManagementRouter.get('/queues/:id/tickets', async (req, res, next) => {
  try { res.json({ tickets: await service.listTickets(req.user.sub, req.params.id, req.query) }); } catch (err) { next(err); }
});
queueManagementRouter.post('/queues/:id/call-next', async (req, res, next) => {
  try {
    const ticket = await service.callNext(req.user.sub, req.params.id);
    res.json({ ticket });
  } catch (err) { next(err); }
});
queueManagementRouter.patch('/tickets/:id/served', async (req, res, next) => {
  try {
    const ticket = await service.markServed(req.user.sub, req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket });
  } catch (err) { next(err); }
});
