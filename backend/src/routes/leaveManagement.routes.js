import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/leaveManagement.service.js';

export const leaveManagementRouter = Router();
leaveManagementRouter.use(requireAuth);

leaveManagementRouter.get('/employees', async (req, res, next) => {
  try { res.json({ employees: await service.listEmployees(req.user.sub) }); } catch (err) { next(err); }
});
leaveManagementRouter.post('/employees', async (req, res, next) => {
  try { res.status(201).json({ employee: await service.createEmployee(req.user, req.body) }); } catch (err) { next(err); }
});
leaveManagementRouter.delete('/employees/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateEmployee(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Employee not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

leaveManagementRouter.get('/requests', async (req, res, next) => {
  try { res.json({ requests: await service.listRequests(req.user.sub, req.query) }); } catch (err) { next(err); }
});
leaveManagementRouter.post('/requests', async (req, res, next) => {
  try { res.status(201).json({ request: await service.createRequest(req.user.sub, req.body) }); } catch (err) { next(err); }
});
leaveManagementRouter.patch('/requests/:id/status', async (req, res, next) => {
  try {
    const request = await service.decideRequest(req.user.sub, req.params.id, (req.body || {}).status);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    res.json({ request });
  } catch (err) { next(err); }
});
