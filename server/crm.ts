import { EMAIL_RE, uid } from './util.js';
import { db, markDirty, recips, type Contact, type Intent, type Stage } from './store.js';

export const STAGES: Stage[] = ['new', 'contacted', 'replied', 'interested', 'customer', 'lost'];
const RANK: Record<Stage, number> = { new: 0, contacted: 1, replied: 2, interested: 3, customer: 4, lost: -1 };

export const normEmail = (s: string) => s.trim().toLowerCase();
/** Phone numbers match on digits only, so "+91 98765-43210" and "919876543210" are one person. */
export const normPhone = (s: string) => s.replace(/\D/g, '');

let byEmail = new Map<string, Contact>(), byPhone = new Map<string, Contact>(), indexed = -1;
function index() {
  if (indexed === db.contacts.length && byEmail.size) return;
  byEmail = new Map(); byPhone = new Map();
  for (const c of db.contacts) { c.emails.forEach((e) => byEmail.set(e, c)); c.phones.forEach((p) => byPhone.set(p, c)); }
  indexed = db.contacts.length;
}
export const reindex = () => { indexed = -1; index(); };
export function findContact(email?: string, phone?: string): Contact | undefined {
  index();
  return (email ? byEmail.get(normEmail(email)) : undefined) ?? (phone && normPhone(phone) ? byPhone.get(normPhone(phone)) : undefined);
}

export interface ContactInput { email?: string; phone?: string; name?: string; company?: string; state?: string; source?: string; tags?: string[] }
/** Finds the person by email or phone (merging channels) or creates them. Never overwrites a name that is already set. */
export function upsertContact(i: ContactInput): Contact | null {
  const email = i.email && EMAIL_RE.test(normEmail(i.email)) ? normEmail(i.email) : undefined;
  const phone = i.phone && normPhone(i.phone).length >= 7 ? normPhone(i.phone) : undefined;
  if (!email && !phone) return null;
  let c = findContact(email, phone);
  const now = new Date().toISOString();
  if (!c) {
    c = { id: uid(), name: i.name?.trim() || email || phone || '', emails: [], phones: [], company: i.company?.trim() || '', state: i.state?.trim() || undefined, tags: [], stage: 'new', source: i.source || '', notes: [], createdAt: now, lastActivityAt: now };
    db.contacts.push(c);
  } else {
    if (i.name?.trim() && (!c.name || c.name === c.emails[0] || c.name === c.phones[0])) c.name = i.name.trim();
    if (i.company?.trim() && !c.company) c.company = i.company.trim();
    if (i.state?.trim() && !c.state) c.state = i.state.trim();
  }
  if (email && !c.emails.includes(email)) { c.emails.push(email); byEmail.set(email, c); }
  if (phone && !c.phones.includes(phone)) { c.phones.push(phone); byPhone.set(phone, c); }
  for (const t of i.tags ?? []) addTag(c, t);
  indexed = db.contacts.length; markDirty();
  return c;
}
export function addTag(c: Contact, t: string) { const x = t.trim().toLowerCase().replace(/\s+/g, '-'); if (x && !c.tags.includes(x)) c.tags.push(x); }

/** Moves the stage forward only (new -> contacted -> replied -> interested -> customer). Manual stages and "lost" are respected. */
export function advance(c: Contact, to: Stage) {
  c.lastActivityAt = new Date().toISOString(); markDirty();
  if (c.stageManual || c.stage === 'lost') return;
  if (RANK[to] > RANK[c.stage]) c.stage = to;
}
export function setLost(c: Contact, tag?: string) { c.lastActivityAt = new Date().toISOString(); if (!c.stageManual) c.stage = 'lost'; if (tag) addTag(c, tag); markDirty(); }

export const touchSent = (email: string, name: string, company: string, campaign: string) => {
  const c = upsertContact({ email, name, company, source: campaign });
  if (c) advance(c, 'contacted');
};
export function touchReply(email: string) { const c = findContact(email); if (c) advance(c, 'replied'); }
export function touchInbound(i: ContactInput, intent?: Intent) {
  const c = upsertContact({ ...i, source: i.source || 'inbound' });
  if (!c) return null;
  advance(c, 'replied');
  if (intent === 'lead_interested' || intent === 'pricing_question') advance(c, 'interested');
  if (intent === 'unsubscribe') setLost(c, 'unsubscribed');
  return c;
}
export function touchUnsub(email: string) { const c = findContact(email); if (c) setLost(c, 'unsubscribed'); }
export function touchBounce(email: string) { const c = findContact(email); if (c) { addTag(c, 'bounced'); markDirty(); } }

/** One-time fill from data created before the CRM existed. Safe to run more than once. */
export function backfillContacts(): number {
  const before = db.contacts.length;
  for (const camp of db.campaigns) for (const r of recips(camp.id)) {
    if (r.status !== 'sent' && r.status !== 'bounced' && !r.repliedAt) continue;
    const c = upsertContact({ email: r.email, name: r.name, company: r.vars?.company, source: camp.name });
    if (!c) continue;
    advance(c, 'contacted'); if (r.repliedAt) advance(c, 'replied'); if (r.unsubAt) setLost(c, 'unsubscribed'); if (r.status === 'bounced') addTag(c, 'bounced');
  }
  for (const cv of db.conversations) {
    const c = upsertContact({ email: cv.channel === 'email' ? cv.contactHandle : undefined, phone: cv.channel === 'whatsapp' ? cv.contactHandle : undefined, name: cv.contactName, source: 'inbound' });
    if (c) { advance(c, 'replied'); if (cv.analysis && (cv.analysis.intent === 'lead_interested' || cv.analysis.intent === 'pricing_question')) advance(c, 'interested'); }
  }
  return db.contacts.length - before;
}

export interface TimelineItem { at: string; kind: 'sent' | 'reply' | 'bounce' | 'unsubscribe' | 'message' | 'note'; title: string; detail?: string }
export function timeline(c: Contact): TimelineItem[] {
  const items: TimelineItem[] = [];
  const mine = new Set(c.emails);
  for (const camp of db.campaigns) for (const r of recips(camp.id)) {
    if (!mine.has(r.email)) continue;
    if (r.at) items.push({ at: r.at, kind: 'sent', title: `Email sent: ${camp.name}`, detail: r.acc ? `from ${r.acc}` : '' });
    if (r.repliedAt) items.push({ at: r.repliedAt, kind: 'reply', title: 'Replied to a campaign email' });
    if (r.bouncedAt) items.push({ at: r.bouncedAt, kind: 'bounce', title: 'Email bounced', detail: r.error });
    if (r.unsubAt) items.push({ at: r.unsubAt, kind: 'unsubscribe', title: 'Unsubscribed' });
  }
  for (const cv of db.conversations) {
    if (!(mine.has(cv.contactHandle.toLowerCase()) || c.phones.includes(normPhone(cv.contactHandle)))) continue;
    for (const m of cv.messages) items.push({ at: m.at, kind: 'message', title: `${m.dir === 'in' ? 'Message from contact' : m.by === 'ai' ? 'AI reply' : 'Your reply'} (${cv.channel})`, detail: m.text.slice(0, 400) });
  }
  for (const n of c.notes) items.push({ at: n.at, kind: 'note', title: `Note by ${n.by}`, detail: n.text });
  return items.sort((a, b) => +new Date(b.at) - +new Date(a.at));
}

export function mergeInto(target: Contact, from: Contact) {
  for (const e of from.emails) if (!target.emails.includes(e)) target.emails.push(e);
  for (const p of from.phones) if (!target.phones.includes(p)) target.phones.push(p);
  from.tags.forEach((t) => addTag(target, t));
  target.notes.push(...from.notes);
  if (RANK[from.stage] > RANK[target.stage] && !target.stageManual) target.stage = from.stage;
  db.contacts = db.contacts.filter((x) => x !== from); reindex(); markDirty();
}
