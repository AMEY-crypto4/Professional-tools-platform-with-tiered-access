import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as service from '../services/inventoryManagement.service.js';

export const inventoryManagementRouter = Router();
inventoryManagementRouter.use(requireAuth);

inventoryManagementRouter.get('/products', async (req, res, next) => {
  try { res.json({ products: await service.listProducts(req.user.sub) }); } catch (err) { next(err); }
});
inventoryManagementRouter.get('/products/low-stock', async (req, res, next) => {
  try { res.json({ products: await service.lowStockProducts(req.user.sub) }); } catch (err) { next(err); }
});
inventoryManagementRouter.post('/products', async (req, res, next) => {
  try { res.status(201).json({ product: await service.createProduct(req.user, req.body) }); } catch (err) { next(err); }
});
inventoryManagementRouter.delete('/products/:id', async (req, res, next) => {
  try {
    const ok = await service.deactivateProduct(req.user.sub, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});
inventoryManagementRouter.get('/products/:id/movements', async (req, res, next) => {
  try { res.json({ movements: await service.listMovements(req.user.sub, req.params.id) }); } catch (err) { next(err); }
});
inventoryManagementRouter.post('/products/:id/adjust', async (req, res, next) => {
  try { res.json({ product: await service.adjustStock(req.user.sub, req.params.id, req.body) }); } catch (err) { next(err); }
});
