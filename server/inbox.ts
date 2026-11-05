import { uid } from './util.js';
import { db, markDirty, suppressSet, type Channel, type Conversation, type Message } from './store.js';
import { analyze } from './ai/agent.js';
import { sendReply } from './channels.js';
import { log } from './engine/queue.js';
import { touchInbound } from './crm.js';
import { handoffReason, notifyOwner } from './handoff.js';

export interface InboundEvent {
  channel: Channel;
  handle: string;
  name?: string;
  subject?: string;
  text: string;
  accountId?: string;
  /** Set by the inbox agent when the mail must be reviewed by a person and never auto-answered. */
  hold?: string;
}

const now = () => new Date().toISOString();

function findOrCreate(ev: InboundEvent): Conversation {
  const handle = ev.channel === 'email' ? ev.handle.toLowerCase() : ev.handle;
  let conv = db.conversations.find((c) => c.channel === ev.channel && c.contactHandle === handle && c.status !== 'closed');
  if (!conv) {
    conv = {
      id: uid(), channel: ev.channel, contactName: ev.name || handle, contactHandle: handle,
      subject: ev.subject || '', accountId: ev.accountId, messages: [], status: 'needs_review', unread: true, updatedAt: now(),
    };
    db.conversations.unshift(conv);
    if (db.conversations.length > 500) db.conversations.length = 500;
  }
  return conv;
}

/** Stores the inbound message, runs AI triage, then auto-replies (hybrid autopilot) or stages a draft for review. */
export async function ingest(ev: InboundEvent): Promise<Conversation> {
  const conv = findOrCreate(ev);
  const msg: Message = { id: uid(), dir: 'in', by: 'contact', text: ev.text, at: now() };
  conv.messages.push(msg);
  conv.unread = true; conv.updatedAt = now();
  markDirty();

  const a = await analyze(conv, ev.text);
  conv.analysis = a;
  const contact = touchInbound({ email: ev.channel === 'email' ? ev.handle : undefined, phone: ev.channel === 'whatsapp' ? ev.handle : undefined, name: ev.name }, a.intent);
  const hold = ev.hold || handoffReason(ev.text, a, contact) || undefined;
  if (hold) { conv.held = true; conv.heldReason = hold; }

  if (a.intent === 'unsubscribe') {
    if (conv.channel === 'email') suppressSet.add(conv.contactHandle);
    conv.status = 'closed';
    log(undefined, `Unsubscribe request from ${conv.contactHandle} (${conv.channel}); added to the do-not-send list`, 'info');
    markDirty();
    return conv;
  }
  if (a.intent === 'spam') { conv.status = 'closed'; markDirty(); return conv; }

  const trusted = a.engine === 'gemini' || db.settings.mode === 'sandbox'; // keyword fallback never sends unreviewed in Live mode
  const eligible = !hold && db.settings.autopilot && trusted && a.confidence >= db.settings.confidenceThreshold;

  if (eligible && a.suggestedReply.trim()) {
    try {
      const r = await sendReply(conv, a.suggestedReply);
      conv.messages.push({ id: uid(), dir: 'out', by: 'ai', text: a.suggestedReply, at: now(), sandbox: r.sandbox });
      conv.status = 'auto_replied';
      log(undefined, `AI auto-replied to ${conv.contactName} on ${conv.channel} (${Math.round(a.confidence * 100)}% confidence)`, 'ok', { sandbox: r.sandbox });
    } catch (e) {
      conv.status = 'needs_review';
      log(undefined, `AI auto-reply to ${conv.contactName} failed: ${(e as Error).message}`, 'err');
    }
  } else conv.status = 'needs_review';
  markDirty();
  if (conv.status === 'needs_review') void notifyOwner(conv, hold || `The AI was only ${Math.round(a.confidence * 100)}% sure of its reply`);
  return conv;
}

export async function humanReply(id: string, text: string, by: 'human' | 'ai' = 'human'): Promise<Conversation> {
  const conv = db.conversations.find((c) => c.id === id);
  if (!conv) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  if (!text.trim()) throw Object.assign(new Error('Reply is empty'), { status: 400 });
  const r = await sendReply(conv, text.trim());
  conv.messages.push({ id: uid(), dir: 'out', by, text: text.trim(), at: now(), sandbox: r.sandbox });
  conv.status = 'replied'; conv.unread = false; conv.updatedAt = now();
  markDirty();
  return conv;
}

const SAMPLES: Record<Channel, { handle: string; name: string; subject?: string; text: string }[]> = {
  email: [
    { handle: 'david.kim@apexcloud.co', name: 'David Kim', subject: "Re: Quick question regarding Apex Cloud's outbound workflow", text: 'Hi, this is timely timing. We are struggling with mailbox throttling on our sales accounts right now. Does your system support automatic jitter delays and ZeptoMail integration? If so, Thursday 2pm works.' },
    { handle: 'ops@northwind.example', name: 'Ops Team', subject: 'Re: Outreach platform', text: 'We have a HIPAA compliance requirement. Can you sign a BAA?' },
  ],
  whatsapp: [{ handle: '14158904421', name: 'Elena Rostova', text: 'Hello! I got your email about the multi-provider dispatch tool. We have 15 Hostinger mailboxes and send around 1500 emails/day. What is the pricing?' }],
  instagram: [{ handle: 'ig_vortex_samir', name: 'Vortex_Samir', text: 'Hey team, we operate in healthcare compliance (HIPAA). Do you have dedicated on-premise relays or signed BAA for enterprise mailboxes?' }],
  messenger: [{ handle: 'fb_user_89128471', name: 'Clara Mendez', text: 'Please unsubscribe me from future outbound lists. Thanks.' }],
};
export const sampleEvent = (channel: Channel): InboundEvent => {
  const list = SAMPLES[channel];
  return { channel, ...list[Math.floor(Math.random() * list.length)] };
};
