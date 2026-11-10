import fs from 'node:fs';
import path from 'node:path';
import { EMAIL_RE, FILES, esc, hmac, safeEq } from '../util.js';
import { db, type Account, type Campaign, type Recipient } from '../store.js';

export interface OutMessage {
  to: string;
  toName: string;
  subject: string;
  html: string;
  text: string;
  attachments: { name: string; type: string; b64: string }[];
  headers: Record<string, string>;
  inReplyTo?: string;
}

export const normKey = (k: string) => String(k).toLowerCase().trim().replace(/[\s-]+/g, '_');

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === '\t' || c === ';') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some(Boolean));
}

const ANY_EMAIL = /[^\s@<>,;"'()[\]|]+@[^\s@<>,;"'()[\]|]+\.[^\s@<>,;"'()[\]|]{2,}/g;

export function parseRecipients(text: string): { list: Pick<Recipient, 'email' | 'name' | 'vars'>[]; invalid: number } {
  const rows = parseCSV(String(text || '').replace(/^﻿/, ''));
  const out: Pick<Recipient, 'email' | 'name' | 'vars'>[] = [];
  let invalid = 0;
  if (!rows.length) return { list: out, invalid };
  const header = rows[0].map(normKey);
  const ei = header.findIndex((h) => /^(e_?mail|email_address|mail)$/.test(h));
  if (ei >= 0) {
    const ni = header.findIndex((h) => /^(name|full_name|first_name|firstname)$/.test(h));
    for (const r of rows.slice(1)) {
      const email = (r[ei] || '').toLowerCase();
      if (!EMAIL_RE.test(email)) { invalid++; continue; }
      const vars: Record<string, string> = {};
      header.forEach((h, i) => { if (h) vars[h] = r[i] || ''; });
      out.push({ email, name: ni >= 0 ? r[ni] || '' : '', vars });
    }
  } else {
    // No header row: every email address on every row is a recipient, however they are separated
    // (one per line, or a single line separated by commas, semicolons, spaces or tabs; "Name <a@b.com>" also works).
    for (const r of rows) {
      const found = [...r.join(' ').matchAll(ANY_EMAIL)].map((m) => m[0].toLowerCase());
      if (!found.length) { invalid++; continue; }
      const name = found.length === 1 ? r.find((c) => c && !c.includes('@') && !/^<.*>$/.test(c)) || '' : '';
      for (const email of found) out.push({ email, name, vars: {} });
    }
  }
  return { list: out, invalid };
}

const unsubToken = (email: string) => Buffer.from(email).toString('base64url') + '.' + hmac('u' + email).slice(0, 16);
export function parseUnsub(tok: string): string | null {
  const [e, s] = String(tok).split('.');
  try {
    const email = Buffer.from(e, 'base64url').toString();
    return s && EMAIL_RE.test(email) && safeEq(s, hmac('u' + email).slice(0, 16)) ? email : null;
  } catch { return null; }
}
export function unsubUrl(email: string) {
  const base = (db.settings.publicUrl || '').replace(/\/+$/, '');
  return base ? `${base}/u/${unsubToken(email)}` : '';
}

type Rec = Pick<Recipient, 'email' | 'name' | 'vars'>;

/** {{firstName}} / {{company|there}} (any CSV column, camelCase or snake_case) and {Hi|Hello} spin text. */
export function personalize(src: string, r: Rec, escapeVals: boolean, extra: Record<string, string> = {}): string {
  const first = (r.name || '').trim().split(/\s+/)[0] || '';
  const get = (k: string): string => {
    const key = normKey(k.replace(/([a-z])([A-Z])/g, '$1_$2'));
    if (key in extra) return extra[key];
    if (key === 'email') return r.email;
    if (key === 'name' || key === 'full_name') return r.name || '';
    if (key === 'first_name' || key === 'firstname') return first || (r.vars || {}).first_name || '';
    return (r.vars || {})[key] ?? '';
  };
  let out = String(src).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, expr: string) => {
    const [k, def = ''] = expr.split('|');
    const v = String(get(k) || def.trim());
    return escapeVals ? esc(v) : v;
  });
  out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_m, o: string) => { const p = o.split('|'); return p[Math.floor(Math.random() * p.length)]; });
  return out;
}

function decodeEntities(s: string) {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (named[e.toLowerCase()] !== undefined) return named[e.toLowerCase()];
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return m;
  });
}
export function htmlToText(html: string) {
  return decodeEntities(html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h\d|li|tr)>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function toHtml(src: string, r: Rec, extra: Record<string, string>) {
  if (/<[a-z][\s\S]*>/i.test(src)) return personalize(src, r, true, extra);
  return esc(personalize(src, r, false, extra)).replace(/\n/g, '<br>');
}

export function buildMessage(c: Pick<Campaign, 'subject' | 'body' | 'footer'>, r: Rec, acc: Pick<Account, 'fromEmail'>, atts: OutMessage['attachments']): OutMessage {
  const url = unsubUrl(r.email);
  const mailto = `mailto:${acc.fromEmail}?subject=unsubscribe`;
  const extra = { unsubscribe_url: url || mailto };
  const body = toHtml(c.body, r, extra);
  let footer = c.footer.trim() ? toHtml(c.footer, r, extra) : '';
  if (db.settings.autoUnsub && !/unsubscribe_url/i.test(c.body + c.footer)) {
    footer += `${footer ? '<br><br>' : ''}<a href="${esc(extra.unsubscribe_url)}" style="color:#888">Unsubscribe</a>`;
  }
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222">${body}${footer ? `<div style="margin-top:28px;padding-top:12px;border-top:1px solid #eee;color:#888;font-size:12px">${footer}</div>` : ''}</div>`;
  const headers: Record<string, string> = { 'List-Unsubscribe': url ? `<${url}>, <${mailto}>` : `<${mailto}>` };
  if (url.startsWith('https://')) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return { to: r.email, toName: r.name || '', subject: personalize(c.subject, r, false, extra), html, text: htmlToText(html), attachments: atts, headers };
}

export function loadAttachments(c: Campaign): OutMessage['attachments'] {
  return c.attachments.map((f) => ({ name: f.name, type: f.type, b64: fs.readFileSync(path.join(FILES, c.id, f.file)).toString('base64') }));
}
