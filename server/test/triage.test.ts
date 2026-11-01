import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusmail-triage-'));
delete process.env.GEMINI_API_KEY;
const T = await import('../ai/triage.js');
type Facts = Parameters<typeof T.signals>[0];

const ctx = (): Parameters<typeof T.signals>[1] => ({ sentMessageIds: new Set(['sent-1@x']), knownContacts: new Set(['lead@acme.com']) });
const agent = { allowList: ['@vip.com'], blockList: ['spammer.biz'], trashThreshold: 0.9 };
const mail = (o: Partial<Facts>): Facts => ({ from: 'someone@example.org', fromName: 'Someone', subject: 'Hello', text: 'Hi', headers: {}, ...o });

test('bulk-mail headers and automated senders are junk signals', () => {
  const s = T.signals(mail({ from: 'no-reply@shop.com', headers: { 'list-unsubscribe': '<mailto:x>', precedence: 'bulk' } }), ctx(), agent);
  assert.ok(s.junk.length >= 3);
  assert.equal(s.keep.length, 0);
});

test('replies to our message, known contacts and allow-listed senders are keep signals', () => {
  assert.ok(T.signals(mail({ inReplyTo: '<sent-1@x>' }), ctx(), agent).keep.length);
  assert.ok(T.signals(mail({ from: 'lead@acme.com' }), ctx(), agent).keep.length);
  assert.ok(T.signals(mail({ from: 'boss@vip.com' }), ctx(), agent).keep.length);
});

test('block list matches by domain', () => {
  assert.equal(T.signals(mail({ from: 'a@spammer.biz' }), ctx(), agent).blocked, true);
});

test('real customer question is kept even without an API key', () => {
  const f = mail({ subject: 'Pricing for 10 mailboxes', text: 'Hi, how much does your plan cost and can I get a demo?' });
  const s = T.signals(f, ctx(), agent);
  const v = T.heuristicVerdict(f, s);
  assert.equal(T.decide(v, s, agent).action, 'keep');
});

test('the offline classifier never trashes, it holds', () => {
  const f = mail({ from: 'news@brand.com', subject: 'Weekly newsletter', text: 'view in browser, unsubscribe', headers: { 'list-unsubscribe': '<x>' } });
  const s = T.signals(f, ctx(), agent);
  const v = T.heuristicVerdict(f, s);
  assert.equal(v.category, 'newsletter');
  assert.equal(T.decide(v, s, agent).action, 'hold');
});

test('policy trashes only confident Gemini discard verdicts without keep signals', () => {
  const s = T.signals(mail({ from: 'promo@brand.com' }), ctx(), agent);
  const v = (confidence: number, category: any = 'promotion') => ({ category, confidence, reasoning: 'x', engine: 'gemini' as const });
  assert.equal(T.decide(v(0.95), s, agent).action, 'trash');
  assert.equal(T.decide(v(0.8), s, agent).action, 'hold');
  assert.equal(T.decide(v(0.99, 'vendor_invoice'), s, agent).action, 'hold');
  assert.equal(T.decide(v(0.99, 'legal_security'), s, agent).action, 'hold');
  assert.equal(T.decide(v(0.99, 'product_question'), s, agent).action, 'keep');
  const known = T.signals(mail({ from: 'lead@acme.com' }), ctx(), agent);
  assert.equal(T.decide(v(0.99), known, agent).action, 'hold'); // out-of-office from a lead is not deleted
});

test('block list trashes without a model, unless a keep signal exists', () => {
  const s = T.signals(mail({ from: 'a@spammer.biz' }), ctx(), agent);
  assert.equal(T.decide({ category: 'blocked', confidence: 1, reasoning: '', engine: 'rule' }, s, agent).action, 'trash');
  const s2 = T.signals(mail({ from: 'a@spammer.biz', inReplyTo: 'sent-1@x' }), ctx(), agent);
  assert.notEqual(T.decide({ category: 'promotion', confidence: 1, reasoning: '', engine: 'gemini' }, s2, agent).action, 'trash');
});

test('processInbound in dry-run logs but never reports an applied trash', async () => {
  const { processInbound } = await import('../agent.js');
  const { db } = await import('../store.js');
  db.settings.agent.blockList = ['spammer.biz'];
  const r = await processInbound(mail({ from: 'x@spammer.biz', messageId: '<m1@s>' }), 'acc1', 1);
  assert.deepEqual([r.action, r.applied], ['trash', false]);
  assert.equal(db.agentLog[0].action, 'would_trash');
  const again = await processInbound(mail({ from: 'x@spammer.biz', messageId: '<m1@s>' }), 'acc1', 1);
  assert.equal(again.skipped, true); // same mail is not logged twice
  db.settings.agent.dryRun = false;
  const live = await processInbound(mail({ from: 'y@spammer.biz', messageId: '<m2@s>' }), 'acc1', 2);
  assert.deepEqual([live.action, live.applied], ['trash', true]);
  const kept = await processInbound(mail({ from: 'buyer@corp.com', subject: 'Quote', text: 'I want a quote and pricing please', messageId: '<m3@s>' }), 'acc1', 3);
  assert.equal(kept.action, 'keep');
  assert.ok(db.conversations.some((c) => c.contactHandle === 'buyer@corp.com'));
});
