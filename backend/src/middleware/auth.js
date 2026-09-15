import { verifyToken } from '../utils/jwt.js';

// Verifies the Bearer token and attaches the authenticated user's identity to
// req.user. Route handlers read the user id from here (req.user.sub), never
// from anything the client sent in the body/query — that's what keeps one
// account from ever touching another account's rows.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  try {
    const payload = verifyToken(token);
    req.user = payload; // { sub, email, displayName, isOwner }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
