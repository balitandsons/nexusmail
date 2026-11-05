import { db, type Analysis, type Contact, type Conversation } from './store.js';
import { sendVia } from './engine/transports.js';
import { htmlToText } from './engine/template.js';
import { log } from './engine/queue.js';

/** Rules that always route a message to a person, whatever the AI's confidence. Returns the reason, or null. */
export function handoffReason(text: string, a: Pick<Analysis, 'sentiment'>, contact: Pick<Contact, 'tags'> | null): string | null {
  const h = db.settings.handoff;
  if (!h.enabled) return null;
  const t = text.toLowerCase();
  const kw = h.keywords.find((k) => k.trim() && new RegExp(`(^|[^\\p{L}])${k.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(t));
  if (kw) return `Handoff rule: message mentions "${kw}"`;
  if (h.negative && a.sentiment === 'negative') return 'Handoff rule: the sender sounds unhappy';
  if (h.vip && contact?.tags.includes('vip')) return 'Handoff rule: VIP contact';
  return null;
}

const lastAlert = new Map<string, number>();
/** Emails the owner that a conversation needs a person (at most once an hour per conversation). */
export async function notifyOwner(conv: Conversation, reason: string) {
  const h = db.settings.handoff;
  if (!h.enabled || !h.notifyEmail || !h.notifyAccountId) return;
  if (Date.now() - (lastAlert.get(conv.id) || 0) < 3_600_000) return;
  const acc = db.accounts.find((a) => a.id === h.notifyAccountId && a.enabled);
  if (!acc) return;
  lastAlert.set(conv.id, Date.now());
  const last = [...conv.messages].reverse().find((m) => m.dir === 'in');
  const link = db.settings.publicUrl ? `<p><a href="${db.settings.publicUrl}">Open NexusMail</a></p>` : '';
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<p><b>${esc(conv.contactName)}</b> (${conv.channel}${conv.channel === 'email' ? ', ' + esc(conv.contactHandle) : ''}) needs your reply.</p><p><i>${esc(reason)}</i></p><blockquote>${esc((last?.text || '').slice(0, 800)).replace(/\n/g, '<br>')}</blockquote>${conv.analysis?.suggestedReply ? `<p>AI draft:<br>${esc(conv.analysis.suggestedReply).replace(/\n/g, '<br>')}</p>` : ''}${link}`;
  try {
    await sendVia(acc, { to: h.notifyEmail, toName: '', subject: `[NexusMail] ${conv.contactName} needs your reply`, html, text: htmlToText(html), attachments: [], headers: {} });
  } catch (e) { log(undefined, `Could not send the review alert: ${(e as Error).message}`, 'warn'); }
}
