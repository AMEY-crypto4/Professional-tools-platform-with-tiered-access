import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db/pool.js';
import { signToken } from '../utils/jwt.js';
import { requireAuth } from '../middleware/auth.js';

export const authRouter = Router();

const OWNER_EMAILS = new Set(
  (process.env.OWNER_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function tokenPayloadFor(user) {
  return {
    sub: user.id,
    email: user.email,
    displayName: user.display_name,
    companyName: user.company_name,
    isOwner: user.is_owner,
  };
}

async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE lower(email) = lower($1) AND active = TRUE',
    [email]
  );
  return rows[0] ?? null;
}

// Open sign-up — this is a public SaaS product, not an internal tool, so
// there's no invite-code gate. Any email in OWNER_EMAILS is auto-flagged as
// an owner account (unlimited access to every tool) at signup time.
authRouter.post('/signup', async (req, res, next) => {
  try {
    const { email, password, displayName, companyName } = req.body || {};
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: 'email, password, and displayName are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const isOwner = OWNER_EMAILS.has(email.trim().toLowerCase());
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, company_name, is_owner)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [email.trim().toLowerCase(), passwordHash, displayName, companyName || null, isOwner]
    );

    const payload = tokenPayloadFor(rows[0]);
    const token = signToken(payload);
    res.status(201).json({ token, user: payload });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    next(err);
  }
});

authRouter.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Re-check OWNER_EMAILS on every login so adding an email to that env
    // var upgrades an existing account the next time it signs in, with no
    // manual DB edit needed.
    const shouldBeOwner = OWNER_EMAILS.has(user.email.toLowerCase());
    if (shouldBeOwner && !user.is_owner) {
      await pool.query('UPDATE users SET is_owner = TRUE WHERE id = $1', [user.id]);
      user.is_owner = true;
    }

    const payload = tokenPayloadFor(user);
    const token = signToken(payload);
    res.json({ token, user: payload });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.sub]);
    const user = rows[0];
    const ok = await bcrypt.compare(currentPassword, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.sub]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

authRouter.patch('/profile', requireAuth, async (req, res, next) => {
  try {
    const { displayName, companyName } = req.body || {};
    const { rows } = await pool.query(
      `UPDATE users SET display_name = COALESCE($1, display_name), company_name = COALESCE($2, company_name)
       WHERE id = $3 RETURNING *`,
      [displayName || null, companyName ?? null, req.user.sub]
    );
    const payload = tokenPayloadFor(rows[0]);
    res.json({ user: payload });
  } catch (err) {
    next(err);
  }
});
