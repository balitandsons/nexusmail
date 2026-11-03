import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusmail-sec-'));
process.env.DATA_DIR = dir;
process.env.DATA_ENCRYPTION_KEY = 'unit-test-key-0123456789';
const A = await import('../auth.js');
const C = await import('../crypto.js');

test('scrypt hashes verify and reject wrong passwords', async () => {
  const h = await A.hashPassword('correct horse battery');
  assert.ok(await A.verifyPassword('correct horse battery', h));
  assert.ok(!(await A.verifyPassword('wrong', h)));
});

test('TOTP matches the RFC 6238 SHA-1 test vector', () => {
  const secret = A.base32(Buffer.from('12345678901234567890'));
  assert.equal(A.totpAt(secret, Math.floor(59 / 30)), '287082'); // RFC 6238 appendix B, t=59 -> 94287082 (last 6 digits)
  assert.ok(A.verifyTotp(secret, A.totpAt(secret, Math.floor(1111111109 / 30)), 1111111109 * 1000));
  assert.ok(!A.verifyTotp(secret, '000000', 1111111109 * 1000));
});

test('AES-GCM round trip, tamper detection and idempotence', () => {
  assert.ok(C.encryptionEnabled);
  const e = C.encrypt('mailbox-password');
  assert.ok(C.isEncrypted(e) && e !== 'mailbox-password');
  assert.equal(C.decrypt(e), 'mailbox-password');
  assert.equal(C.encrypt(e), e);
  const bad = e.slice(0, -4) + (e.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => C.decrypt(bad));
});

test('role policy: viewer reads, operator runs campaigns, only admin changes mailboxes/users', () => {
  assert.ok(A.allowed('viewer', 'GET', '/campaigns'));
  assert.ok(!A.allowed('viewer', 'POST', '/campaigns'));
  assert.ok(A.allowed('viewer', 'POST', '/account/password'));
  assert.ok(A.allowed('operator', 'POST', '/campaigns/abc/start'));
  assert.ok(A.allowed('operator', 'POST', '/mailboxes/abc/test'));
  assert.ok(!A.allowed('operator', 'POST', '/mailboxes'));
  assert.ok(!A.allowed('operator', 'PUT', '/settings'));
  assert.ok(!A.allowed('operator', 'GET', '/users'));
  assert.ok(A.allowed('admin', 'DELETE', '/users/1'));
});

test('db.json stores secrets encrypted and reloads them decrypted', async () => {
  const S = await import('../store.js');
  S.db.accounts.push({ id: 'a', type: 'smtp', label: 'x', fromName: '', fromEmail: 'a@b.co', replyTo: '', limit: 1, enabled: true, pass: 'hunter2-secret', stats: { sent: 0, hard: 0, soft: 0, consecutive: 0, restUntil: 0, lastError: '' } });
  S.markDirty(); S.flush();
  const raw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
  assert.ok(!raw.includes('hunter2-secret'));
  assert.ok(raw.includes('enc:v1:'));
});
