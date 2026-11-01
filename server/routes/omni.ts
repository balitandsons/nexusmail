import crypto from 'node:crypto';
import express, { Router } from 'express';
import { fail, safeEq, str } from '../util.js';
import { db, markDirty, type Channel } from '../store.js';
import { h } from './api.js';
import { humanReply, ingest, sampleEvent, type InboundEvent } from '../inbox.js';
import { processInbound } from '../agent.js';
import { analyze } from '../ai/agent.js';
import { log } from '../engine/queue.js';

const CHANNELS: Channel[] = ['email', 'whatsapp', 'instagram', 'messenger'];
const asChannel = (v: unknown): Channel => { if (!CHANNELS.includes(v as Channel)) throw fail('Unknown channel'); return v as Channel; };

/* ---------------- authenticated inbox API ---------------- */
export const inboxRouter = Router();

inboxRouter.get('/inbox', (_req, res) => res.json({
  conversations: db.conversations.map((c) => ({ ...c })),
  threshold: db.settings.confidenceThreshold, autopilot: db.settings.autopilot, mode: db.settings.mode,
  counts: { needsReview: db.conversations.filter((c) => c.status === 'needs_review').length, autoReplied: db.conversations.filter((c) => c.status === 'auto_replied').length },
}));
inboxRouter.post('/inbox/:id/read', h((req, res) => {
  const c = db.conversations.find((x) => x.id === req.params.id);
  if (c) { c.unread = false; markDirty(); }
  res.json({ ok: true });
}));
inboxRouter.post('/inbox/:id/reply', h(async (req, res) => {
  const text = str(req.body?.text);
  const c = await humanReply(String(req.params.id), text, req.body?.approvedAiDraft ? 'ai' : 'human').catch((e: Error & { status?: number }) => { throw fail(e.message, e.status || 502); });
  res.json(c);
}));
inboxRouter.post('/inbox/:id/redraft', h(async (req, res) => {
  const c = db.conversations.find((x) => x.id === req.params.id);
  if (!c) throw fail('Conversation not found', 404);
  const lastIn = [...c.messages].reverse().find((m) => m.dir === 'in');
  if (!lastIn) throw fail('No inbound message to answer');
  const a = await analyze(c, lastIn.text, str(req.body?.instruction));
  c.analysis = a; markDirty();
  res.json(c);
}));
inboxRouter.post('/inbox/:id/close', h((req, res) => {
  const c = db.conversations.find((x) => x.id === req.params.id);
  if (!c) throw fail('Conversation not found', 404);
  c.status = 'closed'; markDirty(); res.json(c);
}));
inboxRouter.post('/inbox/simulate', h(async (req, res) => {
  const ev: InboundEvent = req.body?.text
    ? { channel: asChannel(req.body.channel), handle: str(req.body.handle) || 'sim_contact', name: str(req.body.name) || 'Simulated Contact', subject: str(req.body.subject), text: str(req.body.text) }
    : sampleEvent(asChannel(req.body?.channel || CHANNELS[Math.floor(Math.random() * CHANNELS.length)]));
  res.json(await ingest(ev));
}));

/* ---------------- public webhooks (verified, not cookie-authed) ---------------- */
export const webhookRouter = Router();
const raw = express.raw({ type: '*/*', limit: '2mb' });

const verify = (expected: string) => (req: express.Request, res: express.Response) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query as Record<string, string>;
  if (mode === 'subscribe' && expected && token && safeEq(token, expected)) return res.status(200).send(challenge);
  res.sendStatus(403);
};
webhookRouter.get('/webhooks/whatsapp', (req, res) => verify(db.settings.whatsapp.verifyToken)(req, res));
webhookRouter.get('/webhooks/meta', (req, res) => verify(db.settings.meta.verifyToken)(req, res));

function validSignature(req: express.Request, secret: string): boolean {
  const sig = String(req.get('x-hub-signature-256') || '');
  if (!secret || !sig.startsWith('sha256=')) return false;
  const want = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body as Buffer).digest('hex');
  return safeEq(sig, want);
}
const parseBody = (req: express.Request) => { try { return JSON.parse((req.body as Buffer).toString('utf8')); } catch { return null; } };

webhookRouter.post('/webhooks/whatsapp', raw, (req, res) => {
  // Meta signs with the app secret; reject unsigned payloads once a secret is configured (it must be, for live use).
  if (!validSignature(req, db.settings.meta.appSecret)) return res.sendStatus(403);
  const body = parseBody(req);
  res.sendStatus(200);
  for (const entry of body?.entry ?? []) for (const ch of entry.changes ?? []) {
    const names: Record<string, string> = {};
    for (const c of ch.value?.contacts ?? []) names[c.wa_id] = c.profile?.name;
    for (const m of ch.value?.messages ?? []) {
      if (m.type !== 'text') continue;
      ingest({ channel: 'whatsapp', handle: m.from, name: names[m.from] || m.from, text: m.text?.body || '' }).catch((e) => log(undefined, 'WhatsApp ingest failed: ' + e.message, 'err'));
    }
  }
});

webhookRouter.post('/webhooks/meta', raw, (req, res) => {
  if (!validSignature(req, db.settings.meta.appSecret)) return res.sendStatus(403);
  const body = parseBody(req);
  res.sendStatus(200);
  const channel: Channel = body?.object === 'instagram' ? 'instagram' : 'messenger';
  for (const entry of body?.entry ?? []) for (const ev of entry.messaging ?? []) {
    if (!ev.message?.text || ev.message.is_echo) continue;
    ingest({ channel, handle: ev.sender.id, name: ev.sender.id, text: ev.message.text }).catch((e) => log(undefined, 'Meta ingest failed: ' + e.message, 'err'));
  }
});

/** Generic inbound email webhook (e.g. a provider's inbound-parse). Protected by the Meta/WhatsApp-style verify token as a bearer. */
webhookRouter.post('/webhooks/email', express.json({ limit: '2mb' }), (req, res) => {
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const expected = db.settings.meta.verifyToken || db.settings.whatsapp.verifyToken;
  if (!expected || !token || !safeEq(token, expected)) return res.sendStatus(403);
  const { from, name, subject, text, messageId, inReplyTo, headers } = req.body || {};
  if (!from || !text) return res.status(400).json({ error: 'from and text are required' });
  res.sendStatus(202);
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries((headers as Record<string, unknown>) || {})) lc[k.toLowerCase()] = String(v);
  processInbound({ from: String(from).toLowerCase(), fromName: str(name) || String(from), subject: str(subject), text: String(text), headers: lc, messageId: messageId ? String(messageId) : undefined, inReplyTo: inReplyTo ? String(inReplyTo) : undefined }, 'webhook').catch((e) => log(undefined, 'Email webhook ingest failed: ' + e.message, 'err'));
});
