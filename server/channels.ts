import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { db, type Account, type Channel, type Conversation } from './store.js';
import { sendVia } from './engine/transports.js';
import { htmlToText } from './engine/template.js';

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
type Ingest = (ev: { channel: 'email'; handle: string; name: string; subject: string; text: string; accountId: string }) => Promise<void>;
const lastPoll = new Map<string, { at: string; error: string }>();
export const imapStatus = (id: string) => lastPoll.get(id);

export const IMAP_DEFAULTS: Record<string, { host: string; port: number; secure: boolean }> = {
  hostinger: { host: 'imap.hostinger.com', port: 993, secure: true },
};

async function pollOne(acc: Account, ingest: Ingest) {
  const cfg = acc.imap;
  if (!cfg?.enabled || !acc.pass) return;
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: { user: acc.user || acc.fromEmail, pass: acc.pass }, logger: false });
  try {
    await c.connect();
    const lock = await c.getMailboxLock('INBOX');
    try {
      const uids = (await c.search({ seen: false })) || [];
      for (const uid of uids.slice(0, 20)) {
        const msg = await c.fetchOne(String(uid), { source: true });
        if (!msg || !msg.source) continue;
        const p = await simpleParser(msg.source);
        const from = p.from?.value?.[0];
        if (!from?.address || from.address.toLowerCase() === acc.fromEmail.toLowerCase()) { await c.messageFlagsAdd(String(uid), ['\\Seen']); continue; }
        const text = (p.text || (p.html ? htmlToText(String(p.html)) : '')).split(/\n>|\nOn .* wrote:/)[0].trim();
        await ingest({ channel: 'email', handle: from.address.toLowerCase(), name: from.name || from.address, subject: p.subject || '(no subject)', text, accountId: acc.id });
        await c.messageFlagsAdd(String(uid), ['\\Seen']);
      }
    } finally { lock.release(); }
    lastPoll.set(acc.id, { at: new Date().toISOString(), error: '' });
  } catch (e) {
    lastPoll.set(acc.id, { at: new Date().toISOString(), error: (e as Error).message });
  } finally { await c.logout().catch(() => undefined); }
}

export function startImapPolling(ingest: Ingest) {
  setInterval(async () => {
    if (db.settings.mode !== 'live') return;
    for (const acc of db.accounts) if (acc.enabled && acc.imap?.enabled) await pollOne(acc, ingest);
  }, 60_000).unref();
}
