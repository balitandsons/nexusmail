import { db, markDirty, recips, suppressSet, type Recipient } from '../store.js';
import { recordOutcome } from './balancer.js';
import { log } from './queue.js';
import type { MailFacts } from '../ai/triage.js';
import { touchBounce, touchReply, touchUnsub } from '../crm.js';

export interface Dsn { recipient: string; status: string; hard: boolean; diagnostic: string }

const EMAIL = /[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Reads a delivery-failure notice (RFC 3464 report part, or the plain text of a mailer-daemon message). */
export function parseDsn(f: Pick<MailFacts, 'from' | 'subject' | 'text' | 'headers' | 'dsn'>): Dsn | null {
  const isReport = /multipart\/report|delivery-status/i.test(f.headers['content-type'] || '');
  const sender = /^(mailer-daemon|postmaster)@/i.test(f.from);
  const subj = /(undeliver|delivery status notification|delivery failure|returned mail|mail delivery failed|failure notice)/i.test(f.subject);
  if (!isReport && !sender && !subj) return null;
  const body = `${f.dsn || ''}\n${f.text || ''}`;
  const fr = body.match(/(?:Final-Recipient|Original-Recipient):\s*rfc822;\s*<?([^\s>;]+)/i);
  const failed = fr?.[1] ?? body.match(new RegExp(`(?:to|for|recipient|address)[^\\n]{0,40}?<?(${EMAIL.source})>?`, 'i'))?.[1] ?? body.match(EMAIL)?.[0];
  if (!failed) return null;
  const status = body.match(/Status:\s*([245]\.\d{1,3}\.\d{1,3})/i)?.[1] ?? body.match(/\b([45]\d\d)[ -]([45]\.\d\.\d)\b/)?.[2] ?? '';
  const smtp = body.match(/\b(5\d\d|4\d\d)\b[ -]/)?.[1] ?? '';
  const hard = status ? status.startsWith('5') : smtp ? smtp.startsWith('5') : !/(mailbox full|try again|temporar|deferred)/i.test(body);
  const diagnostic = body.match(/Diagnostic-Code:[^\n]*(?:\n[ \t][^\n]*)*/i)?.[0]?.replace(/\s+/g, ' ').slice(0, 200) ?? '';
  return { recipient: failed.toLowerCase().replace(/[<>]/g, ''), status, hard, diagnostic };
}

const norm = (s: string) => s.toLowerCase().replace(/^<|>$/g, '');

/** Marks the matching campaign recipient bounced, suppresses hard bounces and feeds mailbox health. Returns what changed. */
export function applyBounce(d: Dsn): { campaign?: string; email: string; mailbox?: string } | null {
  for (const c of db.campaigns) {
    const r = recips(c.id).find((x) => x.email === d.recipient && (x.status === 'sent' || x.status === 'failed'));
    if (!r) continue;
    r.status = 'bounced'; r.bouncedAt = new Date().toISOString(); r.error = `Bounced ${d.status || ''} ${d.diagnostic}`.trim();
    if (d.hard) suppressSet.add(d.recipient);
    const acc = db.accounts.find((a) => a.id === r.accId);
    if (acc && d.hard) recordOutcome(acc, 'hard', r.error);
    touchBounce(d.recipient);
    markDirty(c.id); markDirty();
    log(c.id, `Bounce: ${d.recipient} ${d.hard ? '(hard, added to do-not-send)' : '(soft)'} ${d.status}`, 'warn', { email: d.recipient, mailbox: acc?.label || acc?.fromEmail, campaign: c.id });
    return { campaign: c.id, email: d.recipient, mailbox: acc?.fromEmail };
  }
  if (d.hard) { suppressSet.add(d.recipient); markDirty(); }
  return null;
}

/** An inbound mail from someone we emailed (or In-Reply-To one of our messages) counts as a reply. */
export function markReply(f: Pick<MailFacts, 'from' | 'inReplyTo' | 'references'>): boolean {
  const refs = new Set([f.inReplyTo, ...(f.references || [])].filter(Boolean).map((x) => norm(x as string)));
  let hit = false;
  for (const c of db.campaigns) {
    for (const r of recips(c.id)) {
      if (r.repliedAt) continue;
      const byId = !!r.messageId && refs.has(norm(r.messageId));
      if (byId || (r.status === 'sent' && r.email === f.from)) { r.repliedAt = new Date().toISOString(); markDirty(c.id); hit = true; }
    }
  }
  if (hit) touchReply(f.from);
  return hit;
}

export function markUnsubscribed(email: string) {
  touchUnsub(email);
  for (const c of db.campaigns) for (const r of recips(c.id)) if (r.email === email && !r.unsubAt) { r.unsubAt = new Date().toISOString(); markDirty(c.id); }
}

export type { Recipient };
