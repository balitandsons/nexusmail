import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PORT, ROOT, esc, hmac, safeEq, str } from './util.js';
import { markDirty, suppressSet } from './store.js';
import { parseUnsub } from './engine/template.js';
import { bootQueue } from './engine/queue.js';
import { startImapPolling } from './channels.js';
import { processInbound } from './agent.js';
import api from './routes/api.js';
import { inboxRouter, webhookRouter } from './routes/omni.js';
import agentRouter from './routes/agent.js';

let PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!PASSWORD || PASSWORD === 'change-me-to-something-long') {
  PASSWORD = crypto.randomBytes(9).toString('base64url');
  fs.appendFileSync(path.join(ROOT, '.env'), `\nADMIN_PASSWORD=${PASSWORD}\n`);
  console.log(`\n  No ADMIN_PASSWORD was set. Generated one and saved it to .env:\n\n     ${PASSWORD}\n`);
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => void res.json({ ok: true }));
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((_req, res, next) => { res.set('X-Frame-Options', 'DENY'); res.set('Referrer-Policy', 'same-origin'); next(); });

// Public, signature/token-verified webhooks need the raw body, so they mount before the JSON parser.
app.use(webhookRouter);
app.use(express.json({ limit: '30mb' }));
app.use(express.urlencoded({ extended: false }));

/* public unsubscribe pages */
function unsubPage(title: string, msg: string, form = '') {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font-family:system-ui,Arial,sans-serif;background:#f4f6f5;display:grid;place-items:center;min-height:100vh;margin:0">
<div style="background:#fff;border:1px solid #e3e8e5;border-radius:12px;padding:32px;max-width:420px;text-align:center"><h2 style="margin-top:0">${title}</h2><p style="color:#555">${msg}</p>${form}</div></body>`;
}
app.get('/u/:token', (req, res) => {
  const email = parseUnsub(req.params.token);
  if (!email) return void res.status(400).send(unsubPage('Invalid link', 'This unsubscribe link is not valid.'));
  if (suppressSet.has(email)) return void res.send(unsubPage('Unsubscribed', `${esc(email)} will not receive further emails from us.`));
  res.send(unsubPage('Unsubscribe', `Stop sending emails to <b>${esc(email)}</b>?`,
    `<form method="post"><button style="background:#6366f1;color:#fff;border:0;padding:10px 20px;border-radius:8px;font-size:15px;cursor:pointer">Unsubscribe</button></form>`));
});
app.post('/u/:token', (req, res) => {
  const email = parseUnsub(req.params.token);
  if (!email) return void res.status(400).send(unsubPage('Invalid link', 'This unsubscribe link is not valid.'));
  if (!suppressSet.has(email)) { suppressSet.add(email); markDirty(); console.log(`Unsubscribed: ${email}`); }
  res.send(unsubPage('Unsubscribed', `${esc(email)} has been removed. You won't receive further emails from us.`));
});

/* auth */
const COOKIE = 'nm_session';
const SESSION_DAYS = 14;
function cookies(req: Request) {
  const out: Record<string, string> = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function isAuthed(req: Request) {
  const v = cookies(req)[COOKIE];
  if (!v) return false;
  const [exp, sig] = v.split('.');
  return !!sig && Number(exp) > Date.now() && safeEq(sig, hmac('s' + exp));
}
const loginFails = new Map<string, { n: number; t: number }>();
app.post('/api/login', (req, res) => {
  const ip = req.ip || '';
  const f = loginFails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 10) return void res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!safeEq(str(req.body?.password), PASSWORD)) { f.n++; loginFails.set(ip, f); return void res.status(401).json({ error: 'Wrong password.' }); }
  loginFails.delete(ip);
  const exp = Date.now() + SESSION_DAYS * 86400000;
  res.set('Set-Cookie', `${COOKIE}=${exp}.${hmac('s' + exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (_req, res) => { res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`); res.json({ ok: true }); });
app.use('/api', (req, res, next) => {
  if (!isAuthed(req)) return void res.status(401).json({ error: 'Not logged in' });
  if (req.method !== 'GET' && req.get('x-nm') !== '1') return void res.status(403).json({ error: 'Bad request' });
  next();
});
app.get('/api/me', (_req, res) => res.json({ ok: true }));
app.use('/api', api);
app.use('/api', inboxRouter);
app.use('/api', agentRouter);

/* static client */
const DIST = path.join(ROOT, 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  app.get(/^\/(?!api|u\/|webhooks).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
}
app.use((err: Error & { status?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) =>
  res.status(err.status || 400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 25 MB each).' : err.message }));

bootQueue(process.env.RESUME_ON_START !== 'false');
startImapPolling(processInbound);

app.listen(PORT, '0.0.0.0', () => console.log(`NexusMail running → http://localhost:${PORT}${fs.existsSync(DIST) ? '' : '  (API only — run "npm run dev" for the UI, or "npm run build" first)'}`));
