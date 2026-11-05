import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { fail, hmac, safeEq, str, uid } from './util.js';
import { db, markDirty, type AuditEntry, type Role, type User } from './store.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, o: crypto.ScryptOptions) => Promise<Buffer>;

/* ---------------- passwords ---------------- */
const N = 16384;
export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64')}$${h.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = await scrypt(pw, Buffer.from(salt, 'base64'), 64, { N: Number(n), r: 8, p: 1 });
  const want = Buffer.from(hash, 'base64');
  return h.length === want.length && crypto.timingSafeEqual(h, want);
}
const DUMMY = await hashPassword('dummy-password-for-timing');
export const MIN_PASSWORD = 10;
export function checkPasswordStrength(pw: string) {
  if (pw.length < MIN_PASSWORD) throw fail(`Password must be at least ${MIN_PASSWORD} characters.`);
}

/* ---------------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf: Buffer): string {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function unbase32(s: string): Buffer {
  let bits = 0, val = 0; const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export function totpAt(secret: string, counter: number): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  const c = Math.floor(now / 30000), given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  return [-1, 0, 1].some((d) => safeEq(totpAt(secret, c + d), given));
}
export const newTotpSecret = () => base32(crypto.randomBytes(20));
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export function newRecoveryCodes(): { plain: string[]; hashed: string[] } {
  const plain = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
  return { plain, hashed: plain.map(sha) };
}

/* ---------------- sessions ---------------- */
export const COOKIE = '__session'; // the only cookie name some reverse proxies (e.g. Firebase Hosting) forward
const SESSION_DAYS = 14;
const sign = (u: User, exp: number) => `${u.id}.${u.sessionVersion}.${exp}`;
export function sessionCookie(u: User, secure: boolean): string {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const base = sign(u, exp);
  return `${COOKIE}=${base}.${hmac('s' + base)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
}
export const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function cookies(req: Request) {
  const out: Record<string, string> = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
export function userFromRequest(req: Request): User | null {
  const v = cookies(req)[COOKIE];
  if (!v) return null;
  const [id, ver, exp, sig] = v.split('.');
  if (!id || !ver || !exp || !sig || Number(exp) < Date.now()) return null;
  if (!safeEq(sig, hmac(`s${id}.${ver}.${exp}`))) return null;
  const u = db.users.find((x) => x.id === id);
  return u && !u.disabled && u.sessionVersion === Number(ver) ? u : null;
}

declare global { // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: User } }
}

export const publicUser = (u: User) => ({ id: u.id, username: u.username, name: u.name, role: u.role, totpEnabled: !!u.totpEnabled, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, disabled: !!u.disabled });

/* ---------------- role policy ---------------- */
/** viewer: read only. operator: campaigns, inbox, agent, do-not-send list and mailbox tests. admin: everything. */
export function allowed(role: Role, method: string, path: string): boolean {
  if (role === 'admin') return true;
  if (/^\/(users|audit)(\/|$)/.test(path)) return false;
  if (role === 'viewer' && /^\/mail(\/|$)/.test(path)) return false; // private mail content
  if (method === 'GET' || method === 'HEAD') return true;
  if (/^\/account(\/|$)/.test(path) || path === '/logout') return true; // own password and 2FA
  if (role === 'viewer') return false;
  return /^\/(campaigns|inbox|agent|suppress|mail|contacts|knowledge|handoff)(\/|$)/.test(path) || /^\/mailboxes\/[^/]+\/(test|dns)$/.test(path);
}

export function requireUser(req: Request, res: Response, next: NextFunction) {
  const u = userFromRequest(req);
  if (!u) return void res.status(401).json({ error: 'Not logged in' });
  if (req.method !== 'GET' && req.get('x-nm') !== '1') return void res.status(403).json({ error: 'Bad request' });
  if (!allowed(u.role, req.method, req.path)) return void res.status(403).json({ error: `Your role (${u.role}) cannot do this. Ask an admin.` });
  req.user = u;
  next();
}

/* ---------------- audit log ---------------- */
export function audit(e: Omit<AuditEntry, 'id' | 'at'>) {
  db.audit.unshift({ id: uid(), at: new Date().toISOString(), ...e });
  if (db.audit.length > 2000) db.audit.length = 2000;
  markDirty();
}
const QUIET = /^\/inbox\/[^/]+\/read$/;
/** Logs every state-changing request (never bodies, so no secrets) and every denied one. */
export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  const path = req.path; // captured now: Express restores req.url after the router mount, which would add the /api prefix
  res.on('finish', () => {
    if (req.method === 'GET' || path === '/login' || QUIET.test(path)) return;
    if (res.statusCode >= 400 && res.statusCode !== 403) return;
    const u = req.user;
    audit({ user: u?.username ?? '?', role: u?.role ?? '?', method: req.method, path, status: res.statusCode, ip: req.ip || '' });
  });
  next();
}

/* ---------------- login throttling ---------------- */
const fails = new Map<string, { n: number; t: number }>();
export function throttled(key: string): boolean {
  const f = fails.get(key);
  if (!f) return false;
  if (Date.now() - f.t > 15 * 60000) { fails.delete(key); return false; }
  return f.n >= 10;
}
export function recordFail(key: string) { const f = fails.get(key) ?? { n: 0, t: Date.now() }; f.n++; fails.set(key, f); }
export const clearFails = (key: string) => { fails.delete(key); };

/* ---------------- bootstrap ---------------- */
/** First start creates the admin from ADMIN_PASSWORD. RESET_ADMIN=true re-sets that admin's password (lock-out recovery). */
export async function bootstrapAdmin(password: string) {
  const admin = db.users.find((u) => u.username === 'admin');
  if (!db.users.length) {
    db.users.push({ id: uid(), username: 'admin', name: 'Administrator', role: 'admin', passHash: await hashPassword(password), sessionVersion: 1, createdAt: new Date().toISOString() });
    markDirty();
    console.log('Created the first user "admin" from ADMIN_PASSWORD. You can change it under Team & Security.');
  } else if (process.env.RESET_ADMIN === 'true' && admin) {
    admin.passHash = await hashPassword(password); admin.sessionVersion++; admin.totpEnabled = false; admin.totpSecret = undefined; admin.disabled = false;
    markDirty();
    console.log('RESET_ADMIN=true: admin password reset from ADMIN_PASSWORD and 2FA turned off. Remove RESET_ADMIN now.');
  }
}

export { DUMMY, sha, str };
