import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as clientsService from '../services/abClients.service.js';
import * as servicesService from '../services/abServices.service.js';
import * as appointmentsService from '../services/abAppointments.service.js';
import { getUsageSummary } from '../services/tiers.service.js';

export const appointmentBookingRouter = Router();
appointmentBookingRouter.use(requireAuth);

appointmentBookingRouter.get('/usage', async (req, res, next) => {
  try {
    const usage = await getUsageSummary(req.user, 'appointment-booking', 'appointments_created', 'max_appointments_per_month');
    res.json({ usage });
  } catch (err) { next(err); }
});

appointmentBookingRouter.get('/clients', async (req, res, next) => {
  try { res.json({ clients: await clientsService.listClients(req.user.sub) }); } catch (err) { next(err); }
});
appointmentBookingRouter.post('/clients', async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });
    res.status(201).json({ client: await clientsService.createClient(req.user.sub, req.body) });
  } catch (err) { next(err); }
});
appointmentBookingRouter.delete('/clients/:id', async (req, res, next) => {
  try {
    const ok = await clientsService.deleteClient(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') return res.status(409).json({ error: 'This client has appointments on file and cannot be deleted.' });
    next(err);
  }
});

appointmentBookingRouter.get('/services', async (req, res, next) => {
  try { res.json({ services: await servicesService.listServices(req.user.sub) }); } catch (err) { next(err); }
});
appointmentBookingRouter.post('/services', async (req, res, next) => {
  try { res.status(201).json({ service: await servicesService.createService(req.user, req.body) }); } catch (err) { next(err); }
});
appointmentBookingRouter.delete('/services/:id', async (req, res, next) => {
  try {
    const ok = await servicesService.deleteService(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Service not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

appointmentBookingRouter.get('/appointments', async (req, res, next) => {
  try { res.json({ appointments: await appointmentsService.listAppointments(req.user.sub, req.query) }); } catch (err) { next(err); }
});
appointmentBookingRouter.post('/appointments', async (req, res, next) => {
  try { res.status(201).json({ appointment: await appointmentsService.createAppointment(req.user, req.body) }); } catch (err) { next(err); }
});
appointmentBookingRouter.patch('/appointments/:id/status', async (req, res, next) => {
  try {
    const appointment = await appointmentsService.updateStatus(req.user.sub, req.params.id, (req.body || {}).status);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ appointment });
  } catch (err) { next(err); }
});
appointmentBookingRouter.delete('/appointments/:id', async (req, res, next) => {
  try {
    const result = await appointmentsService.deleteAppointment(req.user.sub, req.params.id);
    if (!result.ok && result.reason === 'not_found') return res.status(404).json({ error: 'Appointment not found' });
    if (!result.ok && result.reason === 'has_history') return res.status(409).json({ error: 'Completed or no-show appointments cannot be deleted — they are kept as history.' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
