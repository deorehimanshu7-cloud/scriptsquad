import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { authenticate, AuthRequest } from '../middleware/auth';
import { createUser, findUserByEmail, findUserById, updateUserLanguage, toPublicUser } from '../data/users';
import { verifyPassword } from '../database/sqlite';
import { dbRun, dbGet } from '../data/db';
import { audit } from '../data/system';

const router = Router();
const ACCESS_TTL = 3600; // seconds

function signTokens(user: { id: string; email: string }) {
  const access_token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: '1h' });
  const refresh_token = jwt.sign({ id: user.id, email: user.email, type: 'refresh' }, process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret', { expiresIn: '7d' });
  return { access_token, refresh_token, expires_in: ACCESS_TTL, token_type: 'Bearer' as const };
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function persistRefreshToken(userId: string, refreshToken: string): Promise<void> {
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  await dbRun(`INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES ($1,$2,$3,$4)`,
    [uuidv4(), userId, hashToken(refreshToken), expires]);
}

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, name, language } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Email and password are required' } });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Password must be at least 8 characters' } });
    }
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'A user with this email already exists' } });
    }
    const user = await createUser({ email, password, name, language });
    const tokens = signTokens(user);
    await persistRefreshToken(user.id, tokens.refresh_token);
    await audit({ userId: user.id, action: 'AUTH_REGISTER', entityType: 'user', entityId: user.id, requestId: (req.headers['x-request-id'] as string) || undefined });
    res.status(201).json({ success: true, data: { user, tokens } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Email and password are required' } });
    }
    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } });
    }
    const tokens = signTokens(user);
    await persistRefreshToken(user.id, tokens.refresh_token);
    await audit({ userId: user.id, action: 'AUTH_LOGIN', entityType: 'user', entityId: user.id, requestId: (req.headers['x-request-id'] as string) || undefined });
    res.json({ success: true, data: { user: toPublicUser(user), tokens } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  try {
    const { refresh_token } = req.body || {};
    if (!refresh_token) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Refresh token is required' } });
    const decoded = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret') as { id: string; type?: string };
    if (decoded.type !== 'refresh') return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid refresh token' } });
    const stored = await dbGet(`SELECT user_id FROM refresh_tokens WHERE user_id = $1 AND token_hash = $2 AND expires_at > $3`,
      [decoded.id, hashToken(refresh_token), new Date().toISOString()]);
    if (!stored) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Refresh token expired or revoked' } });
    const user = await findUserById(decoded.id);
    if (!user) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not found' } });
    // rotate: revoke used token, issue new pair
    await dbRun(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hashToken(refresh_token)]);
    const tokens = signTokens(user);
    await persistRefreshToken(user.id, tokens.refresh_token);
    res.json({ success: true, data: { user: toPublicUser(user), tokens } });
  } catch (error: any) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid refresh token' } });
  }
});

router.post('/logout', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { refresh_token } = req.body || {};
    if (refresh_token) {
      await dbRun(`DELETE FROM refresh_tokens WHERE token_hash = $1`, [hashToken(refresh_token)]);
    }
    await audit({ userId: req.user!.id, action: 'AUTH_LOGOUT', requestId: (req.headers['x-request-id'] as string) || undefined });
    res.json({ success: true, message: 'Logged out successfully' });
  } catch {
    res.json({ success: true, message: 'Logged out successfully' });
  }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const user = await findUserById(req.user!.id);
  if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
  res.json({ success: true, data: { ...toPublicUser(user), created_at: user.created_at } });
});

router.patch('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const { language } = req.body || {};
  if (language && ['en', 'hi', 'mr'].includes(language)) {
    await updateUserLanguage(req.user!.id, language);
  }
  const user = await findUserById(req.user!.id);
  res.json({ success: true, data: user ? { ...toPublicUser(user), created_at: user.created_at } : null });
});

export default router;
