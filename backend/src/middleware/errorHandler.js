// Centralized error handling — every route calls next(err) on failure instead
// of formatting its own error response, so the shape of an error is
// consistent everywhere, including the tier-limit errors thrown by
// services/tiers.service.js (err.status = 402, err.code = 'TIER_LIMIT_REACHED').
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', err);
  }
  res.status(status).json({ error: err.message || 'Internal server error', code: err.code });
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: `No route: ${req.method} ${req.originalUrl}` });
}
