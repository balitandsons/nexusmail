import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PORT, ROOT, esc } from './util.js';
import { db, markDirty, suppressSet } from './store.js';
import { auditMiddleware, bootstrapAdmin, requireUser } from './auth.js';
import accountRouter, { authRouter } from './routes/account.js';
import { parseUnsub } from './engine/template.js';
import { active, bootQueue } from './engine/queue.js';
import { markUnsubscribed } from './engine/bounces.js';
import { startImapPolling } from './channels.js';
import { processInbound } from './agent.js';
import api from './routes/api.js';
import { inboxRouter, webhookRouter } from './routes/omni.js';
import agentRouter from './routes/agent.js';
import mailRouter from './routes/mail.js';
import statsRouter from './routes/stats.js';
import crmRouter from './routes/crm.js';
import { backfillContacts } from './crm.js';

let PASSWORD = process.env.ADMIN_PASSWORD || '';
if (!db.users.length && (!PASSWORD || PASSWORD === 'change-me-to-something-long')) {
  PASSWORD = crypto.randomBytes(9).toString('base64url');
  try { fs.appendFileSync(path.join(ROOT, '.env'), `\nADMIN_PASSWORD=${PASSWORD}\n`); } catch { /* read-only host */ }
  console.log(`\n  No ADMIN_PASSWORD was set. Generated one for the user "admin":\n\n     ${PASSWORD}\n`);
}
await bootstrapAdmin(PASSWORD);
if (!db.contacts.length) { const n = backfillContacts(); if (n) console.log(`CRM: created ${n} contacts from existing campaigns and conversations.`); }

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => void res.json({ ok: true, uptimeSec: Math.round(process.uptime()), sending: active ? active.cid : null }));
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Frame-Options', 'DENY'); res.set('Referrer-Policy', 'same-origin'); res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

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
  markUnsubscribed(email);
  res.send(unsubPage('Unsubscribed', `${esc(email)} has been removed. You won't receive further emails from us.`));
});

/* auth: public login/logout, then every other /api route needs a valid session and an allowed role */
app.use(authRouter);
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
app.use('/api', requireUser, auditMiddleware);
app.use('/api', accountRouter);
app.use('/api', api);
app.use('/api', inboxRouter);
app.use('/api', agentRouter);
app.use('/api', mailRouter);
app.use('/api', statsRouter);
app.use('/api', crmRouter);

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
