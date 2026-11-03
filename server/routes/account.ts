import { Router } from 'express';
import { fail, str, uid } from '../util.js';
import { db, markDirty, type Role, type User } from '../store.js';
import {
  DUMMY, audit, base32, checkPasswordStrength, clearCookie, clearFails, hashPassword, newRecoveryCodes, newTotpSecret, publicUser,
  recordFail, sessionCookie, sha, throttled, verifyPassword, verifyTotp,
} from '../auth.js';
import { h } from './api.js';

const ROLES: Role[] = ['admin', 'operator', 'viewer'];

/* ---------- public: login / logout ---------- */
export const authRouter = Router();
authRouter.post('/api/login', h(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const username = str(req.body?.username || 'admin').toLowerCase();
  const ip = req.ip || '';
  const keys = ['ip:' + ip, 'u:' + username];
  if (keys.some(throttled)) throw fail('Too many attempts. Try again in 15 minutes.', 429);
  const u = db.users.find((x) => x.username === username);
  const ok = await verifyPassword(String(req.body?.password ?? ''), u ? u.passHash : DUMMY);
  const bad = (why: string) => { keys.forEach(recordFail); audit({ user: username, role: '?', method: 'POST', path: '/login', status: 401, ip, note: why }); return fail('Wrong username or password.', 401); };
  if (!u || !ok || u.disabled) throw bad(u?.disabled ? 'disabled account' : 'bad password');
  if (u.totpEnabled && u.totpSecret) {
    const code = str(req.body?.code);
    if (!code) return void res.status(401).json({ error: 'Enter the 6-digit code from your authenticator app.', needs2fa: true });
    const rec = u.recovery?.indexOf(sha(code.toLowerCase().replace(/\s/g, ''))) ?? -1;
    if (verifyTotp(u.totpSecret, code)) { /* ok */ }
    else if (rec >= 0) { u.recovery!.splice(rec, 1); }
    else throw bad('bad 2FA code');
  }
  keys.forEach(clearFails);
  u.lastLoginAt = new Date().toISOString(); markDirty();
  audit({ user: u.username, role: u.role, method: 'POST', path: '/login', status: 200, ip });
  res.set('Set-Cookie', sessionCookie(u, req.secure));
  res.json({ ok: true, user: publicUser(u) });
}));
authRouter.post('/api/logout', (_req, res) => { res.set('Set-Cookie', clearCookie); res.json({ ok: true }); });

/* ---------- authenticated ---------- */
const router = Router();
router.get('/me', (req, res) => res.json({ ok: true, user: publicUser(req.user!) }));

router.post('/account/password', h(async (req, res) => {
  const u = req.user!;
  if (!(await verifyPassword(String(req.body?.current ?? ''), u.passHash))) throw fail('Current password is wrong.', 403);
  const next = String(req.body?.next ?? '');
  checkPasswordStrength(next);
  u.passHash = await hashPassword(next); u.sessionVersion++; markDirty();
  res.set('Set-Cookie', sessionCookie(u, req.secure)); // keep this session, drop all others
  res.json({ ok: true });
}));

router.post('/account/2fa/setup', h((req, res) => {
  const u = req.user!;
  if (u.totpEnabled) throw fail('2FA is already on. Turn it off first to set it up again.', 409);
  u.totpPending = newTotpSecret(); markDirty();
  const label = encodeURIComponent(`NexusMail:${u.username}`);
  res.json({ secret: u.totpPending, uri: `otpauth://totp/${label}?secret=${u.totpPending}&issuer=NexusMail&digits=6&period=30` });
}));
router.post('/account/2fa/enable', h((req, res) => {
  const u = req.user!;
  if (!u.totpPending) throw fail('Start the setup first.', 409);
  if (!verifyTotp(u.totpPending, str(req.body?.code))) throw fail('That code is not right. Check the time on your phone and try again.', 400);
  const codes = newRecoveryCodes();
  u.totpSecret = u.totpPending; u.totpPending = undefined; u.totpEnabled = true; u.recovery = codes.hashed; markDirty();
  res.json({ ok: true, recoveryCodes: codes.plain });
}));
router.post('/account/2fa/disable', h(async (req, res) => {
  const u = req.user!;
  if (!u.totpEnabled || !u.totpSecret) throw fail('2FA is not on.', 409);
  if (!(await verifyPassword(String(req.body?.password ?? ''), u.passHash))) throw fail('Password is wrong.', 403);
  if (!verifyTotp(u.totpSecret, str(req.body?.code))) throw fail('That code is not right.', 400);
  u.totpEnabled = false; u.totpSecret = undefined; u.recovery = undefined; markDirty();
  res.json({ ok: true });
}));

/* ---------- admin: users + audit (role gate in auth.allowed) ---------- */
const activeAdmins = () => db.users.filter((u) => u.role === 'admin' && !u.disabled);
function getUser(id: string): User {
  const u = db.users.find((x) => x.id === id);
  if (!u) throw fail('User not found', 404);
  return u;
}
router.get('/users', (_req, res) => res.json(db.users.map(publicUser)));
router.post('/users', h(async (req, res) => {
  const username = str(req.body?.username).toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw fail('Username: 3-32 letters, numbers, dot, dash or underscore.');
  if (db.users.some((u) => u.username === username)) throw fail('That username is taken.', 409);
  if (!ROLES.includes(req.body?.role)) throw fail('Pick a role.');
  const pw = String(req.body?.password ?? '');
  checkPasswordStrength(pw);
  const u: User = { id: uid(), username, name: str(req.body?.name) || username, role: req.body.role, passHash: await hashPassword(pw), sessionVersion: 1, createdAt: new Date().toISOString() };
  db.users.push(u); markDirty(); res.json(publicUser(u));
}));
router.put('/users/:id', h(async (req, res) => {
  const u = getUser(String(req.params.id)), b = req.body || {};
  const wasAdmin = u.role === 'admin' && !u.disabled;
  if (b.name !== undefined) u.name = str(b.name) || u.username;
  if (b.role !== undefined) { if (!ROLES.includes(b.role)) throw fail('Unknown role.'); u.role = b.role; }
  if (b.disabled !== undefined) u.disabled = !!b.disabled;
  if (wasAdmin && !(u.role === 'admin' && !u.disabled) && activeAdmins().length === 0) { u.role = 'admin'; u.disabled = false; throw fail('There must be at least one active admin.', 409); }
  if (b.password) { checkPasswordStrength(String(b.password)); u.passHash = await hashPassword(String(b.password)); u.sessionVersion++; }
  if (b.resetTotp) { u.totpEnabled = false; u.totpSecret = undefined; u.totpPending = undefined; u.recovery = undefined; }
  if (b.disabled || b.role !== undefined) u.sessionVersion++; // apply role/disable changes immediately
  markDirty(); res.json(publicUser(u));
}));
router.delete('/users/:id', h((req, res) => {
  const u = getUser(String(req.params.id));
  if (u.id === req.user!.id) throw fail('You cannot delete your own account.', 409);
  if (u.role === 'admin' && !u.disabled && activeAdmins().length <= 1) throw fail('There must be at least one active admin.', 409);
  db.users = db.users.filter((x) => x !== u); markDirty(); res.json({ ok: true });
}));
router.get('/audit', (req, res) => {
  const n = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  res.json(db.audit.slice(0, n));
});

export { base32 };
export default router;
