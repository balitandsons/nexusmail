import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusmail-crm-'));
delete process.env.GEMINI_API_KEY;
const S = await import('../store.js');
const C = await import('../crm.js');
const K = await import('../ai/knowledge.js');
const H = await import('../handoff.js');
const A = await import('../ai/agent.js');

test('contacts merge by email and by phone digits, and keep the first real name', () => {
  const a = C.upsertContact({ email: 'Maria@Buyer.com', name: 'Maria B', company: 'Buyer Ltd' })!;
  const b = C.upsertContact({ email: 'maria@buyer.com', phone: '+91 98765-43210' })!;
  assert.equal(a.id, b.id);
  const c = C.upsertContact({ phone: '919876543210', name: 'Someone Else' })!;
  assert.equal(c.id, a.id);
  assert.equal(c.name, 'Maria B');
  assert.deepEqual([c.emails.length, c.phones.length], [1, 1]);
  assert.equal(C.upsertContact({ email: 'not-an-email' }), null);
});

test('stages only move forward, manual stages and lost are respected', () => {
  const c = C.upsertContact({ email: 'lead@x.com' })!;
  C.advance(c, 'contacted'); C.advance(c, 'interested'); C.advance(c, 'replied');
  assert.equal(c.stage, 'interested');
  c.stage = 'customer'; c.stageManual = true; C.advance(c, 'interested');
  assert.equal(c.stage, 'customer');
  const d = C.upsertContact({ email: 'gone@x.com' })!;
  C.touchUnsub('gone@x.com'); C.advance(d, 'interested');
  assert.equal(d.stage, 'lost'); assert.ok(d.tags.includes('unsubscribed'));
});

test('inbound intent moves the stage and unsubscribe marks lost', () => {
  C.touchInbound({ email: 'p@x.com', name: 'P' }, 'pricing_question');
  assert.equal(C.findContact('p@x.com')!.stage, 'interested');
  C.touchInbound({ email: 'q@x.com' }, 'unsubscribe');
  assert.equal(C.findContact('q@x.com')!.stage, 'lost');
});

test('knowledge search ranks the right entry and returns nothing for unrelated questions', () => {
  K.saveEntry({ title: 'Shipping and delivery times', text: 'We ship across India in 3 to 5 working days. Express delivery to metro cities takes 1 to 2 days.\n\nInternational shipping is not available yet.' });
  K.saveEntry({ title: 'Refund policy', text: 'Unopened products can be returned within 14 days for a full refund. Opened products are not refundable.' });
  K.saveEntry({ title: 'Wholesale pricing', text: 'Wholesale orders above 50 units get tiered discounts. Contact sales for a quote.' });
  assert.equal(K.searchKnowledge('How many days does delivery take to Mumbai?')[0].title, 'Shipping and delivery times');
  assert.equal(K.searchKnowledge('can I return an opened item for a refund')[0].title, 'Refund policy');
  assert.equal(K.searchKnowledge('quantum chromodynamics lattice').length, 0);
});

test('Q/A and heading imports are parsed', () => {
  assert.equal(K.parseImport('Q: Do you ship abroad?\nA: Not yet.\n\nQ: Return window?\nA: 14 days.').length, 2);
  assert.deepEqual(K.parseImport('# Warranty\nOne year.\n# Support\nEmail us.').map((x) => x.title), ['Warranty', 'Support']);
});

test('handoff rules catch keywords, negative sentiment and VIPs', () => {
  assert.match(H.handoffReason('I want a REFUND now', { sentiment: 'neutral' }, null) || '', /refund/);
  assert.equal(H.handoffReason('I want the prefund report', { sentiment: 'neutral' }, null), null);
  assert.match(H.handoffReason('hello', { sentiment: 'negative' }, null) || '', /unhappy/);
  assert.match(H.handoffReason('hello', { sentiment: 'positive' }, { tags: ['vip'] }) || '', /VIP/);
  S.db.settings.handoff.enabled = false;
  assert.equal(H.handoffReason('refund', { sentiment: 'negative' }, null), null);
  S.db.settings.handoff.enabled = true;
});

test('offline replies quote the knowledge base and ungrounded factual answers are capped', async () => {
  const conv = (text: string) => ({ id: 'x', channel: 'email', contactName: 'Asha Rao', contactHandle: 'a@x.com', subject: '', messages: [{ id: '1', dir: 'in', by: 'contact', text, at: '' }], status: 'needs_review', unread: true, updatedAt: '' }) as never;
  const grounded = await A.analyze(conv('How much does wholesale pricing cost? I need a price quote'), 'How much does wholesale pricing cost? I need a price quote');
  assert.ok(grounded.sources?.includes('Wholesale pricing'));
  assert.match(grounded.suggestedReply, /tiered discounts/);
  const ungrounded = await A.analyze(conv('What is the price of the gold plan?'), 'What is the price of the gold plan?');
  assert.ok(ungrounded.confidence <= 0.75);
});
