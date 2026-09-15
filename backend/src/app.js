import express from 'express';
import cors from 'cors';
import 'dotenv/config';

import { authRouter } from './routes/auth.routes.js';
import { toolsRouter } from './routes/tools.routes.js';
import { billingRouter, stripeWebhookHandler, razorpayWebhookHandler } from './routes/billing.routes.js';
import { igClientsRouter } from './routes/igClients.routes.js';
import { igInvoicesRouter } from './routes/igInvoices.routes.js';
import { appointmentBookingRouter } from './routes/appointmentBooking.routes.js';
import { expenseTrackerRouter } from './routes/expenseTracker.routes.js';
import { membershipManagementRouter } from './routes/membershipManagement.routes.js';
import { leaveManagementRouter } from './routes/leaveManagement.routes.js';
import { inventoryManagementRouter } from './routes/inventoryManagement.routes.js';
import { staffAttendanceRouter, staffAttendanceKioskRouter } from './routes/staffAttendance.routes.js';
import { propertyManagementRouter } from './routes/propertyManagement.routes.js';
import { queueManagementRouter, queueManagementPublicRouter } from './routes/queueManagement.routes.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const app = express();

const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'aa-creations-backend' }));

// Mounted BEFORE express.json() with their own raw-body parser: both
// providers sign the exact raw request bytes, and express.json() below
// would already have parsed (and thereby altered) the body by the time a
// normally-registered route saw it, breaking signature verification. Any
// route needing to run ahead of a blanket-applied middleware — raw body
// parsing here, skipping auth for the public kiosk/join routers below —
// has to be registered before it; Express matches app.use() in
// registration order, not by path specificity.
app.post('/api/billing/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);
app.post('/api/billing/webhook/razorpay', express.raw({ type: 'application/json' }), razorpayWebhookHandler);

app.use(express.json());

app.use('/api/auth', authRouter);
app.use('/api/tools', toolsRouter);
app.use('/api/billing', billingRouter);
app.use('/api/invoice-generator/clients', igClientsRouter);
app.use('/api/invoice-generator/invoices', igInvoicesRouter);
app.use('/api/appointment-booking', appointmentBookingRouter);
app.use('/api/expense-tracker', expenseTrackerRouter);
app.use('/api/membership-management', membershipManagementRouter);
app.use('/api/leave-management', leaveManagementRouter);
app.use('/api/inventory-management', inventoryManagementRouter);
// Public kiosk/join routers mounted at a more specific path BEFORE their
// protected counterpart — same route-ordering reason as /api/billing/webhook
// above: the protected router's blanket requireAuth would otherwise swallow
// these first, since Express matches app.use() by registration order.
app.use('/api/staff-attendance/kiosk', staffAttendanceKioskRouter);
app.use('/api/staff-attendance', staffAttendanceRouter);
app.use('/api/property-management', propertyManagementRouter);
app.use('/api/queue-management/public', queueManagementPublicRouter);
app.use('/api/queue-management', queueManagementRouter);

app.use(notFoundHandler);
app.use(errorHandler);
