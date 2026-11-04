import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, type Account, type Channel, type Conversation } from './store.js';
import { sendVia } from './engine/transports.js';
import { htmlToText } from './engine/template.js';
import type { MailFacts } from './ai/triage.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

async function graph(url: string, token: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Graph API ${res.status}: ${txt.slice(0, 200)}`);
  return txt;
}

/** Sends an outbound reply on the conversation's channel. Sandbox mode never touches a network. */
export async function sendReply(conv: Conversation, text: string): Promise<{ sandbox: boolean }> {
  if (db.settings.mode === 'sandbox') return { sandbox: true };
  const s = db.settings;
  if (conv.channel === 'whatsapp') {
    if (!s.whatsapp.token || !s.whatsapp.phoneId) throw new Error('WhatsApp token / phone number ID not configured (API & Webhooks)');
    await graph(`${GRAPH}/${s.whatsapp.phoneId}/messages`, s.whatsapp.token, { messaging_product: 'whatsapp', to: conv.contactHandle, type: 'text', text: { body: text } });
  } else if (conv.channel === 'instagram' || conv.channel === 'messenger') {
    if (!s.meta.pageToken) throw new Error('Meta page access token not configured (API & Webhooks)');
    await graph(`${GRAPH}/me/messages`, s.meta.pageToken, { recipient: { id: conv.contactHandle }, messaging_type: 'RESPONSE', message: { text } });
  } else {
    const acc = db.accounts.find((a) => a.id === conv.accountId && a.enabled) || db.accounts.find((a) => a.enabled);
    if (!acc) throw new Error('No enabled mailbox available to send the email reply');
    const subject = /^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject || 'your message'}`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div>`;
    await sendVia(acc, { to: conv.contactHandle, toName: conv.contactName, subject, html, text: htmlToText(html), attachments: [], headers: {} });
  }
  return { sandbox: false };
}

export const channelLabel: Record<Channel, string> = { email: 'Email', whatsapp: 'WhatsApp', instagram: 'Instagram', messenger: 'Messenger' };

/* ---------------- IMAP polling (email inbox) ---------------- */
export type InboundHandler = (f: MailFacts, accountId: string, uid: number) => Promise<{ action: 'keep' | 'hold' | 'trash'; applied: boolean; skipped?: boolean }>;
const lastPoll = new Map<string, { at: string; error: string }>();
export const imapStatus = (id: string) => lastPoll.get(id);

export const IMAP_DEFAULTS: Record<string, { host: string; port: number; secure: boolean }> = {
  hostinger: { host: 'imap.hostinger.com', port: 993, secure: true },
};

const imapClient = (acc: Account) => {
  const cfg = acc.imap!;
  return new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: acc.user || acc.fromEmail, pass: acc.pass || '' }, logger: false });
};

/** Finds the mailbox's Trash folder by its special-use flag, then by common names. */
async function trashPath(c: ImapFlow): Promise<string> {
  const boxes = await c.list();
  return boxes.find((b) => b.specialUse === '\\Trash')?.path
    ?? boxes.find((b) => /^(inbox\.)?(trash|deleted( items| messages)?)$/i.test(b.path))?.path
    ?? 'Trash';
}

export function factsFromParsed(p: Awaited<ReturnType<typeof simpleParser>>): MailFacts | null {
  const from = p.from?.value?.[0];
  if (!from?.address) return null;
  const headers: Record<string, string> = {};
  p.headers.forEach((v, k) => {
    const val = typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(', ') : (v as { text?: string; value?: unknown })?.text ?? String((v as { value?: unknown })?.value ?? '');
    headers[k.toLowerCase()] = String(val);
  });
  const text = (p.text || (p.html ? htmlToText(String(p.html)) : '')).split(/\n>|\nOn .* wrote:/)[0].trim();
  const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
  const dsn = p.attachments.filter((a) => /delivery-status|rfc822-headers/i.test(a.contentType)).map((a) => a.content.toString('utf8').slice(0, 4000)).join('\n') || undefined;
  return { dsn, from: from.address.toLowerCase(), fromName: from.name || from.address, subject: p.subject || '(no subject)', text, headers, messageId: p.messageId, inReplyTo: p.inReplyTo, references: refs };
}

async function pollOne(acc: Account, handle: InboundHandler) {
  if (!acc.imap?.enabled || !acc.pass) return;
  const c = imapClient(acc);
  try {
    await c.connect();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const uids = (await c.search({ seen: false }, { uid: true })) || [];
      let trash = '';
      for (const uid of uids.slice(0, 25)) {
        const msg = await c.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const f = factsFromParsed(await simpleParser(msg.source));
        if (!f || f.from === acc.fromEmail.toLowerCase()) { await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true }); continue; }
        const r = await handle(f, acc.id, uid);
        if (r.skipped) continue;
        if (r.action === 'trash' && r.applied) {
          trash ||= await trashPath(c);
          await c.messageMove(String(uid), trash, { uid: true }); // reversible: never EXPUNGE/delete outright
        } else if (r.action !== 'trash') {
          await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        }
      }
    } finally { lock.release(); }
    lastPoll.set(acc.id, { at: new Date().toISOString(), error: '' });
  } catch (e) {
    lastPoll.set(acc.id, { at: new Date().toISOString(), error: (e as Error).message });
  } finally { await c.logout().catch(() => undefined); }
}

/** Moves a previously trashed message back to the inbox (found by Message-ID). */
export async function restoreFromTrash(acc: Account, messageId: string): Promise<boolean> {
  if (!acc.imap?.enabled || !messageId) return false;
  const c = imapClient(acc);
  try {
    await c.connect();
    const trash = await trashPath(c);
    const lock = await c.getMailboxLock(trash);
    try {
      const uids = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || [];
      if (!uids.length) return false;
      await c.messageMove(uids.map(String).join(','), 'INBOX', { uid: true });
      return true;
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => undefined); }
}

export function startImapPolling(handle: InboundHandler) {
  let busy = false;
  setInterval(async () => {
    if (db.settings.mode !== 'live' || busy) return;
    busy = true;
    try { for (const acc of db.accounts) if (acc.enabled && acc.imap?.enabled) await pollOne(acc, handle); } finally { busy = false; }
  }, 60_000).unref();
}
