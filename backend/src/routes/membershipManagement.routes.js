import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/membershipManagement.service.js';

export const membershipManagementRouter = Router();
membershipManagementRouter.use(requireAuth);

membershipManagementRouter.get('/members', async (req, res, next) => {
  try { res.json({ members: await service.listMembers(req.user.sub) }); } catch (err) { next(err); }
});
membershipManagementRouter.post('/members', async (req, res, next) => {
  try { res.status(201).json({ member: await service.createMember(req.user, req.body) }); } catch (err) { next(err); }
});
membershipManagementRouter.delete('/members/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateMember(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Member not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
membershipManagementRouter.get('/members/:id/payments', async (req, res, next) => {
  try { res.json({ payments: await service.listPayments(req.user.sub, req.params.id) }); } catch (err) { next(err); }
});
membershipManagementRouter.post('/members/:id/payments', async (req, res, next) => {
  try { res.status(201).json({ payment: await service.recordPayment(req.user.sub, req.params.id, req.body) }); } catch (err) { next(err); }
});
