import { TZ } from '../util.js';
import type { Account, Campaign, Recipient } from '../store.js';
import { healthScore } from './balancer.js';
import { effectiveLimit } from './warmup.js';

const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const rate = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export interface Counts { sent: number; failed: number; bounced: number; replied: number; unsubscribed: number; pending: number }
const zero = (): Counts => ({ sent: 0, failed: 0, bounced: 0, replied: 0, unsubscribed: 0, pending: 0 });
function add(c: Counts, r: Recipient) {
  if (r.status === 'sent' || r.status === 'bounced') c.sent++;
  if (r.status === 'failed') c.failed++;
  if (r.status === 'bounced') c.bounced++;
  if (r.status === 'pending' || r.status === 'sending') c.pending++;
  if (r.repliedAt) c.replied++;
  if (r.unsubAt) c.unsubscribed++;
}
const withRates = (c: Counts) => ({ ...c, bounceRate: rate(c.bounced, c.sent), replyRate: rate(c.replied, c.sent), unsubRate: rate(c.unsubscribed, c.sent) });

export function computeStats(accounts: Account[], campaigns: Campaign[], recipsOf: (cid: string) => Recipient[], days: number, now = new Date()) {
  const total = zero();
  const perAcc = new Map<string, Counts>();
  const perDay = new Map<string, { sent: number; bounced: number; replied: number; unsubscribed: number }>();
  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) { const k = dayOf(new Date(now.getTime() - i * 86400000).toISOString()); dayKeys.push(k); perDay.set(k, { sent: 0, bounced: 0, replied: 0, unsubscribed: 0 }); }
  const bump = (iso: string | undefined, f: 'sent' | 'bounced' | 'replied' | 'unsubscribed') => { if (!iso) return; const d = perDay.get(dayOf(iso)); if (d) d[f]++; };

  const camps = campaigns.map((c) => {
    const cc = zero();
    for (const r of recipsOf(c.id)) {
      add(cc, r); add(total, r);
      const key = r.accId || r.acc;
      if (key && (r.status === 'sent' || r.status === 'bounced' || r.status === 'failed')) { const a = perAcc.get(key) ?? zero(); add(a, r); perAcc.set(key, a); }
      bump(r.at, 'sent'); bump(r.bouncedAt, 'bounced'); bump(r.repliedAt, 'replied'); bump(r.unsubAt, 'unsubscribed');
    }
    return { id: c.id, name: c.name, status: c.status, createdAt: c.createdAt, ...withRates(cc) };
  });
  const mailboxes = accounts.map((a) => ({
    id: a.id, name: a.label || a.fromEmail, email: a.fromEmail, health: healthScore(a), limit: a.limit, effectiveLimit: effectiveLimit(a),
    ...withRates(perAcc.get(a.id) ?? perAcc.get(a.label || a.fromEmail) ?? zero()),
  }));
  return { totals: withRates(total), days: dayKeys.map((date) => ({ date, ...perDay.get(date)! })), mailboxes, campaigns: camps.reverse() };
}
