import { TZ, fail, today } from '../util.js';
import { db, flush, markDirty, recips, suppressSet, type Account, type Campaign } from '../store.js';
import { accName, bump, campaignAccounts, delayFactor, healthScore, leftToday, recordOutcome, volumeFactor } from './balancer.js';
import { buildMessage, loadAttachments } from './template.js';
import { effectiveLimit } from './warmup.js';
import { sendVia } from './transports.js';

export interface LogEntry { id: number; t: number; level: 'ok' | 'warn' | 'err' | 'info'; msg: string; email?: string; mailbox?: string; jitter?: number; campaign?: string; sandbox?: boolean }
export interface AccState { status: 'running' | 'resting' | 'limit' | 'cap' | 'done' | 'error' | 'paused'; sent: number; failed: number; fails: number; nextAt: number; error: string; cap: number }
export interface Run { cid: string; running: boolean; userPaused: boolean; startedAt: number; total: number; acc: Record<string, AccState> }

export let active: Run | null = null;
export const runs = new Map<string, Run>();
const logs: LogEntry[] = [];
let logSeq = 0;
export const getLogs = (cid?: string) => (cid ? logs.filter((l) => l.campaign === cid) : logs);
export function log(cid: string | undefined, msg: string, level: LogEntry['level'] = 'info', extra: Partial<LogEntry> = {}) {
  logs.unshift({ id: ++logSeq, t: Date.now(), level, msg, campaign: cid, ...extra });
  if (logs.length > 500) logs.length = 500;
  console.log(`[${new Date().toLocaleTimeString('en-GB', { timeZone: TZ })}] ${msg}`);
}

export function getCampaign(id: string): Campaign {
  const c = db.campaigns.find((x) => x.id === id);
  if (!c) throw fail('Campaign not found', 404);
  return c;
}
export function stats(cid: string) {
  const s: Record<string, number> = { total: 0, pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of recips(cid)) { s.total++; const k = r.status === 'sending' ? 'pending' : r.status; s[k] = (s[k] || 0) + 1; }
  return s;
}

async function wait(run: Run, st: AccState, sec: number) {
  st.nextAt = Date.now() + sec * 1000;
  while (run.running && Date.now() < st.nextAt) await new Promise((r) => setTimeout(r, Math.min(500, st.nextAt - Date.now())));
  st.nextAt = 0;
}

const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

/** How many emails this mailbox may still send today for the campaign (per-mailbox volume x health factor). */
function capFor(c: Campaign, a: Account): number {
  const d = today();
  const already = recips(c.id).filter((r) => r.status === 'sent' && r.accId === a.id && r.at && dayOf(r.at) === d).length;
  return Math.max(0, Math.round(c.volumePerMailbox * volumeFactor(a)) - already);
}

export function startCampaign(cid: string, how: 'manual' | 'auto' | 'restart' = 'manual') {
  if (active) throw fail(active.cid === cid ? 'Already sending.' : 'Another campaign is sending. Pause it first.', 409);
  const c = getCampaign(cid);
  if (!c.subject.trim() || !c.body.trim()) throw fail('Add a subject and body first.');
  const list = recips(cid);
  list.forEach((r) => { if (r.status === 'sending') r.status = 'pending'; });
  const pending = list.filter((r) => r.status === 'pending').length;
  if (!pending) throw fail('No pending recipients. Load recipients first (or use Retry failed).');
  const all = campaignAccounts(c.accountIds);
  if (!all.length) throw fail('No enabled mailboxes are attached to this campaign.');
  const accs = all.filter((a) => leftToday(a) > 0 && capFor(c, a) > 0);
  if (!accs.length) throw fail("Every attached mailbox has reached its daily limit or campaign volume.");
  const atts = loadAttachments(c);

  const run: Run = { cid, running: true, userPaused: false, startedAt: Date.now(), total: pending, acc: {} };
  accs.forEach((a) => (run.acc[a.id] = { status: 'running', sent: 0, failed: 0, fails: 0, nextAt: 0, error: '', cap: capFor(c, a) }));
  active = run; runs.set(cid, run);
  c.status = 'running'; markDirty();
  const verb = { manual: 'Started', auto: 'Auto-resumed (new day)', restart: 'Resumed after server restart' }[how];
  log(cid, `${verb}: ${pending} pending, ${accs.length} mailbox(es), ${db.settings.mode} mode`, 'ok', { campaign: cid });
  Promise.all(accs.map((a, i) => worker(run, c, a, i, atts)))
    .catch((e) => log(cid, 'Engine error: ' + (e as Error).message, 'err'))
    .finally(() => finish(run, c));
  return run;
}

async function worker(run: Run, c: Campaign, acc: Account, i: number, atts: ReturnType<typeof loadAttachments>) {
  const st = run.acc[acc.id];
  const list = recips(c.id);
  await wait(run, st, i * 1.5 + Math.random() * 3);
  while (run.running) {
    if (leftToday(acc) <= 0) { st.status = 'limit'; log(c.id, `${accName(acc)} reached its daily limit (${effectiveLimit(acc)})`, 'warn', { mailbox: accName(acc) }); return; }
    if (st.sent >= st.cap) { st.status = 'cap'; return; }
    if (acc.stats && acc.stats.restUntil > Date.now()) {
      st.status = 'resting';
      log(c.id, `${accName(acc)} is resting after transient errors (health ${healthScore(acc)}%)`, 'warn', { mailbox: accName(acc) });
      await wait(run, st, Math.ceil((acc.stats.restUntil - Date.now()) / 1000));
      st.status = 'running';
      continue;
    }
    const r = list.find((x) => x.status === 'pending');
    if (!r) { st.status = 'done'; return; }
    if (suppressSet.has(r.email)) { r.status = 'skipped'; r.error = 'On do-not-send list'; markDirty(c.id); continue; }

    r.status = 'sending'; r.acc = accName(acc); r.accId = acc.id;
    let jitter = 0;
    try {
      const res = await sendVia(acc, buildMessage(c, r, acc, atts));
      r.status = 'sent'; r.error = ''; r.at = new Date().toISOString(); r.messageId = res.messageId;
      bump(acc); recordOutcome(acc, 'sent'); st.sent++; st.fails = 0; st.error = '';
      markDirty();
      jitter = Math.round((c.minDelay + Math.random() * (c.maxDelay - c.minDelay)) * delayFactor(acc));
      log(c.id, `Delivered to ${r.email}${res.messageId ? ` (Message ID: ${res.messageId})` : ''}`, 'ok', { email: r.email, mailbox: accName(acc), jitter, campaign: c.id, sandbox: !!res.sandbox });
    } catch (e) {
      const err = e as Error & { status?: number };
      const s = err.status || 0;
      st.fails++; st.error = err.message;
      if (s === 400 || s === 422) {
        r.status = 'failed'; r.error = err.message; st.failed++;
        recordOutcome(acc, 'hard', err.message);
        log(c.id, `Failed ${r.email}: ${err.message}`, 'err', { email: r.email, mailbox: accName(acc), campaign: c.id });
      } else if (s !== 401 && s !== 403 && (r.attempts = (r.attempts || 0) + 1) >= 3) {
        // The same recipient keeps failing transiently (greylisting, full mailbox): stop retrying it
        r.status = 'failed'; r.error = `Gave up after 3 temporary failures: ${err.message}`; st.failed++;
        log(c.id, `Gave up on ${r.email} after 3 temporary failures`, 'err', { email: r.email, mailbox: accName(acc), campaign: c.id });
      } else {
        r.status = 'pending'; // not this recipient's fault, so another mailbox can take it
        r.accId = undefined;
        recordOutcome(acc, s === 401 || s === 403 ? 'auth' : 'soft', err.message);
        log(c.id, `${accName(acc)}: ${err.message}`, 'warn', { mailbox: accName(acc), campaign: c.id });
      }
      markDirty(c.id); markDirty();
      if (s === 401 || s === 403 || st.fails >= 3) {
        st.status = 'error';
        log(c.id, `${accName(acc)} stopped after errors; its recipients move to other mailboxes. Fix it, then press Resume.`, 'err', { mailbox: accName(acc), campaign: c.id });
        return;
      }
      if (s === 429) { log(c.id, `${accName(acc)} is rate-limited, waiting 60 s`, 'warn', { mailbox: accName(acc), campaign: c.id }); await wait(run, st, 60); continue; }
      jitter = c.minDelay;
    }
    markDirty(c.id);
    if (!run.running) break;
    await wait(run, st, jitter || c.minDelay);
  }
  if (st.status === 'running') st.status = 'paused';
}

function finish(run: Run, c: Campaign) {
  run.running = false;
  if (active === run) active = null;
  const list = recips(c.id);
  list.forEach((r) => { if (r.status === 'sending') r.status = 'pending'; });
  const pending = list.filter((r) => r.status === 'pending').length;
  const states = Object.values(run.acc).map((s) => s.status);
  if (!db.campaigns.includes(c)) return;
  if (!pending) { c.status = 'done'; log(c.id, 'Campaign complete', 'ok', { campaign: c.id }); }
  else if (run.userPaused) { c.status = 'paused'; log(c.id, `Paused with ${pending} pending.`, 'warn', { campaign: c.id }); }
  else if (c.autoResume && states.every((s) => s === 'limit' || s === 'done' || s === 'cap')) {
    c.status = 'scheduled'; log(c.id, `Daily limits / volume reached. ${pending} left; sending resumes automatically tomorrow.`, 'warn', { campaign: c.id });
  } else { c.status = 'paused'; log(c.id, `Stopped with ${pending} pending. Check mailbox errors, then press Resume.`, 'warn', { campaign: c.id }); }
  markDirty(); markDirty(c.id); flush();
}

export function pauseCampaign(cid: string) {
  const c = getCampaign(cid);
  if (active?.cid === c.id) { active.userPaused = true; active.running = false; log(c.id, 'Pausing; finishing emails already in progress…', 'warn', { campaign: c.id }); }
  else if (c.status === 'scheduled' || c.status === 'running') { c.status = 'paused'; markDirty(); }
}

export function bootQueue(resumeOnStart: boolean) {
  let toResume: string | null = null;
  for (const c of db.campaigns) {
    const list = recips(c.id);
    if (list.some((r) => r.status === 'sending')) { list.forEach((r) => { if (r.status === 'sending') r.status = 'pending'; }); markDirty(c.id); }
    if (c.status === 'running') { c.status = 'paused'; markDirty(); if (resumeOnStart && !toResume) toResume = c.id; }
  }
  if (toResume) setTimeout(() => { try { startCampaign(toResume!, 'restart'); } catch (e) { log(toResume!, 'Could not resume: ' + (e as Error).message, 'err'); } }, 5000);
  // Auto-resume campaigns waiting for a new day's limits
  setInterval(() => {
    if (active) return;
    const c = db.campaigns.find((x) => x.status === 'scheduled');
    if (!c || !campaignAccounts(c.accountIds).some((a) => leftToday(a) > 0)) return;
    try { startCampaign(c.id, 'auto'); } catch (e) { c.status = 'paused'; markDirty(); log(c.id, 'Auto-resume failed: ' + (e as Error).message, 'err'); }
  }, 60_000).unref();
}
