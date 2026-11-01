import { Router } from 'express';
import { fail, str, EMAIL_RE } from '../util.js';
import { db, markDirty } from '../store.js';
import { h } from './api.js';
import { triageEmail } from '../ai/triage.js';
import { buildContext } from '../agent.js';
import { restoreFromTrash } from '../channels.js';

const router = Router();
const list = (v: unknown) => [...new Set(String(Array.isArray(v) ? v.join('\n') : v ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter((x) => EMAIL_RE.test(x) || /^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))];

router.get('/agent', (_req, res) => {
  const log = db.agentLog;
  res.json({
    settings: db.settings.agent,
    geminiConfigured: !!process.env.GEMINI_API_KEY,
    log: log.slice(0, 200),
    counts: { trashed: log.filter((e) => e.action === 'trashed').length, wouldTrash: log.filter((e) => e.action === 'would_trash').length, kept: log.filter((e) => e.action === 'kept').length, held: log.filter((e) => e.action === 'held').length },
    imapMailboxes: db.accounts.filter((a) => a.imap?.enabled).length,
  });
});

router.put('/agent/settings', h((req, res) => {
  const b = req.body || {}, a = db.settings.agent;
  if (b.enabled !== undefined) a.enabled = !!b.enabled;
  if (b.dryRun !== undefined) a.dryRun = !!b.dryRun;
  if (b.trashThreshold !== undefined) a.trashThreshold = Math.min(0.99, Math.max(0.7, Number(b.trashThreshold) || 0.9));
  if (b.allowList !== undefined) a.allowList = list(b.allowList);
  if (b.blockList !== undefined) a.blockList = list(b.blockList);
  markDirty(); res.json(a);
}));

/** Dry analysis of pasted mail. Touches nothing. */
router.post('/agent/test', h(async (req, res) => {
  const b = req.body || {};
  if (!EMAIL_RE.test(str(b.from))) throw fail('Enter a valid sender email.');
  const headers: Record<string, string> = {};
  for (const line of String(b.headers || '').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  const r = await triageEmail({ from: str(b.from).toLowerCase(), fromName: str(b.fromName), subject: str(b.subject), text: String(b.text || ''), headers }, buildContext(), db.settings.agent);
  res.json({ ...r, wouldTrash: r.decision.action === 'trash', applied: r.decision.action === 'trash' && !db.settings.agent.dryRun });
}));

router.post('/agent/log/:id/restore', h(async (req, res) => {
  const e = db.agentLog.find((x) => x.id === req.params.id);
  if (!e) throw fail('Log entry not found', 404);
  if (e.action === 'trashed') {
    const acc = db.accounts.find((a) => a.id === e.accountId);
    if (!acc) throw fail('Mailbox no longer exists', 404);
    const ok = await restoreFromTrash(acc, e.messageId).catch((err: Error) => { throw fail(err.message, 502); });
    if (!ok) throw fail('Message not found in Trash (it may have been purged or moved).', 404);
  }
  e.restored = true;
  const a = db.settings.agent;
  if (!a.allowList.includes(e.from)) a.allowList = [...a.allowList, e.from];
  markDirty(); res.json({ ok: true });
}));

export default router;
