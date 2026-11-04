import { uid } from './util.js';
import { db, markDirty, recips, type AgentLogEntry } from './store.js';
import { triageEmail, type Context, type MailFacts } from './ai/triage.js';
import { ingest } from './inbox.js';
import { applyBounce, markReply, parseDsn } from './engine/bounces.js';

let ctxCache: { at: number; ctx: Context } | null = null;
/** Message-IDs we sent and everyone we have ever written to or talked with. Cached for a minute. */
export function buildContext(): Context {
  if (ctxCache && Date.now() - ctxCache.at < 60_000) return ctxCache.ctx;
  const sentMessageIds = new Set<string>(), knownContacts = new Set<string>();
  for (const c of db.campaigns) {
    for (const r of recips(c.id)) {
      if (r.status !== 'sent') continue;
      knownContacts.add(r.email.toLowerCase());
      if (r.messageId) sentMessageIds.add(r.messageId.toLowerCase().replace(/^<|>$/g, ''));
    }
  }
  for (const cv of db.conversations) if (cv.channel === 'email') knownContacts.add(cv.contactHandle.toLowerCase());
  ctxCache = { at: Date.now(), ctx: { sentMessageIds, knownContacts } };
  return ctxCache.ctx;
}

export interface InboundResult { action: 'keep' | 'hold' | 'trash'; applied: boolean; skipped?: boolean }

export const mailKey = (accountId: string, f: Pick<MailFacts, 'messageId' | 'from' | 'subject'>, uidNum?: number) =>
  `${accountId}:${f.messageId || `${f.from}|${f.subject}|${uidNum ?? ''}`}`;

function addLog(e: Omit<AgentLogEntry, 'id' | 'at'>) {
  db.agentLog.unshift({ id: uid(), at: new Date().toISOString(), ...e });
  if (db.agentLog.length > 1000) db.agentLog.length = 1000;
  markDirty();
}

/**
 * Entry point for every inbound email (IMAP poll or webhook).
 * keep  -> analysed by the reply assistant like any customer mail
 * hold  -> stored for your review, never replied to automatically, never deleted
 * trash -> logged; `applied` tells the caller whether it may actually move the mail to Trash (false in dry-run)
 */
export async function processInbound(f: MailFacts, accountId: string, uidNum?: number): Promise<InboundResult> {
  const agent = db.settings.agent;
  const key = mailKey(accountId, f, uidNum);
  // Deliverability bookkeeping runs even when the agent is off: bounces update recipients, replies update stats.
  const dsn = parseDsn(f);
  if (dsn && !db.agentLog.some((e) => e.key === key)) applyBounce(dsn);
  else if (!dsn) markReply(f);
  if (agent.enabled && db.agentLog.some((e) => e.key === key)) return { action: 'keep', applied: false, skipped: true };

  const base = { channel: 'email' as const, handle: f.from, name: f.fromName || f.from, subject: f.subject, text: f.text, accountId };
  if (!agent.enabled) { await ingest(base); return { action: 'keep', applied: false }; }

  const { verdict, decision } = await triageEmail(f, buildContext(), agent);
  const entry = { accountId, from: f.from, subject: f.subject, category: verdict.category, confidence: verdict.confidence, reason: decision.reason, engine: verdict.engine, messageId: f.messageId || '', key };

  if (decision.action === 'trash') {
    const applied = !agent.dryRun;
    addLog({ ...entry, action: applied ? 'trashed' : 'would_trash' });
    return { action: 'trash', applied };
  }
  addLog({ ...entry, action: decision.action === 'hold' ? 'held' : 'kept' });
  await ingest({ ...base, hold: decision.action === 'hold' ? decision.reason : undefined });
  return { action: decision.action, applied: false };
}
