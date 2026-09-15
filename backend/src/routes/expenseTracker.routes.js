import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/expenseTracker.service.js';
import { getUsageSummary } from '../services/tiers.service.js';

export const expenseTrackerRouter = Router();
expenseTrackerRouter.use(requireAuth);

expenseTrackerRouter.get('/usage', async (req, res, next) => {
  try {
    const usage = await getUsageSummary(req.user, 'expense-tracker', 'expenses_created', 'max_expenses_per_month');
    res.json({ usage });
  } catch (err) { next(err); }
});

expenseTrackerRouter.get('/expenses', async (req, res, next) => {
  try { res.json({ expenses: await service.listExpenses(req.user.sub, req.query) }); } catch (err) { next(err); }
});
expenseTrackerRouter.post('/expenses', async (req, res, next) => {
  try { res.status(201).json({ expense: await service.createExpense(req.user, req.body) }); } catch (err) { next(err); }
});
expenseTrackerRouter.delete('/expenses/:id', async (req, res, next) => {
  try {
    const ok = await service.deleteExpense(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Expense not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

expenseTrackerRouter.get('/budgets', async (req, res, next) => {
  try { res.json({ budgets: await service.listBudgets(req.user.sub) }); } catch (err) { next(err); }
});
expenseTrackerRouter.post('/budgets', async (req, res, next) => {
  try { res.status(201).json({ budget: await service.setBudget(req.user, req.body) }); } catch (err) { next(err); }
});

expenseTrackerRouter.get('/summary', async (req, res, next) => {
  try { res.json({ summary: await service.getSummary(req.user, req.query.month) }); } catch (err) { next(err); }
});
