import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusmail-test-'));
const { personalize, parseRecipients, buildMessage } = await import('../engine/template.js');
const { healthScore, newStats, volumeFactor, recordOutcome } = await import('../engine/balancer.js');
type Acc = Parameters<typeof healthScore>[0];
const acc = (): Acc => ({ id: 'a', type: 'smtp', label: 'a', fromName: '', fromEmail: 'a@x.com', replyTo: '', limit: 100, enabled: true, stats: newStats() });

test('personalize fills camelCase and snake_case variables with defaults', () => {
  const r = { email: 'p@x.com', name: 'Priya Sharma', vars: { company: 'Acme' } };
  assert.equal(personalize('Hi {{firstName}} at {{company}} / {{city|there}}', r, false), 'Hi Priya at Acme / there');
  assert.match(personalize('{Hello|Hi}', r, false), /^(Hello|Hi)$/);
});

test('parseRecipients reads CSV columns, drops invalid rows', () => {
  const { list, invalid } = parseRecipients('email,name,company\na@x.com,Ann,Acme\nnot-an-email,Bob,Z\n');
  assert.equal(list.length, 1);
  assert.equal(invalid, 1);
  assert.equal(list[0].vars.company, 'Acme');
});

test('buildMessage always carries an unsubscribe header', () => {
  const m = buildMessage({ subject: 'S', body: 'B', footer: '' }, { email: 'p@x.com', name: '', vars: {} }, { fromEmail: 'a@x.com' }, []);
  assert.ok(m.headers['List-Unsubscribe']);
  assert.match(m.html, /Unsubscribe/);
});

test('health score drops with hard bounces and cuts volume share', () => {
  const a = acc();
  assert.equal(healthScore(a), 100);
  for (let i = 0; i < 6; i++) recordOutcome(a, 'sent');
  for (let i = 0; i < 4; i++) recordOutcome(a, 'hard', 'x');
  assert.ok(healthScore(a) < 50);
  assert.ok(volumeFactor(a) < 1);
});

test('a pasted list works however the addresses are separated', () => {
  const emails = (t: string) => parseRecipients(t).list.map((r) => r.email);
  assert.deepEqual(emails('a@x.com, b@y.com, c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']); // one line
  assert.deepEqual(emails('a@x.com; b@y.com;c@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(emails('a@x.com b@y.com\tc@z.com'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(emails('a@x.com\r\nb@y.com\r\n\r\nc@z.com\r\n'), ['a@x.com', 'b@y.com', 'c@z.com']);
  assert.deepEqual(emails('Maria <m@buyer.com>\nKim Lee, kim@ok.example'), ['m@buyer.com', 'kim@ok.example']);
  assert.equal(parseRecipients('Maria Buyer, maria@buyer.com').list[0].name, 'Maria Buyer');
  assert.deepEqual(emails('email,name\na@x.com,A\nb@y.com,B'), ['a@x.com', 'b@y.com']); // header CSV unchanged
});
