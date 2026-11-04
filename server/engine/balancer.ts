import { today } from '../util.js';
import { db, type Account } from '../store.js';
import { effectiveLimit } from './warmup.js';

export const accName = (a: Account) => a.label || a.fromEmail;
export const sentToday = (a: Account) => (a.daily && a.daily.date === today() ? a.daily.count : 0);
export const leftToday = (a: Account) => Math.max(0, effectiveLimit(a) - sentToday(a));
export function bump(a: Account) { if (!a.daily || a.daily.date !== today()) a.daily = { date: today(), count: 0 }; a.daily.count++; }

export const newStats = (): Account['stats'] => ({ sent: 0, hard: 0, soft: 0, consecutive: 0, restUntil: 0, lastError: '' });

/**
 * Health score 0-100 from bounce rate, consecutive transient errors, missing DNS auth and a
 * currently active rest period. Used to (1) show the card score, (2) shrink a degraded mailbox's
 * share of a campaign and (3) slow its pacing.
 */
export function healthScore(a: Account): number {
  const s = a.stats || newStats();
  const total = s.sent + s.hard;
  const hardRate = total >= 5 ? s.hard / total : 0;
  const softRate = total >= 5 ? s.soft / (total + s.soft) : 0;
  let score = 100 - hardRate * 250 - softRate * 80 - s.consecutive * 8;
  if (a.dns) { if (!a.dns.spf) score -= 6; if (!a.dns.dkim) score -= 6; if (!a.dns.dmarc) score -= 3; }
  if (s.restUntil > Date.now()) score -= 25;
  return Math.max(0, Math.min(100, Math.round(score)));
}
export const healthLabel = (n: number) => (n >= 90 ? 'Optimal' : n >= 75 ? 'Good' : n >= 50 ? 'Degraded' : 'At risk');

/** Share of the campaign's per-mailbox volume this mailbox may take (healthy => 100%). */
export function volumeFactor(a: Account): number {
  const h = healthScore(a);
  return h >= 80 ? 1 : h >= 50 ? 0.5 : h > 0 ? 0.2 : 0;
}
/** Pacing multiplier: unhealthy mailboxes wait longer between sends. */
export function delayFactor(a: Account): number {
  const h = healthScore(a);
  return h >= 80 ? 1 : h >= 50 ? 1.6 : 2.5;
}

export type Outcome = 'sent' | 'hard' | 'soft' | 'auth';
const REST_MS = 2 * 60_000;

export function recordOutcome(a: Account, o: Outcome, err = '') {
  const s = (a.stats ||= newStats());
  if (o === 'sent') { s.sent++; s.consecutive = 0; s.lastError = ''; }
  else if (o === 'hard') { s.hard++; s.lastError = err; }
  else { s.soft++; s.consecutive++; s.lastError = err; if (o === 'soft') s.restUntil = Date.now() + REST_MS * Math.min(s.consecutive, 5); }
}

export const campaignAccounts = (accountIds: string[]) =>
  db.accounts.filter((a) => a.enabled && (!accountIds.length || accountIds.includes(a.id)));
