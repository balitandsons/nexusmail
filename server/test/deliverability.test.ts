import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusmail-deliv-'));
const { effectiveLimit, warmupDaysLeft } = await import('../engine/warmup.js');
const { parseDsn } = await import('../engine/bounces.js');
const { evaluateDns } = await import('../engine/transports.js');
const { computeStats } = await import('../engine/stats.js');

test('warm-up ramps the daily limit and stops at the mailbox limit', () => {
  const a = { limit: 100, warmup: { enabled: true, startDate: '2026-11-01', startLimit: 20, rampPerDay: 10 } };
  assert.equal(effectiveLimit(a, '2026-11-01'), 20);
  assert.equal(effectiveLimit(a, '2026-11-04'), 50);
  assert.equal(effectiveLimit(a, '2026-12-30'), 100);
  assert.equal(effectiveLimit({ limit: 100 }, '2026-11-04'), 100);
  assert.equal(warmupDaysLeft(a, '2026-11-04'), 5);
  assert.equal(warmupDaysLeft(a, '2026-12-30'), 0);
});

test('parseDsn reads hard and soft bounces from a delivery report', () => {
  const hard = parseDsn({ from: 'mailer-daemon@mx.example', subject: 'Undelivered Mail Returned to Sender', headers: { 'content-type': 'multipart/report; report-type=delivery-status' }, text: 'Could not deliver', dsn: 'Final-Recipient: rfc822; Bob@Dead.example\nAction: failed\nStatus: 5.1.1\nDiagnostic-Code: smtp; 550 5.1.1 User unknown' });
  assert.deepEqual([hard?.recipient, hard?.hard, hard?.status], ['bob@dead.example', true, '5.1.1']);
  const soft = parseDsn({ from: 'postmaster@mx.example', subject: 'Delivery Status Notification (Delay)', headers: {}, text: 'Delivery to the following recipient has been delayed: <kim@slow.example>\nStatus: 4.2.2 mailbox full' });
  assert.deepEqual([soft?.recipient, soft?.hard], ['kim@slow.example', false]);
  assert.equal(parseDsn({ from: 'maria@buyer.com', subject: 'Pricing?', headers: {}, text: 'How much?' }), null);
});

test('evaluateDns explains what to fix', () => {
  const bad = evaluateDns({ domain: 'a.com', type: 'hostinger', spf: [], dmarc: [], dkimSelector: null });
  assert.deepEqual([bad.spf, bad.dkim, bad.dmarc], [false, false, false]);
  assert.ok(bad.fixes.some((f) => f.includes('include:_spf.mail.hostinger.com')));
  const good = evaluateDns({ domain: 'a.com', type: 'hostinger', spf: ['v=spf1 include:_spf.mail.hostinger.com ~all'], dmarc: ['v=DMARC1; p=quarantine'], dkimSelector: 'hostingermail-a' });
  assert.deepEqual([good.spf, good.dkim, good.dmarc, good.fixes.length], [true, true, true, 0]);
  assert.equal(evaluateDns({ domain: 'a.com', type: 'smtp', spf: ['v=spf1 +all'], dmarc: [], dkimSelector: 'x' }).spf, false);
  assert.equal(evaluateDns({ domain: 'a.com', type: 'smtp', spf: ['v=spf1 a ~all', 'v=spf1 mx ~all'], dmarc: [], dkimSelector: 'x' }).spf, false);
});

test('computeStats counts per day, mailbox and campaign with rates', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const acc = { id: 'a1', label: 'Sales', fromEmail: 's@x.com', limit: 100, stats: { sent: 0, hard: 0, soft: 0, consecutive: 0, restUntil: 0, lastError: '' } } as never;
  const camp = { id: 'c1', name: 'C', status: 'done', createdAt: '' } as never;
  const mk = (email: string, status: string, extra: object = {}) => ({ email, name: '', vars: {}, status, acc: 'Sales', accId: 'a1', at: '2026-11-04T08:00:00Z', error: '', ...extra });
  const rs = [mk('1@a.com', 'sent', { repliedAt: '2026-11-04T09:00:00Z' }), mk('2@a.com', 'bounced', { bouncedAt: '2026-11-04T09:30:00Z' }), mk('3@a.com', 'sent'), mk('4@a.com', 'sent', { unsubAt: '2026-11-04T10:00:00Z' })] as never[];
  const s = computeStats([acc], [camp], () => rs, 7, now);
  assert.equal(s.totals.sent, 4); assert.equal(s.totals.bounced, 1); assert.equal(s.totals.replied, 1);
  assert.equal(s.totals.bounceRate, 25); assert.equal(s.totals.replyRate, 25);
  assert.equal(s.mailboxes[0].sent, 4); assert.equal(s.campaigns[0].unsubscribed, 1);
  assert.equal(s.days.length, 7); assert.equal(s.days[6].sent, 4);
});
