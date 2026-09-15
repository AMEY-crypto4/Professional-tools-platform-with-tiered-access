import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/staffAttendance.service.js';

// Public — no requireAuth. Mounted at a more specific path than
// staffAttendanceRouter and BEFORE it in app.js, same ordering reason as
// /api/track and /api/billing/webhook: a broader router's blanket
// `router.use(requireAuth)` would otherwise swallow this request first.
export const staffAttendanceKioskRouter = Router();
staffAttendanceKioskRouter.post('/checkin', async (req, res, next) => {
  try {
    const { token, employeeCode } = req.body || {};
    if (!token || !employeeCode) return res.status(400).json({ error: 'token and employeeCode are required' });
    const result = await service.kioskCheckInOut(token, employeeCode);
    res.json(result);
  } catch (err) { next(err); }
});

export const staffAttendanceRouter = Router();
staffAttendanceRouter.use(requireAuth);

staffAttendanceRouter.get('/kiosk-token', async (req, res, next) => {
  try { res.json({ token: await service.getOrCreateKioskToken(req.user.sub) }); } catch (err) { next(err); }
});
staffAttendanceRouter.post('/kiosk-token/rotate', async (req, res, next) => {
  try { res.json({ token: await service.rotateKioskToken(req.user.sub) }); } catch (err) { next(err); }
});

staffAttendanceRouter.get('/employees', async (req, res, next) => {
  try { res.json({ employees: await service.listEmployees(req.user.sub) }); } catch (err) { next(err); }
});
staffAttendanceRouter.post('/employees', async (req, res, next) => {
  try { res.status(201).json({ employee: await service.createEmployee(req.user, req.body) }); } catch (err) { next(err); }
});
staffAttendanceRouter.delete('/employees/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateEmployee(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Employee not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

staffAttendanceRouter.get('/records', async (req, res, next) => {
  try { res.json({ records: await service.listRecords(req.user.sub, req.query) }); } catch (err) { next(err); }
});
staffAttendanceRouter.post('/records/mark-absent', async (req, res, next) => {
  try {
    const { employeeId, workDate } = req.body || {};
    if (!employeeId || !workDate) return res.status(400).json({ error: 'employeeId and workDate are required' });
    res.json({ record: await service.markAbsent(req.user.sub, employeeId, workDate) });
  } catch (err) { next(err); }
});

staffAttendanceRouter.get('/export.csv', async (req, res, next) => {
  try {
    const csv = await service.exportPayrollCsv(req.user, req.query);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="attendance.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});
