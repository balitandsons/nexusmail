import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import { fail } from './util.js';
import { db, type Account } from './store.js';
import { isSmtp, sendRawSmtp } from './engine/transports.js';
import { buildContext } from './agent.js';
import { RELEVANT, DISCARDABLE, decide, heuristicVerdict, signals, type MailFacts } from './ai/triage.js';

/** Mailboxes the Mail view can open: SMTP-type accounts (Hostinger / custom). API-only providers have no inbox. */
export const mailAccounts = () => db.accounts.filter((a) => a.enabled && isSmtp(a) && a.pass);
export function getMailAccount(id: string): Account {
  const a = mailAccounts().find((x) => x.id === id);
  if (!a) throw fail('Mailbox not found, disabled, or has no password saved.', 404);
  return a;
}
function imapConfig(a: Account) {
  const domain = a.fromEmail.split('@')[1];
  const host = a.imap?.host || (a.type === 'hostinger' ? 'imap.hostinger.com' : `imap.${domain}`);
  return { host, port: a.imap?.port || 993, secure: a.imap?.secure ?? true };
}

/** Runs fn with a short-lived IMAP connection (shared hosting friendly: nothing stays open between requests). */
export async function withImap<T>(a: Account, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const cfg = imapConfig(a);
  const c = new ImapFlow({ ...cfg, auth: { user: a.user || a.fromEmail, pass: a.pass || '' }, logger: false, socketTimeout: 60000 });
  c.on('error', () => undefined);
  try { await c.connect(); }
  catch (e) { throw fail(`Could not open ${a.fromEmail}: ${(e as Error).message}`, 502); }
  try { return await fn(c); }
  finally { await c.logout().catch(() => undefined); }
}

export interface FolderInfo { path: string; name: string; special: string; total: number; unread: number }
export async function listFolders(a: Account): Promise<FolderInfo[]> {
  return withImap(a, async (c) => {
    const boxes = await c.list();
    const out: FolderInfo[] = [];
    for (const b of boxes) {
      if (b.flags?.has('\\Noselect')) continue;
      let total = 0, unread = 0;
      try { const st = await c.status(b.path, { messages: true, unseen: true }); total = st.messages ?? 0; unread = st.unseen ?? 0; } catch { /* unreadable folder */ }
      out.push({ path: b.path, name: b.name, special: (b.specialUse || (b.path.toUpperCase() === 'INBOX' ? '\\Inbox' : '')).replace('\\', ''), total, unread });
    }
    const order = ['Inbox', 'Drafts', 'Sent', 'Junk', 'Trash'];
    return out.sort((x, y) => (order.indexOf(x.special) + 1 || 99) - (order.indexOf(y.special) + 1 || 99) || x.name.localeCompare(y.name));
  });
}
export async function folderOfKind(c: ImapFlow, kind: 'Trash' | 'Sent' | 'Drafts' | 'Junk'): Promise<string> {
  const boxes = await c.list();
  return boxes.find((b) => b.specialUse === '\\' + kind)?.path ?? boxes.find((b) => b.path.toLowerCase().endsWith(kind.toLowerCase()))?.path ?? (kind === 'Trash' ? 'Trash' : kind);
}

export interface MsgRow {
  uid: number; accountId: string; accountName: string; folder: string;
  from: string; fromName: string; to: string; subject: string; date: string;
  seen: boolean; flagged: boolean; answered: boolean; hasAttachment: boolean; size: number;
  badge: 'relevant' | 'review' | 'junk'; badgeWhy: string;
}
const hdr = (buf: Buffer | undefined) => {
  const out: Record<string, string> = {};
  for (const line of (buf?.toString('utf8') || '').replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return out;
};
const hasAttach = (n: any): boolean => !!n && ((n.disposition || '').toLowerCase() === 'attachment' || (Array.isArray(n.childNodes) && n.childNodes.some(hasAttach)));
const addr = (x?: { name?: string; address?: string }[]) => (x || []).map((a) => a.name ? `${a.name} <${a.address}>` : a.address).filter(Boolean).join(', ');

/** Free, offline hint (no AI call): is this likely a customer/sales mail, something to review, or junk? */
export function quickBadge(a: Account, from: string, subject: string, headers: Record<string, string>): { badge: MsgRow['badge']; why: string } {
  const f: MailFacts = { from, fromName: '', subject, text: '', headers };
  const sig = signals(f, buildContext(), db.settings.agent);
  const v = heuristicVerdict(f, sig);
  const d = decide(v, sig, db.settings.agent);
  if (sig.keep.length || RELEVANT.includes(v.category)) return { badge: 'relevant', why: sig.keep[0] || v.reasoning };
  if (DISCARDABLE.includes(v.category) || d.action === 'trash') return { badge: 'junk', why: sig.junk[0] || v.reasoning };
  return { badge: 'review', why: v.reasoning };
}

function rowFrom(a: Account, folder: string, m: FetchMessageObject): MsgRow {
  const env = m.envelope;
  const f = env?.from?.[0];
  const headers = hdr(m.headers);
  const fromAddr = (f?.address || '').toLowerCase();
  const b = quickBadge(a, fromAddr, env?.subject || '', headers);
  return {
    uid: m.uid, accountId: a.id, accountName: a.label || a.fromEmail, folder,
    from: fromAddr, fromName: f?.name || '', to: addr(env?.to), subject: env?.subject || '(no subject)',
    date: (env?.date || m.internalDate || new Date()).toString(), seen: !!m.flags?.has('\\Seen'), flagged: !!m.flags?.has('\\Flagged'),
    answered: !!m.flags?.has('\\Answered'), hasAttachment: hasAttach(m.bodyStructure), size: m.size || 0, badge: b.badge, badgeWhy: b.why,
  };
}
const FETCH = { uid: true, flags: true, envelope: true, bodyStructure: true, size: true, internalDate: true, headers: ['list-unsubscribe', 'list-id', 'precedence', 'auto-submitted', 'x-autoreply'] } as const;

export async function listMessages(a: Account, folder: string, page: number, perPage: number, q?: string): Promise<{ rows: MsgRow[]; total: number }> {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const rows: MsgRow[] = [];
      if (q) {
        const uids = ((await c.search({ or: [{ subject: q }, { from: q }, { to: q }] }, { uid: true })) || []).sort((x, y) => y - x);
        const slice = uids.slice((page - 1) * perPage, page * perPage);
        if (slice.length) for await (const m of c.fetch(slice.join(','), FETCH as never, { uid: true })) rows.push(rowFrom(a, folder, m));
        return { rows: rows.sort((x, y) => y.uid - x.uid), total: uids.length };
      }
      const total = (c.mailbox && typeof c.mailbox === 'object' ? c.mailbox.exists : 0) || 0;
      if (!total) return { rows, total: 0 };
      const end = total - (page - 1) * perPage;
      if (end < 1) return { rows, total };
      const start = Math.max(1, end - perPage + 1);
      for await (const m of c.fetch(`${start}:${end}`, FETCH as never)) rows.push(rowFrom(a, folder, m));
      return { rows: rows.sort((x, y) => y.uid - x.uid), total };
    } finally { lock.release(); }
  });
}

export interface FullMessage {
  uid: number; accountId: string; folder: string; messageId: string; references: string[];
  from: string; fromName: string; to: string; cc: string; replyTo: string; subject: string; date: string;
  html: string; text: string; flagged: boolean;
  attachments: { index: number; filename: string; size: number; contentType: string; inline: boolean }[];
}

/** Light server-side cleanup. The browser also renders the result in a sandboxed iframe with no scripts. */
export function cleanHtml(html: string, cids: Map<string, string>): string {
  return html
    .replace(/<(script|iframe|object|embed|form|style)\b[\s\S]*?<\/\1\s*>/gi, (m, tag: string) => (tag.toLowerCase() === 'style' ? m : ''))
    .replace(/<\/?(script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2')
    .replace(/cid:([^"'\s)>]+)/gi, (m, id: string) => cids.get(id.replace(/^<|>$/g, '')) || m);
}

export async function parseSource(src: Buffer): Promise<ParsedMail> { return simpleParser(src); }

export async function readMessage(a: Account, folder: string, uid: number, markSeen = true): Promise<{ msg: FullMessage; parsed: ParsedMail }> {
  return withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      const m = await c.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
      if (!m || !m.source) throw fail('Message not found (it may have been moved or deleted).', 404);
      const p = await simpleParser(m.source);
      if (markSeen && !m.flags?.has('\\Seen')) await c.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      const cids = new Map<string, string>();
      const attachments: FullMessage['attachments'] = [];
      p.attachments.forEach((at, index) => {
        const inline = !!at.cid && at.contentDisposition !== 'attachment';
        if (at.cid && at.content.length < 2_000_000) cids.set(at.cid.replace(/^<|>$/g, ''), `data:${at.contentType};base64,${at.content.toString('base64')}`);
        attachments.push({ index, filename: at.filename || `attachment-${index + 1}`, size: at.size, contentType: at.contentType, inline });
      });
      const from = p.from?.value?.[0];
      const refs = Array.isArray(p.references) ? p.references : p.references ? [p.references] : [];
      const toText = (x: unknown) => { const v = x as { value?: { name?: string; address?: string }[] } | { value?: { name?: string; address?: string }[] }[] | undefined; return addr(Array.isArray(v) ? v.flatMap((y) => y.value || []) : v?.value); };
      return {
        parsed: p,
        msg: {
          uid, accountId: a.id, folder, messageId: p.messageId || '', references: refs,
          from: (from?.address || '').toLowerCase(), fromName: from?.name || '', to: toText(p.to), cc: toText(p.cc), replyTo: toText(p.replyTo),
          subject: p.subject || '(no subject)', date: (p.date || new Date()).toString(),
          html: p.html ? cleanHtml(String(p.html), cids) : '', text: p.text || '', flagged: !!m.flags?.has('\\Flagged'), attachments,
        },
      };
    } finally { lock.release(); }
  });
}

export async function setFlags(a: Account, folder: string, uids: number[], add: string[], remove: string[]) {
  await withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try {
      if (add.length) await c.messageFlagsAdd(uids.join(','), add, { uid: true });
      if (remove.length) await c.messageFlagsRemove(uids.join(','), remove, { uid: true });
    } finally { lock.release(); }
  });
}

/** Delete = move to Trash (recoverable). Deleting from Trash itself, or permanent=true, removes for good. */
export async function deleteMessages(a: Account, folder: string, uids: number[], permanent: boolean) {
  await withImap(a, async (c) => {
    const trash = await folderOfKind(c, 'Trash');
    const lock = await c.getMailboxLock(folder);
    try {
      if (permanent || folder === trash) await c.messageDelete(uids.join(','), { uid: true });
      else await c.messageMove(uids.join(','), trash, { uid: true });
    } finally { lock.release(); }
  });
}
export async function moveMessages(a: Account, folder: string, uids: number[], target: string) {
  await withImap(a, async (c) => {
    const lock = await c.getMailboxLock(folder);
    try { await c.messageMove(uids.join(','), target, { uid: true }); } finally { lock.release(); }
  });
}

export interface Outgoing {
  to: string[]; cc: string[]; bcc: string[]; subject: string; text: string;
  inReplyTo?: string; references?: string[];
  attachments: { filename: string; content: Buffer; contentType?: string }[];
}
/** Builds the message, sends it over SMTP and files a copy in Sent (Hostinger SMTP does not do that itself). */
export async function sendMail(a: Account, o: Outgoing) {
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${o.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`;
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const built = await builder.sendMail({
    from: { name: a.fromName || '', address: a.fromEmail }, to: o.to, cc: o.cc, bcc: o.bcc, subject: o.subject, text: o.text, html,
    inReplyTo: o.inReplyTo, references: o.references, attachments: o.attachments,
  });
  const raw = built.message as Buffer;
  const recipients = [...o.to, ...o.cc, ...o.bcc];
  await sendRawSmtp(a, raw, a.fromEmail, recipients);
  try { await withImap(a, async (c) => { await c.append(await folderOfKind(c, 'Sent'), raw, ['\\Seen']); }); } catch { /* copy in Sent is best effort */ }
}
