import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/propertyManagement.service.js';

export const propertyManagementRouter = Router();
propertyManagementRouter.use(requireAuth);

propertyManagementRouter.get('/properties', async (req, res, next) => {
  try { res.json({ properties: await service.listProperties(req.user.sub) }); } catch (err) { next(err); }
});
propertyManagementRouter.post('/properties', async (req, res, next) => {
  try { res.status(201).json({ property: await service.createProperty(req.user, req.body) }); } catch (err) { next(err); }
});
propertyManagementRouter.delete('/properties/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateProperty(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Property not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

propertyManagementRouter.get('/properties/:id/units', async (req, res, next) => {
  try { res.json({ units: await service.listUnits(req.user.sub, req.params.id) }); } catch (err) { next(err); }
});
propertyManagementRouter.post('/properties/:id/units', async (req, res, next) => {
  try { res.status(201).json({ unit: await service.createUnit(req.user.sub, req.params.id, req.body) }); } catch (err) { next(err); }
});

propertyManagementRouter.get('/units/:id/tenants', async (req, res, next) => {
  try { res.json({ tenants: await service.listTenants(req.user.sub, req.params.id) }); } catch (err) { next(err); }
});
propertyManagementRouter.post('/units/:id/tenants', async (req, res, next) => {
  try { res.status(201).json({ tenant: await service.createTenant(req.user.sub, req.params.id, req.body) }); } catch (err) { next(err); }
});
propertyManagementRouter.delete('/tenants/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateTenant(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Tenant not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

propertyManagementRouter.get('/maintenance-requests', async (req, res, next) => {
  try { res.json({ requests: await service.listMaintenanceRequests(req.user.sub, req.query) }); } catch (err) { next(err); }
});
propertyManagementRouter.post('/units/:id/maintenance-requests', async (req, res, next) => {
  try { res.status(201).json({ request: await service.createMaintenanceRequest(req.user.sub, req.params.id, req.body) }); } catch (err) { next(err); }
});
propertyManagementRouter.patch('/maintenance-requests/:id/status', async (req, res, next) => {
  try {
    const request = await service.updateMaintenanceStatus(req.user.sub, req.params.id, (req.body || {}).status);
    if (!request) return res.status(404).json({ error: 'Maintenance request not found' });
    res.json({ request });
  } catch (err) { next(err); }
});
