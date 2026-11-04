import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';
import { sleep, fail } from '../util.js';
import { db, type Account } from '../store.js';
import type { OutMessage } from './template.js';

export const TYPES: Record<string, string> = { hostinger: 'Hostinger', smtp: 'SMTP', brevo: 'Brevo', zepto: 'ZeptoMail' };
export const ZEPTO_REGIONS = ['in', 'com', 'eu', 'com.au', 'jp', 'ca', 'sa'];
export const isSmtp = (a: Pick<Account, 'type'>) => a.type === 'hostinger' || a.type === 'smtp';

export type SendError = Error & { status: number };
const sendErr = (message: string, status: number): SendError => Object.assign(new Error(message), { status });

async function fetchT(url: string, opt: RequestInit, ms = 60000): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opt, signal: ctl.signal }); }
  catch (e) {
    const err = e as Error & { cause?: Error };
    throw sendErr(err.name === 'AbortError' ? 'Request timed out' : 'Network error: ' + (err.cause?.message || err.message), 0);
  } finally { clearTimeout(t); }
}

async function check(res: Response): Promise<Record<string, unknown>> {
  const txt = await res.text().catch(() => '');
  let j: any = null;
  try { j = JSON.parse(txt); } catch { /* not JSON */ }
  if (!res.ok) {
    let msg = (j && (j.error?.details?.[0]?.message || j.error?.message || j.message || j.error)) || txt || res.statusText;
    if (typeof msg !== 'string') msg = JSON.stringify(msg);
    throw sendErr(`${res.status} ${msg}`.slice(0, 300), res.status);
  }
  return j || {};
}

const pools = new Map<string, nodemailer.Transporter>();
const poolKey = (a: Account) => [a.host, a.port, a.secure, a.user, a.pass].join('|');
function transport(a: Account) {
  const k = poolKey(a);
  if (!pools.has(k)) {
    pools.set(k, nodemailer.createTransport({
      host: a.host, port: a.port, secure: a.secure, auth: { user: a.user, pass: a.pass },
      pool: true, maxConnections: 1, connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 90000,
    }));
  }
  return pools.get(k)!;
}
export function closeTransport(a: Account) { const k = poolKey(a); pools.get(k)?.close(); pools.delete(k); }

function smtpStatus(err: any): number {
  if (err.code === 'EAUTH') return 401;
  if (err.code === 'EENVELOPE' || err.command === 'RCPT TO') return 422;
  if ([421, 450, 451, 452, 454].includes(err.responseCode)) return 429;
  return 502;
}

/** Simulated delivery used in Test Sandbox mode. Recipients containing "bounce" hard-bounce, "softfail" soft-bounce; a mailbox whose From contains "authfail" fails login. */
async function sendSandbox(acc: Account, m: OutMessage) {
  await sleep(80 + Math.random() * 220);
  if (/authfail/i.test(acc.fromEmail)) throw sendErr('535 Sandbox: authentication failed', 401);
  if (/bounce/i.test(m.to)) throw sendErr('550 Sandbox: mailbox does not exist', 422);
  if (/softfail/i.test(m.to)) throw sendErr('451 Sandbox: temporary local problem', 429);
  return { messageId: `<sandbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@nexusmail.local>`, sandbox: true };
}

export async function sendVia(acc: Account, m: OutMessage, opts: { forceLive?: boolean } = {}): Promise<{ messageId?: string; sandbox?: boolean }> {
  if (db.settings.mode === 'sandbox' && !opts.forceLive) return sendSandbox(acc, m);
  if (acc.type === 'brevo') {
    const body: Record<string, unknown> = {
      sender: { name: acc.fromName || undefined, email: acc.fromEmail },
      to: [m.toName ? { email: m.to, name: m.toName } : { email: m.to }],
      subject: m.subject, htmlContent: m.html, textContent: m.text, headers: m.headers,
    };
    if (acc.replyTo) body.replyTo = { email: acc.replyTo };
    if (m.attachments.length) body.attachment = m.attachments.map((a) => ({ name: a.name, content: a.b64 }));
    const r = await check(await fetchT('https://api.brevo.com/v3/smtp/email', {
      method: 'POST', headers: { 'api-key': acc.apiKey || '', 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
    }));
    return { messageId: r.messageId as string | undefined };
  }
  if (acc.type === 'zepto') {
    const key = acc.apiKey || '';
    const token = /^zoho-enczapikey/i.test(key) ? key : 'Zoho-enczapikey ' + key;
    const body: Record<string, unknown> = {
      from: { address: acc.fromEmail, name: acc.fromName || undefined },
      to: [{ email_address: m.toName ? { address: m.to, name: m.toName } : { address: m.to } }],
      subject: m.subject, htmlbody: m.html, textbody: m.text, mime_headers: m.headers,
    };
    if (acc.replyTo) body.reply_to = [{ address: acc.replyTo }];
    if (m.attachments.length) body.attachments = m.attachments.map((a) => ({ name: a.name, mime_type: a.type, content: a.b64 }));
    const r = await check(await fetchT(`https://api.zeptomail.${acc.region || 'in'}/v1.1/email`, {
      method: 'POST', headers: { Authorization: token, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body),
    }));
    return { messageId: r.request_id as string | undefined };
  }
  try {
    const info = await transport(acc).sendMail({
      from: { name: acc.fromName || '', address: acc.fromEmail },
      to: m.toName ? { name: m.toName, address: m.to } : m.to,
      replyTo: acc.replyTo || undefined,
      subject: m.subject, html: m.html, text: m.text, headers: m.headers, inReplyTo: m.inReplyTo,
      attachments: m.attachments.map((a) => ({ filename: a.name, content: a.b64, encoding: 'base64', contentType: a.type || undefined })),
    });
    return { messageId: info.messageId };
  } catch (err: any) {
    if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET'].includes(err.code)) closeTransport(acc);
    throw sendErr(err.message, smtpStatus(err));
  }
}

/** Real connectivity/auth test: SMTP handshake (verify) or a read-only provider API call. */
export async function testAccount(acc: Account): Promise<string> {
  if (db.settings.mode === 'sandbox') { await sleep(300); return 'Sandbox handshake OK (no real connection made — switch to Live to test credentials)'; }
  if (isSmtp(acc)) {
    try { await transport(acc).verify(); return `SMTP handshake and login OK (${acc.host}:${acc.port})`; }
    catch (e: any) { closeTransport(acc); throw sendErr(e.message, smtpStatus(e)); }
  }
  if (acc.type === 'brevo') {
    const r = await check(await fetchT('https://api.brevo.com/v3/account', { headers: { 'api-key': acc.apiKey || '', accept: 'application/json' } }, 20000));
    return `Brevo API key OK${r.email ? ' (' + r.email + ')' : ''}`;
  }
  // ZeptoMail has no read-only endpoint; an invalid token is rejected with 401/403 before body validation.
  const key = acc.apiKey || '';
  const token = /^zoho-enczapikey/i.test(key) ? key : 'Zoho-enczapikey ' + key;
  const res = await fetchT(`https://api.zeptomail.${acc.region || 'in'}/v1.1/email`, {
    method: 'POST', headers: { Authorization: token, 'content-type': 'application/json', accept: 'application/json' }, body: '{}',
  }, 20000);
  if (res.status === 401 || res.status === 403) throw sendErr('ZeptoMail rejected the token (check the token and data centre region)', 401);
  return 'ZeptoMail token accepted (a test email confirms the sender domain is verified)';
}

async function txt(name: string): Promise<string[]> {
  try { return (await dns.resolveTxt(name)).map((r) => r.join('')); } catch { return []; }
}
export async function checkDns(email: string) {
  const domain = email.split('@')[1];
  if (!domain) throw fail('Invalid email');
  const [root, dmarc] = await Promise.all([txt(domain), txt('_dmarc.' + domain)]);
  const spf = root.some((t) => /^v=spf1/i.test(t));
  const dm = dmarc.some((t) => /^v=DMARC1/i.test(t));
  let dkim = false;
  for (const sel of ['default', 'google', 'selector1', 'selector2', 's1', 's2', 'k1', 'hostingermail-a', 'hostingermail-b', 'brevo1', 'brevo2', 'zmail', 'zoho']) {
    if ((await txt(`${sel}._domainkey.${domain}`)).some((t) => /v=DKIM1|p=/i.test(t))) { dkim = true; break; }
  }
  return { spf, dkim, dmarc: dm, checkedAt: new Date().toISOString() };
}

/** Sends a pre-built RFC 822 message through the mailbox's SMTP account (used by the Mail view). */
export async function sendRawSmtp(acc: Account, raw: Buffer, from: string, to: string[]) {
  if (!isSmtp(acc)) throw sendErr('This mailbox sends through an API, not SMTP.', 400);
  try { return await transport(acc).sendMail({ envelope: { from, to }, raw }); }
  catch (err: any) {
    if (['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET'].includes(err.code)) closeTransport(acc);
    throw sendErr(err.message, smtpStatus(err));
  }
}
