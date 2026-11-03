import crypto from 'node:crypto';

/**
 * AES-256-GCM for secrets stored in db.json (mailbox passwords, API keys, Meta tokens, 2FA seeds).
 * The key comes from the DATA_ENCRYPTION_KEY environment variable, never from the data folder, so a copy of
 * the data folder alone does not reveal the secrets. Without the variable, values stay plain (as before).
 */
const PREFIX = 'enc:v1:';
const KEY = process.env.DATA_ENCRYPTION_KEY ? crypto.scryptSync(process.env.DATA_ENCRYPTION_KEY, 'nexusmail-data-v1', 32) : null;

export const encryptionEnabled = !!KEY;
export const isEncrypted = (s: unknown): s is string => typeof s === 'string' && s.startsWith(PREFIX);

export function encrypt(plain: string): string {
  if (!KEY || !plain || isEncrypted(plain)) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(value: string): string {
  if (!isEncrypted(value)) return value;
  if (!KEY) throw new Error('db.json contains encrypted secrets but DATA_ENCRYPTION_KEY is not set. Set the same key you used before.');
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  try { return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'); }
  catch { throw new Error('Could not decrypt db.json: DATA_ENCRYPTION_KEY is different from the one used to save it.'); }
}
