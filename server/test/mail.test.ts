import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nexusmail-mail-'));
const { cleanHtml } = await import('../mail.js');

test('cleanHtml removes scripts, handlers and javascript: links but keeps formatting', () => {
  const out = cleanHtml('<h2 style="color:red">Hi</h2><script>alert(1)</script><img src="x" onerror="alert(2)"><a href="javascript:alert(3)">x</a><iframe src="https://e.com"></iframe><p>ok</p>', new Map());
  assert.ok(!/script|alert|onerror|iframe|javascript:/i.test(out));
  assert.ok(out.includes('<h2 style="color:red">Hi</h2>') && out.includes('<p>ok</p>'));
});

test('cleanHtml inlines cid images as data URIs', () => {
  const out = cleanHtml('<img src="cid:logo@x">', new Map([['logo@x', 'data:image/png;base64,AAA']]));
  assert.ok(out.includes('data:image/png;base64,AAA'));
});
