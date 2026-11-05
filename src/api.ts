import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error { constructor(msg: string, public status: number, public needs2fa = false) { super(msg); } }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch('/api' + path, {
    method,
    headers: { 'x-nm': '1', ...(body && !isForm ? { 'content-type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('nm-auth'));
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(j.error || res.statusText, res.status, !!j.needs2fa);
  return j as T;
}

/** Polls an endpoint; `refresh` reloads on demand. */
export function usePoll<T>(path: string, ms = 0, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    try { const d = await api<T>(path); if (alive.current) { setData(d); setError(''); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    refresh();
    const t = ms ? setInterval(refresh, ms) : undefined;
    return () => { alive.current = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, ms, ...deps]);
  return { data, error, refresh, setData };
}

export interface Mailbox {
  id: string; type: 'hostinger' | 'smtp' | 'brevo' | 'zepto'; provider: string; label: string; fromName: string; fromEmail: string; replyTo: string;
  limit: number; enabled: boolean; sentToday: number; health: number; healthLabel: string; resting: boolean;
  host?: string; port?: number; secure?: boolean; region?: string; apiKeyHint: string; hasPass: boolean;
  dns?: { spf: boolean; dkim: boolean; dmarc: boolean; checkedAt: string; fixes?: string[]; dmarcPolicy?: string };
  effectiveLimit: number; warmupDaysLeft: number; warmup?: { enabled: boolean; startDate: string; startLimit: number; rampPerDay: number };
  imap?: { enabled: boolean; host: string; port: number };
  imapStatus: { at: string; error: string } | null;
}
export interface Settings {
  mode: 'sandbox' | 'live'; publicUrl: string; testEmail: string; autoUnsub: boolean; defaultMin: number; defaultMax: number;
  aiEnabled: boolean; autopilot: boolean; confidenceThreshold: number; businessContext: string;
  whatsapp: { phoneId: string; verifyToken: string; hasToken: boolean };
  meta: { verifyToken: string; hasPageToken: boolean; hasAppSecret: boolean };
  aiDailyLimit: number; aiUsedToday?: number; suppressCount: number; geminiConfigured: boolean; geminiModel: string;
}
export interface CampaignSummary { id: string; name: string; status: string; createdAt: string; stats: Record<string, number> }
export interface CampaignDetail {
  id: string; name: string; subject: string; body: string; footer: string; minDelay: number; maxDelay: number; volumePerMailbox: number;
  accountIds: string[]; status: string; attachments: { id: string; name: string; size: number }[]; stats: Record<string, number>; activeId: string | null;
}
export interface LogEntry { id: number; t: number; level: string; msg: string; email?: string; mailbox?: string; jitter?: number; sandbox?: boolean }
export interface QueueState {
  mode: string; campaign: { id: string; name: string; status: string; minDelay: number; maxDelay: number } | null; running: boolean;
  stats: Record<string, number> | null; nextInSec: number | null; rotating: string[];
  mailboxes: { id: string; name: string; email: string; provider: string; sentToday: number; limit: number; health: number; state: { status: string; sent: number; failed: number; cap: number; nextIn: number; error: string } | null }[];
  logs: LogEntry[];
}
export type Channel = 'email' | 'whatsapp' | 'instagram' | 'messenger';
export interface Conversation {
  id: string; channel: Channel; contactName: string; contactHandle: string; subject: string;
  messages: { id: string; dir: 'in' | 'out'; by: string; text: string; at: string; sandbox?: boolean }[];
  analysis?: { intent: string; sentiment: string; confidence: number; summary: string; suggestedReply: string; reasons: string; engine: string; sources?: string[] };
  status: 'auto_replied' | 'needs_review' | 'replied' | 'closed'; held?: boolean; heldReason?: string; unread: boolean; updatedAt: string;
}
export interface InboxState { conversations: Conversation[]; threshold: number; autopilot: boolean; mode: string; counts: { needsReview: number; autoReplied: number } }
