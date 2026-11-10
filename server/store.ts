import fs from 'node:fs';
import path from 'node:path';
import { DATA, RECIPS } from './util.js';
import { decrypt, encrypt } from './crypto.js';

export type Provider = 'hostinger' | 'smtp' | 'brevo' | 'zepto';

export interface Account {
  id: string;
  type: Provider;
  label: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  limit: number;
  enabled: boolean;
  daily?: { date: string; count: number };
  apiKey?: string;
  region?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  imap?: { enabled: boolean; host: string; port: number; secure: boolean };
  stats: { sent: number; hard: number; soft: number; consecutive: number; restUntil: number; lastError: string };
  dns?: { spf: boolean; dkim: boolean; dmarc: boolean; checkedAt: string; fixes?: string[]; dmarcPolicy?: string };
  /** Gradually raises the daily limit for a new mailbox: startLimit + rampPerDay x days since startDate, capped at `limit`. */
  warmup?: { enabled: boolean; startDate: string; startLimit: number; rampPerDay: number };
}

export interface Attachment { id: string; name: string; type: string; size: number; file: string }

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  body: string;
  footer: string;
  minDelay: number;
  maxDelay: number;
  volumePerMailbox: number;
  accountIds: string[];
  autoResume: boolean;
  attachments: Attachment[];
  status: 'draft' | 'running' | 'paused' | 'scheduled' | 'done';
  createdAt: string;
}

export interface Recipient {
  email: string;
  name: string;
  vars: Record<string, string>;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'bounced';
  acc: string;
  accId?: string;
  messageId?: string;
  attempts?: number;
  bouncedAt?: string;
  repliedAt?: string;
  unsubAt?: string;
  at: string;
  error: string;
}

export type Channel = 'email' | 'whatsapp' | 'instagram' | 'messenger';
export type Intent = 'lead_interested' | 'pricing_question' | 'support_request' | 'objection' | 'unsubscribe' | 'spam' | 'other';

export interface Analysis {
  intent: Intent;
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
  summary: string;
  suggestedReply: string;
  reasons: string;
  engine: 'gemini' | 'heuristic';
  /** Titles of the knowledge-base entries the draft was grounded in. */
  sources?: string[];
}

export interface Message { id: string; dir: 'in' | 'out'; by: 'contact' | 'ai' | 'human'; text: string; at: string; sandbox?: boolean }

export interface Conversation {
  id: string;
  channel: Channel;
  contactName: string;
  contactHandle: string; // email, phone, IG/FB scoped id
  subject: string;
  accountId?: string;
  messages: Message[];
  analysis?: Analysis;
  status: 'auto_replied' | 'needs_review' | 'replied' | 'closed';
  held?: boolean;
  heldReason?: string;
  unread: boolean;
  updatedAt: string;
}

export interface AgentSettings {
  enabled: boolean;
  /** When true the agent only logs what it WOULD trash and never touches a mailbox. */
  dryRun: boolean;
  trashThreshold: number;
  allowList: string[];
  blockList: string[];
}

export interface AgentLogEntry {
  id: string;
  at: string;
  accountId: string;
  from: string;
  subject: string;
  category: string;
  confidence: number;
  action: 'trashed' | 'would_trash' | 'kept' | 'held';
  reason: string;
  engine: 'gemini' | 'heuristic' | 'rule';
  messageId: string;
  key: string;
  restored?: boolean;
}

export type Stage = 'new' | 'contacted' | 'replied' | 'interested' | 'customer' | 'lost';
export interface Contact {
  id: string;
  name: string;
  emails: string[];
  phones: string[];
  company: string;
  /** Indian state or region, used to filter and target lists. */
  state?: string;
  tags: string[];
  stage: Stage;
  /** True once a person set the stage by hand: automation then leaves it alone. */
  stageManual?: boolean;
  source: string;
  notes: { id: string; at: string; by: string; text: string }[];
  createdAt: string;
  lastActivityAt: string;
}
export interface KnowledgeEntry { id: string; title: string; text: string; tags: string[]; updatedAt: string }
export interface Handoff {
  enabled: boolean;
  /** Messages containing any of these words always go to a person. */
  keywords: string[];
  /** Messages the AI reads as negative always go to a person. */
  negative: boolean;
  /** Contacts carrying the tag "vip" always go to a person. */
  vip: boolean;
  /** Where "needs your review" alerts are emailed, and which mailbox sends them. */
  notifyEmail: string;
  notifyAccountId: string;
}
export const DEFAULT_HANDOFF: Handoff = { enabled: true, keywords: ['refund', 'cancel', 'lawyer', 'legal', 'complaint', 'chargeback', 'discount', 'contract'], negative: true, vip: true, notifyEmail: '', notifyAccountId: '' };

export interface Settings {
  handoff: Handoff;
  agent: AgentSettings;
  mode: 'sandbox' | 'live';
  publicUrl: string;
  testEmail: string;
  autoUnsub: boolean;
  defaultMin: number;
  defaultMax: number;
  aiEnabled: boolean;
  /** Max Gemini calls per day (keeps the API bill near zero). Over the cap, the offline classifier is used. */
  aiDailyLimit: number;
  autopilot: boolean;
  confidenceThreshold: number;
  businessContext: string;
  whatsapp: { token: string; phoneId: string; verifyToken: string };
  meta: { pageToken: string; appSecret: string; verifyToken: string };
}

export const DEFAULT_AGENT: AgentSettings = { enabled: true, dryRun: true, trashThreshold: 0.9, allowList: [], blockList: [] };

export const DEFAULT_SETTINGS: Settings = {
  agent: DEFAULT_AGENT,
  handoff: DEFAULT_HANDOFF,
  mode: 'sandbox', publicUrl: process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || '', testEmail: '', autoUnsub: true,
  defaultMin: 10, defaultMax: 30,
  aiEnabled: true, aiDailyLimit: 300, autopilot: true, confidenceThreshold: 0.85,
  businessContext: 'We help teams run compliant, well-paced outreach across multiple mailboxes.',
  whatsapp: { token: '', phoneId: '', verifyToken: '' },
  meta: { pageToken: '', appSecret: '', verifyToken: '' },
};

export type Role = 'admin' | 'operator' | 'viewer';
export interface User {
  id: string;
  username: string;
  name: string;
  role: Role;
  passHash: string;
  /** Bumped on password change/reset so older sessions stop working. */
  sessionVersion: number;
  totpSecret?: string;
  totpPending?: string;
  totpEnabled?: boolean;
  recovery?: string[]; // sha256 of unused recovery codes
  disabled?: boolean;
  createdAt: string;
  lastLoginAt?: string;
}
export interface AuditEntry { id: string; at: string; user: string; role: string; method: string; path: string; status: number; ip: string; note?: string }

interface Db {
  schema: number;
  contacts: Contact[];
  knowledge: KnowledgeEntry[];
  aiUsage: { date: string; count: number };
  users: User[];
  audit: AuditEntry[]; accounts: Account[]; campaigns: Campaign[]; settings: Settings; suppress: string[]; conversations: Conversation[]; agentLog: AgentLogEntry[] }

const DB_FILE = path.join(DATA, 'db.json');
function readJSON<T>(f: string, def: T): T { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return def; } }
function writeJSON(f: string, obj: unknown) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); }

type Fn = (v: string) => string;
/** Applies fn to every secret field of a db snapshot. */
function mapSecrets(d: Partial<Db>, fn: Fn) {
  for (const a of d.accounts ?? []) { if (a.pass) a.pass = fn(a.pass); if (a.apiKey) a.apiKey = fn(a.apiKey); }
  const st = d.settings;
  if (st?.whatsapp?.token) st.whatsapp.token = fn(st.whatsapp.token);
  if (st?.meta?.pageToken) st.meta.pageToken = fn(st.meta.pageToken);
  if (st?.meta?.appSecret) st.meta.appSecret = fn(st.meta.appSecret);
  for (const u of d.users ?? []) { if (u.totpSecret) u.totpSecret = fn(u.totpSecret); if (u.totpPending) u.totpPending = fn(u.totpPending); }
}

const loaded = readJSON<Partial<Db>>(DB_FILE, {});
mapSecrets(loaded, decrypt);
export const db: Db = {
  accounts: loaded.accounts ?? [],
  campaigns: loaded.campaigns ?? [],
  suppress: loaded.suppress ?? [],
  conversations: loaded.conversations ?? [],
  agentLog: loaded.agentLog ?? [],
  schema: 3,
  contacts: loaded.contacts ?? [],
  knowledge: loaded.knowledge ?? [],
  aiUsage: loaded.aiUsage ?? { date: '', count: 0 },
  users: loaded.users ?? [],
  audit: loaded.audit ?? [],
  settings: {
    ...DEFAULT_SETTINGS, ...(loaded.settings ?? {}),
    agent: { ...DEFAULT_AGENT, ...(loaded.settings?.agent ?? {}) },
    handoff: { ...DEFAULT_HANDOFF, ...(loaded.settings?.handoff ?? {}) },
    whatsapp: { ...DEFAULT_SETTINGS.whatsapp, ...(loaded.settings?.whatsapp ?? {}) },
    meta: { ...DEFAULT_SETTINGS.meta, ...(loaded.settings?.meta ?? {}) },
  },
};
export const suppressSet = new Set(db.suppress);

const recipCache = new Map<string, Recipient[]>();
const dirty = new Set<string>();
const recipFile = (cid: string) => path.join(RECIPS, cid + '.json');
export const markDirty = (k = 'db') => { dirty.add(k); };
export function recips(cid: string): Recipient[] {
  if (!recipCache.has(cid)) recipCache.set(cid, readJSON<Recipient[]>(recipFile(cid), []));
  return recipCache.get(cid)!;
}
export function setRecips(cid: string, list: Recipient[]) { recipCache.set(cid, list); markDirty(cid); }
export function dropRecips(cid: string) { recipCache.delete(cid); dirty.delete(cid); fs.rmSync(recipFile(cid), { force: true }); }

export function flush() {
  for (const k of [...dirty]) {
    try {
      if (k === 'db') {
        db.suppress = [...suppressSet];
        const snap = JSON.parse(JSON.stringify(db)) as Db;
        mapSecrets(snap, encrypt);
        writeJSON(DB_FILE, snap);
      }
      else if (recipCache.has(k)) writeJSON(recipFile(k), recipCache.get(k));
      dirty.delete(k);
    } catch (e) { console.error('Save failed:', (e as Error).message); }
  }
}
setInterval(flush, 2000).unref();
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { flush(); process.exit(0); });
