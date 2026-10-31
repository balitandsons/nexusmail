import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { EMAIL_RE, FILES, clampInt, fail, today, uid, str } from '../util.js';
import { db, dropRecips, markDirty, recips, setRecips, suppressSet, type Account, type Campaign, type Provider } from '../store.js';
import { TYPES, ZEPTO_REGIONS, checkDns, isSmtp, sendVia, testAccount } from '../engine/transports.js';
import { accName, campaignAccounts, healthLabel, healthScore, leftToday, newStats, sentToday } from '../engine/balancer.js';
import { buildMessage, loadAttachments, parseRecipients } from '../engine/template.js';
import { active, getCampaign, getLogs, log, pauseCampaign, runs, startCampaign, stats } from '../engine/queue.js';
import { IMAP_DEFAULTS, imapStatus } from '../channels.js';

export const h = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
  Promise.resolve().then(() => fn(req, res)).catch((e: Error & { status?: number }) => {
    if (e.status === undefined || e.status >= 500) console.error(e);
    if (!res.headersSent) res.status(e.status && e.status >= 400 ? e.status : 500).json({ error: e.message });
  });
};

const router = Router();

/* ---------------- mailboxes ---------------- */
const PRESETS: Record<string, { host: string; port: number; secure: boolean }> = { hostinger: { host: 'smtp.hostinger.com', port: 465, secure: true } };

function publicAccount(a: Account) {
  const { apiKey, pass, ...rest } = a;
  const score = healthScore(a);
  return {
    ...rest, provider: TYPES[a.type], sentToday: sentToday(a), health: score, healthLabel: healthLabel(score),
    resting: a.stats.restUntil > Date.now(),
    apiKeyHint: apiKey ? '••••' + apiKey.slice(-4) : '', hasPass: !!pass,
    imapStatus: imapStatus(a.id) || null,
  };
}
function cleanAccount(b: Record<string, any>, old?: Account): Account {
  const t = b.type as Provider;
  if (!TYPES[t]) throw fail('Unknown provider');
  const preset = PRESETS[t];
  const a: Account = {
    id: old ? old.id : uid(), type: t,
    label: str(b.label), fromName: str(b.fromName), fromEmail: str(b.fromEmail).toLowerCase(), replyTo: str(b.replyTo),
    limit: clampInt(b.limit, 1, 1000000, 100),
    enabled: old ? old.enabled : true,
    daily: old?.daily, stats: old?.stats ?? newStats(), dns: old?.dns, imap: old?.imap,
  };
  if (t === 'brevo' || t === 'zepto') a.apiKey = str(b.apiKey) || (old && old.type === t ? old.apiKey : '');
  if (t === 'zepto') a.region = ZEPTO_REGIONS.includes(b.region) ? b.region : 'in';
  if (isSmtp(a)) {
    a.host = str(b.host) || preset?.host || '';
    a.port = clampInt(b.port, 1, 65535, preset?.port ?? 465);
    a.secure = b.secure === undefined ? (preset?.secure ?? a.port === 465) : !!b.secure;
    a.user = str(b.user) || (old && isSmtp(old) ? old.user : '') || a.fromEmail;
    a.pass = b.pass ? String(b.pass) : (old && isSmtp(old) ? old.pass : '');
    const im = b.imap as { enabled?: boolean; host?: string; port?: number } | undefined;
    if (im) {
      const d = IMAP_DEFAULTS[t] ?? { host: '', port: 993, secure: true };
      a.imap = { enabled: !!im.enabled, host: str(im.host) || d.host, port: clampInt(im.port, 1, 65535, d.port), secure: true };
    }
  }
  if (!EMAIL_RE.test(a.fromEmail)) throw fail('Enter a valid From email.');
  if (a.replyTo && !EMAIL_RE.test(a.replyTo)) throw fail('Reply-to must be a valid email.');
  if ((t === 'brevo' || t === 'zepto') && !a.apiKey) throw fail('API key / token is required.');
  if (isSmtp(a) && (!a.host || !a.pass)) throw fail('SMTP host and password are required.');
  return a;
}
const noEditWhileSending = () => { if (active) throw fail('Pause sending before changing mailboxes.', 409); };
const getAccount = (id: string) => {
  const a = db.accounts.find((x) => x.id === id);
  if (!a) throw fail('Mailbox not found', 404);
  return a;
};

router.get('/mailboxes', (_req, res) => res.json(db.accounts.map(publicAccount)));
router.post('/mailboxes', h((req, res) => { noEditWhileSending(); const a = cleanAccount(req.body || {}); db.accounts.push(a); markDirty(); res.json(publicAccount(a)); }));
router.put('/mailboxes/:id', h((req, res) => {
  noEditWhileSending();
  const old = getAccount(String(req.params.id));
  const a = cleanAccount({ ...req.body, type: old.type }, old);
  if (typeof req.body?.enabled === 'boolean') a.enabled = req.body.enabled;
  db.accounts[db.accounts.indexOf(old)] = a; markDirty(); res.json(publicAccount(a));
}));
router.delete('/mailboxes/:id', h((req, res) => {
  noEditWhileSending();
  const a = getAccount(String(req.params.id));
  db.accounts = db.accounts.filter((x) => x !== a);
  db.campaigns.forEach((c) => { c.accountIds = c.accountIds.filter((i) => i !== a.id); });
  markDirty(); res.json({ ok: true });
}));
router.post('/mailboxes/:id/test', h(async (req, res) => {
  const a = getAccount(String(req.params.id));
  try {
    const message = await testAccount(a);
    const to = str(req.body?.to) || db.settings.testEmail;
    let sentTo = '';
    if (to && EMAIL_RE.test(to) && req.body?.sendEmail) {
      const html = '<p>This is a test email from NexusMail confirming this mailbox can send.</p>';
      await sendVia(a, { to, toName: '', subject: 'NexusMail mailbox test', html, text: 'NexusMail mailbox test', attachments: [], headers: {} });
      sentTo = to;
    }
    if (db.settings.mode === 'live' && a.stats.consecutive) { a.stats.consecutive = 0; markDirty(); }
    res.json({ ok: true, message, sentTo, mode: db.settings.mode });
  } catch (e) {
    throw fail((e as Error).message, 422);
  }
}));
router.post('/mailboxes/:id/dns', h(async (req, res) => {
  const a = getAccount(String(req.params.id));
  a.dns = await checkDns(a.fromEmail); markDirty(); res.json(a.dns);
}));

/* ---------------- settings + suppression ---------------- */
const publicSettings = () => {
  const s = db.settings;
  return {
    ...s,
    whatsapp: { phoneId: s.whatsapp.phoneId, verifyToken: s.whatsapp.verifyToken, hasToken: !!s.whatsapp.token },
    meta: { verifyToken: s.meta.verifyToken, hasPageToken: !!s.meta.pageToken, hasAppSecret: !!s.meta.appSecret },
  };
};
router.get('/settings', (_req, res) => res.json({ ...publicSettings(), suppressCount: suppressSet.size, today: today(), geminiConfigured: !!process.env.GEMINI_API_KEY, geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash' }));
router.put('/settings', h((req, res) => {
  const b = req.body || {};
  const s = db.settings;
  if (b.mode !== undefined) {
    if (b.mode !== 'sandbox' && b.mode !== 'live') throw fail('Mode must be sandbox or live');
    if (active && b.mode !== s.mode) throw fail('Pause sending before switching mode.', 409);
    s.mode = b.mode;
  }
  if (b.publicUrl !== undefined) {
    const url = str(b.publicUrl).replace(/\/+$/, '');
    if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw fail('Public URL must start with http:// or https://');
    s.publicUrl = url;
  }
  if (b.testEmail !== undefined) { if (b.testEmail && !EMAIL_RE.test(str(b.testEmail))) throw fail('Test email is not valid.'); s.testEmail = str(b.testEmail); }
  if (b.autoUnsub !== undefined) s.autoUnsub = !!b.autoUnsub;
  if (b.defaultMin !== undefined) s.defaultMin = clampInt(b.defaultMin, 1, 3600, 10);
  if (b.defaultMax !== undefined) s.defaultMax = Math.max(s.defaultMin, clampInt(b.defaultMax, 1, 3600, 30));
  if (b.aiEnabled !== undefined) s.aiEnabled = !!b.aiEnabled;
  if (b.autopilot !== undefined) s.autopilot = !!b.autopilot;
  if (b.confidenceThreshold !== undefined) s.confidenceThreshold = Math.min(1, Math.max(0.5, Number(b.confidenceThreshold) || 0.85));
  if (b.businessContext !== undefined) s.businessContext = str(b.businessContext).slice(0, 2000);
  if (b.whatsapp) {
    if (b.whatsapp.token) s.whatsapp.token = str(b.whatsapp.token);
    if (b.whatsapp.phoneId !== undefined) s.whatsapp.phoneId = str(b.whatsapp.phoneId);
    if (b.whatsapp.verifyToken !== undefined) s.whatsapp.verifyToken = str(b.whatsapp.verifyToken);
  }
  if (b.meta) {
    if (b.meta.pageToken) s.meta.pageToken = str(b.meta.pageToken);
    if (b.meta.appSecret) s.meta.appSecret = str(b.meta.appSecret);
    if (b.meta.verifyToken !== undefined) s.meta.verifyToken = str(b.meta.verifyToken);
  }
  markDirty(); res.json(publicSettings());
}));
router.get('/suppress', (_req, res) => res.json({ text: [...suppressSet].join('\n'), count: suppressSet.size }));
router.put('/suppress', h((req, res) => {
  const list = String(req.body?.text || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL_RE.test(s));
  suppressSet.clear(); list.forEach((e) => suppressSet.add(e));
  markDirty(); res.json({ count: suppressSet.size });
}));

/* ---------------- campaigns ---------------- */
function newCampaign(src: Partial<Campaign> = {}): Campaign {
  return {
    id: uid(), name: src.name || 'Untitled campaign', subject: src.subject || '', body: src.body || '', footer: src.footer || '',
    minDelay: src.minDelay ?? db.settings.defaultMin, maxDelay: src.maxDelay ?? db.settings.defaultMax,
    volumePerMailbox: src.volumePerMailbox ?? 100,
    accountIds: src.accountIds || [], autoResume: src.autoResume !== false, attachments: [], status: 'draft', createdAt: new Date().toISOString(),
  };
}
const campaignSummary = (c: Campaign) => ({ id: c.id, name: c.name, status: c.status, createdAt: c.createdAt, stats: stats(c.id) });
const campaignDetail = (c: Campaign) => ({ ...c, stats: stats(c.id), activeId: active?.cid ?? null, recipientPreview: recips(c.id).slice(0, 8) });

router.get('/campaigns', (_req, res) => res.json({ campaigns: [...db.campaigns].reverse().map(campaignSummary), activeId: active?.cid ?? null }));
router.post('/campaigns', h((req, res) => {
  const c = newCampaign({ name: str(req.body?.name) || undefined, subject: req.body?.subject, body: req.body?.body });
  db.campaigns.push(c); setRecips(c.id, []); markDirty(); res.json(campaignDetail(c));
}));
router.get('/campaigns/:id', h((req, res) => res.json(campaignDetail(getCampaign(String(req.params.id))))));
router.put('/campaigns/:id', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  if (active?.cid === c.id) throw fail('Pause the campaign before editing it.', 409);
  const b = req.body || {};
  if (b.name !== undefined) c.name = str(b.name) || 'Untitled campaign';
  if (b.subject !== undefined) c.subject = String(b.subject);
  if (b.body !== undefined) c.body = String(b.body);
  if (b.footer !== undefined) c.footer = String(b.footer);
  if (b.minDelay !== undefined) c.minDelay = clampInt(b.minDelay, 1, 3600, 10);
  if (b.maxDelay !== undefined) c.maxDelay = clampInt(b.maxDelay, 1, 3600, 30);
  if (c.maxDelay < c.minDelay) c.maxDelay = c.minDelay;
  if (b.volumePerMailbox !== undefined) c.volumePerMailbox = clampInt(b.volumePerMailbox, 1, 100000, 100);
  if (Array.isArray(b.accountIds)) c.accountIds = b.accountIds.map(String).filter((id: string) => db.accounts.some((a) => a.id === id));
  if (b.autoResume !== undefined) c.autoResume = !!b.autoResume;
  markDirty(); res.json(campaignDetail(c));
}));
router.delete('/campaigns/:id', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  if (active?.cid === c.id) throw fail('Pause the campaign first.', 409);
  db.campaigns = db.campaigns.filter((x) => x !== c);
  dropRecips(c.id); runs.delete(c.id); fs.rmSync(path.join(FILES, c.id), { recursive: true, force: true });
  markDirty(); res.json({ ok: true });
}));
router.post('/campaigns/:id/duplicate', h((req, res) => {
  const src = getCampaign(String(req.params.id));
  const c = newCampaign({ ...src, name: src.name + ' (copy)' });
  db.campaigns.push(c); setRecips(c.id, []);
  if (src.attachments.length) {
    fs.mkdirSync(path.join(FILES, c.id), { recursive: true });
    for (const f of src.attachments) {
      fs.copyFileSync(path.join(FILES, src.id, f.file), path.join(FILES, c.id, f.file));
      c.attachments.push({ ...f, id: uid() });
    }
  }
  markDirty(); res.json(campaignDetail(c));
}));

router.post('/campaigns/:id/recipients', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  if (active?.cid === c.id) throw fail('Pause the campaign before changing recipients.', 409);
  const mode = req.body?.mode === 'append' ? 'append' : 'replace';
  const { list, invalid } = parseRecipients(req.body?.text);
  if (!list.length) throw fail('No valid email addresses found.');
  const existing = mode === 'append' ? recips(c.id) : [];
  const seen = new Set(existing.map((r) => r.email));
  let dupes = 0, supd = 0, added = 0;
  for (const r of list) {
    if (seen.has(r.email)) { dupes++; continue; }
    seen.add(r.email);
    if (suppressSet.has(r.email)) { supd++; continue; }
    existing.push({ ...r, status: 'pending', acc: '', at: '', error: '' }); added++;
  }
  setRecips(c.id, existing);
  if (mode === 'replace') c.status = 'draft';
  else if (added && c.status === 'done') c.status = 'paused';
  markDirty();
  res.json({ added, invalid, dupes, suppressed: supd, ...campaignDetail(c) });
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => { const d = path.join(FILES, String(req.params.id)); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
    filename: (_req, file, cb) => cb(null, uid() + path.extname(file.originalname).slice(0, 12).replace(/[^.\w]/g, '')),
  }),
  limits: { fileSize: 25 * 1048576, files: 30 },
});
router.post('/campaigns/:id/attachments', (req, res, next) => {
  try { const c = getCampaign(String(req.params.id)); if (active?.cid === c.id) throw fail('Pause the campaign before changing attachments.', 409); next(); }
  catch (e) { const err = e as Error & { status?: number }; res.status(err.status || 500).json({ error: err.message }); }
}, upload.array('files', 30), h((req, res) => {
  const c = getCampaign(String(req.params.id));
  for (const f of (req.files as Express.Multer.File[]) || []) {
    c.attachments.push({ id: uid(), name: Buffer.from(f.originalname, 'latin1').toString('utf8'), type: f.mimetype || 'application/octet-stream', size: f.size, file: f.filename });
  }
  markDirty(); res.json(c.attachments);
}));
router.delete('/campaigns/:id/attachments/:aid', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  if (active?.cid === c.id) throw fail('Pause the campaign before changing attachments.', 409);
  const f = c.attachments.find((x) => x.id === req.params.aid);
  if (f) { fs.rmSync(path.join(FILES, c.id, f.file), { force: true }); c.attachments = c.attachments.filter((x) => x !== f); markDirty(); }
  res.json(c.attachments);
}));

const sampleRecipient = (c: Campaign) => recips(c.id)[0] || { email: 'priya@example.com', name: 'Priya Sharma', vars: { company: 'Acme Corp' } };
router.get('/campaigns/:id/preview', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  const acc = campaignAccounts(c.accountIds)[0] || { fromEmail: 'you@yourdomain.com' };
  const m = buildMessage(c, sampleRecipient(c), acc, []);
  res.json({ to: m.to, subject: m.subject, html: m.html, attachments: c.attachments.map((a) => a.name) });
}));
router.post('/campaigns/:id/test', h(async (req, res) => {
  const c = getCampaign(String(req.params.id));
  const to = str(req.body?.to) || db.settings.testEmail;
  if (!EMAIL_RE.test(to)) throw fail('Enter a test email address first.');
  const acc = campaignAccounts(c.accountIds)[0];
  if (!acc) throw fail('No enabled mailboxes are attached to this campaign.');
  const m = buildMessage(c, { ...sampleRecipient(c), email: to }, acc, loadAttachments(c));
  m.subject = '[TEST] ' + m.subject;
  await sendVia(acc, m).catch((e: Error) => { throw fail(e.message, 422); });
  res.json({ ok: true, to, via: accName(acc), mode: db.settings.mode });
}));

/** Sandbox helper: generate N fake leads (example.com addresses) with firstName/company variables. */
router.post('/campaigns/:id/generate-leads', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  if (db.settings.mode !== 'sandbox') throw fail('Lead generation is only available in Test Sandbox mode.');
  if (active?.cid === c.id) throw fail('Pause the campaign before changing recipients.', 409);
  const n = clampInt(req.body?.count, 1, 20000, 100);
  const first = ['Ava', 'Liam', 'Noah', 'Mia', 'Arjun', 'Priya', 'Sofia', 'Ethan', 'Isha', 'Lucas', 'Zara', 'Omar'];
  const comp = ['Apex Cloud', 'Northwind', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Labs', 'Wayne Tech'];
  const lines = ['email,name,company'];
  for (let i = 0; i < n; i++) {
    const f = first[i % first.length];
    lines.push(`${f.toLowerCase()}.${i + 1}@example.com,${f} Test,${comp[i % comp.length]}`);
  }
  const { list } = parseRecipients(lines.join('\n'));
  setRecips(c.id, list.map((r) => ({ ...r, status: 'pending', acc: '', at: '', error: '' })));
  c.status = 'draft'; markDirty();
  res.json(campaignDetail(c));
}));

router.post('/campaigns/:id/start', h((req, res) => { startCampaign(String(req.params.id)); res.json({ ok: true }); }));
router.post('/campaigns/:id/pause', h((req, res) => { pauseCampaign(String(req.params.id)); res.json({ ok: true }); }));
router.post('/campaigns/:id/retry', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  if (active?.cid === c.id) throw fail('Pause first.', 409);
  let n = 0;
  recips(c.id).forEach((r) => { if (r.status === 'failed') { r.status = 'pending'; r.error = ''; n++; } });
  if (n && c.status === 'done') c.status = 'paused';
  markDirty(c.id); markDirty(); log(c.id, `${n} failed recipient(s) moved back to pending`, 'info', { campaign: c.id });
  res.json({ ok: true, n });
}));
router.get('/campaigns/:id/report.csv', h((req, res) => {
  const c = getCampaign(String(req.params.id));
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['email', 'name', 'status', 'mailbox', 'sent_at', 'error'].join(',')]
    .concat(recips(c.id).map((r) => [r.email, r.name, r.status, r.acc, r.at, r.error].map(q).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${(c.name || 'campaign').replace(/[^\w-]+/g, '_')}_report_${today()}.csv"`);
  res.send('﻿' + lines.join('\n'));
}));

/* ---------------- live queue ---------------- */
router.get('/queue', h((req, res) => {
  const cid = str(req.query.campaign) || active?.cid || [...runs.keys()].pop() || '';
  const c = cid ? db.campaigns.find((x) => x.id === cid) : undefined;
  const run = cid ? runs.get(cid) : undefined;
  const st = c ? stats(c.id) : null;
  const accs = c ? campaignAccounts(c.accountIds) : [];
  const ids = [...new Set([...accs.map((a) => a.id), ...Object.keys(run?.acc || {})])];
  const nextAts = Object.values(run?.acc || {}).map((s) => s.nextAt).filter((n) => n > 0);
  const runningMailboxes = ids.map((id) => db.accounts.find((a) => a.id === id)).filter((a): a is Account => !!a && run?.acc[a.id]?.status === 'running' && run.running);
  res.json({
    mode: db.settings.mode,
    campaign: c ? { id: c.id, name: c.name, status: c.status, minDelay: c.minDelay, maxDelay: c.maxDelay } : null,
    running: !!active && active.cid === cid,
    stats: st,
    nextInSec: nextAts.length ? Math.max(0, Math.ceil((Math.min(...nextAts) - Date.now()) / 1000)) : null,
    rotating: runningMailboxes.map(accName),
    mailboxes: ids.map((id) => {
      const a = db.accounts.find((x) => x.id === id); if (!a) return null;
      const s = run?.acc[id];
      return {
        id, name: accName(a), email: a.fromEmail, provider: TYPES[a.type], sentToday: sentToday(a), limit: a.limit, left: leftToday(a), health: healthScore(a),
        state: s ? { status: s.status, sent: s.sent, failed: s.failed, cap: s.cap, nextIn: s.nextAt ? Math.max(0, Math.ceil((s.nextAt - Date.now()) / 1000)) : 0, error: s.error } : null,
      };
    }).filter(Boolean),
    logs: getLogs(c?.id).slice(0, 200).concat(c ? [] : []),
  });
}));
router.get('/logs', (_req, res) => res.json(getLogs().slice(0, 500)));

export default router;
