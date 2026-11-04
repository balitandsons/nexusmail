import { Router } from 'express';
import multer from 'multer';
import { EMAIL_RE, clampInt, fail, str } from '../util.js';
import { db } from '../store.js';
import { h } from './api.js';
import {
  deleteMessages, getMailAccount, listFolders, listMessages, mailAccounts, moveMessages, readMessage, sendMail, setFlags,
  type MsgRow,
} from '../mail.js';
import { analyze, aiUsageToday } from '../ai/agent.js';
import { triageEmail, type MailFacts } from '../ai/triage.js';
import { buildContext } from '../agent.js';
import { factsFromParsed } from '../channels.js';
import type { Conversation } from '../store.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1048576, files: 10 } });
const folderParam = (v: unknown) => { const f = str(v); if (!f) throw fail('folder is required'); return f; };
const uids = (v: unknown) => { const a = (Array.isArray(v) ? v : [v]).map(Number).filter((n) => Number.isInteger(n) && n > 0); if (!a.length) throw fail('uids are required'); return a.slice(0, 100); };

router.get('/mail/accounts', (_req, res) => res.json({
  accounts: mailAccounts().map((a) => ({ id: a.id, name: a.label || a.fromEmail, email: a.fromEmail, fromName: a.fromName })),
  mode: db.settings.mode, aiUsedToday: aiUsageToday(), aiDailyLimit: db.settings.aiDailyLimit, geminiConfigured: !!process.env.GEMINI_API_KEY,
}));

/** Folder list, cached briefly so switching views doesn't reconnect every time. */
const folderCache = new Map<string, { at: number; v: unknown }>();
router.get('/mail/:acc/folders', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  const hit = folderCache.get(a.id);
  if (hit && Date.now() - hit.at < 20_000 && !req.query.fresh) return void res.json(hit.v);
  const v = await listFolders(a);
  folderCache.set(a.id, { at: Date.now(), v });
  res.json(v);
}));

router.get('/mail/:acc/messages', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  const page = clampInt(req.query.page, 1, 1000, 1), per = clampInt(req.query.perPage, 5, 50, 25);
  res.json(await listMessages(a, folderParam(req.query.folder ?? 'INBOX'), page, per, str(req.query.q) || undefined));
}));

/** Combined inbox across all mailboxes, newest first. At most 3 mailboxes are opened at once. */
const uniCache = new Map<string, { at: number; rows: MsgRow[]; error?: string }>();
router.get('/mail/unified/inbox', h(async (req, res) => {
  const per = clampInt(req.query.perPage, 5, 40, 20);
  const fresh = !!req.query.fresh;
  const accs = mailAccounts();
  const errors: Record<string, string> = {};
  const queue = [...accs];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      const hit = uniCache.get(a.id);
      if (hit && !fresh && Date.now() - hit.at < 30_000) { if (hit.error) errors[a.fromEmail] = hit.error; continue; }
      try { uniCache.set(a.id, { at: Date.now(), rows: (await listMessages(a, 'INBOX', 1, per)).rows }); }
      catch (e) { uniCache.set(a.id, { at: Date.now(), rows: [], error: (e as Error).message }); errors[a.fromEmail] = (e as Error).message; }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const rows = accs.flatMap((a) => uniCache.get(a.id)?.rows ?? []).sort((x, y) => +new Date(y.date) - +new Date(x.date)).slice(0, per * 3);
  res.json({ rows, errors });
}));

router.get('/mail/:acc/message', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  const { msg } = await readMessage(a, folderParam(req.query.folder), clampInt(req.query.uid, 1, 2 ** 31, 0));
  uniCache.delete(a.id); folderCache.delete(a.id);
  res.json(msg);
}));

router.get('/mail/:acc/attachment', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  const { parsed } = await readMessage(a, folderParam(req.query.folder), clampInt(req.query.uid, 1, 2 ** 31, 0), false);
  const at = parsed.attachments[clampInt(req.query.index, 0, 1000, -1)];
  if (!at) throw fail('Attachment not found', 404);
  const name = (at.filename || 'attachment').replace(/[^\w.\- ]+/g, '_');
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff' });
  res.send(at.content);
}));

router.post('/mail/:acc/flags', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  const map: Record<string, string> = { seen: '\\Seen', flagged: '\\Flagged' };
  const pick = (v: unknown) => (Array.isArray(v) ? v : []).map((k) => map[String(k)]).filter(Boolean);
  await setFlags(a, folderParam(req.body?.folder), uids(req.body?.uids), pick(req.body?.add), pick(req.body?.remove));
  uniCache.delete(a.id); folderCache.delete(a.id); res.json({ ok: true });
}));
router.post('/mail/:acc/delete', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  await deleteMessages(a, folderParam(req.body?.folder), uids(req.body?.uids), !!req.body?.permanent);
  uniCache.delete(a.id); folderCache.delete(a.id); res.json({ ok: true });
}));
router.post('/mail/:acc/move', h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  await moveMessages(a, folderParam(req.body?.folder), uids(req.body?.uids), folderParam(req.body?.target));
  uniCache.delete(a.id); folderCache.delete(a.id); res.json({ ok: true });
}));

const addrList = (v: unknown) => String(v ?? '').split(/[,;\s]+/).map((s) => s.trim().replace(/^.*<|>$/g, '')).filter(Boolean);
router.post('/mail/:acc/send', upload.array('files', 10), h(async (req, res) => {
  const a = getMailAccount(String(req.params.acc));
  if (db.settings.mode !== 'live') throw fail('Mail is in Test Sandbox mode. Switch to Live (top bar) to send.', 409);
  const b = req.body || {};
  const to = addrList(b.to), cc = addrList(b.cc), bcc = addrList(b.bcc);
  for (const x of [...to, ...cc, ...bcc]) if (!EMAIL_RE.test(x)) throw fail(`"${x}" is not a valid email address.`);
  if (!to.length) throw fail('Add at least one recipient.');
  if (to.length + cc.length + bcc.length > 50) throw fail('Too many recipients (max 50).');
  const attachments = ((req.files as Express.Multer.File[]) || []).map((f) => ({ filename: Buffer.from(f.originalname, 'latin1').toString('utf8'), content: f.buffer, contentType: f.mimetype }));
  let inReplyTo: string | undefined, references: string[] | undefined;
  const refUid = Number(b.replyUid || b.forwardUid), refFolder = str(b.replyFolder || b.forwardFolder);
  if (refUid && refFolder) {
    const { msg, parsed } = await readMessage(a, refFolder, refUid, false);
    if (b.replyUid) { inReplyTo = msg.messageId; references = [...msg.references, msg.messageId].filter(Boolean); }
    if (b.forwardUid && String(b.includeOriginalAttachments) === 'true') for (const at of parsed.attachments) if (!at.cid || at.contentDisposition === 'attachment') attachments.push({ filename: at.filename || 'attachment', content: at.content, contentType: at.contentType });
  }
  await sendMail(a, { to, cc, bcc, subject: str(b.subject) || '(no subject)', text: String(b.text ?? ''), inReplyTo, references, attachments });
  if (b.replyUid && refFolder) await setFlags(a, refFolder, [Number(b.replyUid)], ['\\Answered'], []).catch(() => undefined);
  uniCache.delete(a.id); folderCache.delete(a.id);
  res.json({ ok: true });
}));

/* ---- AI help (each click = one Gemini call, counted against the daily cap) ---- */
const factsOf = async (accId: string, folder: string, uid: number): Promise<MailFacts & { body: string }> => {
  const a = getMailAccount(accId);
  const { parsed } = await readMessage(a, folder, uid, false);
  const f = factsFromParsed(parsed);
  if (!f) throw fail('This message has no sender.');
  return { ...f, body: f.text };
};
router.post('/mail/:acc/ai/reply', h(async (req, res) => {
  const f = await factsOf(String(req.params.acc), folderParam(req.body?.folder), clampInt(req.body?.uid, 1, 2 ** 31, 0));
  const conv = { id: 'mail', channel: 'email', contactName: f.fromName || f.from, contactHandle: f.from, subject: f.subject, messages: [{ id: '1', dir: 'in', by: 'contact', text: f.body, at: new Date().toISOString() }], status: 'needs_review', unread: false, updatedAt: '' } as Conversation;
  const a = await analyze(conv, f.body.slice(0, 4000), str(req.body?.instruction) || undefined);
  res.json({ draft: a.suggestedReply, intent: a.intent, confidence: a.confidence, engine: a.engine, summary: a.summary });
}));
router.post('/mail/:acc/ai/classify', h(async (req, res) => {
  const f = await factsOf(String(req.params.acc), folderParam(req.body?.folder), clampInt(req.body?.uid, 1, 2 ** 31, 0));
  const r = await triageEmail(f, buildContext(), db.settings.agent);
  res.json({ category: r.verdict.category, confidence: r.verdict.confidence, engine: r.verdict.engine, reasoning: r.verdict.reasoning, action: r.decision.action, reason: r.decision.reason });
}));

export default router;
