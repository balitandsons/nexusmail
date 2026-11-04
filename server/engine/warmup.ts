import { today } from '../util.js';
import type { Account } from '../store.js';

const dayNumber = (d: string) => Math.floor(Date.parse(d + 'T00:00:00Z') / 86400000);

/** Daily limit actually allowed today: the mailbox limit, or the warm-up ramp while it is lower. */
export function effectiveLimit(a: Pick<Account, 'limit' | 'warmup'>, now: string = today()): number {
  const w = a.warmup;
  if (!w?.enabled || !w.startDate) return a.limit;
  const days = Math.max(0, dayNumber(now) - dayNumber(w.startDate));
  return Math.max(1, Math.min(a.limit, Math.round(w.startLimit + w.rampPerDay * days)));
}
/** Days until the ramp reaches the full limit (0 when warm-up is off or done). */
export function warmupDaysLeft(a: Pick<Account, 'limit' | 'warmup'>, now: string = today()): number {
  const w = a.warmup;
  if (!w?.enabled || !w.startDate || effectiveLimit(a, now) >= a.limit) return 0;
  return Math.ceil((a.limit - effectiveLimit(a, now)) / Math.max(1, w.rampPerDay));
}
