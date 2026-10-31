import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnv(file: string) {
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env */ }
}
loadEnv(path.join(ROOT, '.env'));

export const PORT = Number(process.env.PORT) || 3000;
export const TZ = process.env.APP_TIMEZONE || 'Asia/Kolkata';
export const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
export const FILES = path.join(DATA, 'files');
export const RECIPS = path.join(DATA, 'recipients');
for (const d of [DATA, FILES, RECIPS]) fs.mkdirSync(d, { recursive: true });

export const SECRET = (() => {
  const f = path.join(DATA, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, s);
    return s;
  }
})();

export const uid = () => crypto.randomBytes(6).toString('hex');
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
export const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]{2,}$/;
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
export const hmac = (s: string) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const sha = (s: string) => crypto.createHash('sha256').update(String(s)).digest();
export const safeEq = (a: string, b: string) => crypto.timingSafeEqual(sha(a), sha(b));
export interface HttpError extends Error { status: number }
export const fail = (msg: string, status = 400): HttpError => Object.assign(new Error(msg), { status });
export const str = (v: unknown) => String(v ?? '').trim();
export const clampInt = (v: unknown, min: number, max: number, def: number) => {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
