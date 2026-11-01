import { useEffect, useState } from 'react';
import { api, usePoll, type Channel, type Conversation, type InboxState } from '../api';
import { Icon, fmtTime, useToast } from '../components/ui';
import type { ViewCtx } from '../App';

const CH: Record<Channel, { label: string; icon: string; color: string }> = {
  email: { label: 'Email', icon: 'mail', color: '#38bdf8' },
  whatsapp: { label: 'WhatsApp', icon: 'whatsapp', color: '#10b981' },
  instagram: { label: 'Instagram', icon: 'instagram', color: '#ec4899' },
  messenger: { label: 'Messenger', icon: 'share', color: '#818cf8' },
};
const INTENT: Record<string, string> = { lead_interested: 'Lead Interested', pricing_question: 'Pricing Question', support_request: 'Support Request', objection: 'Objection', unsubscribe: 'Unsubscribe', spam: 'Spam', other: 'Other' };
const statusTag = (s: Conversation['status'], held?: boolean) => held ? <span className="tag accent">HELD BY AGENT</span> : s === 'auto_replied' ? <span className="tag ok">AUTO-SENT</span> : s === 'needs_review' ? <span className="tag warn">NEEDS REVIEW</span> : s === 'replied' ? <span className="tag accent">REPLIED</span> : <span className="tag dim">CLOSED</span>;

export default function Inbox({ settings, onChange }: ViewCtx & { onChange: () => void }) {
  const { data, refresh } = usePoll<InboxState>('/inbox', 4000);
  const [ch, setCh] = useState<'all' | Channel>('all');
  const [flt, setFlt] = useState<'all' | 'review' | 'auto'>('all');
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [instr, setInstr] = useState('');
  const [busy, setBusy] = useState('');
  const toast = useToast();

  const all = data?.conversations || [];
  const list = all.filter((c) => (ch === 'all' || c.channel === ch) && (flt === 'all' || (flt === 'review' ? c.status === 'needs_review' : c.status === 'auto_replied')));
  const cur = all.find((c) => c.id === sel) || null;
  const th = data?.threshold ?? 0.85;
  useEffect(() => { if (!sel && list.length) setSel(list[0].id); }, [list.length, sel]); // eslint-disable-line
  useEffect(() => { if (cur) { setDraft(cur.analysis?.suggestedReply || ''); if (cur.unread) api(`/inbox/${cur.id}/read`, 'POST').then(refresh).catch(() => undefined); } }, [cur?.id, cur?.analysis?.suggestedReply]); // eslint-disable-line

  const run = async (k: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(k);
    try { await fn(); if (ok) toast(ok); await refresh(); onChange(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
  };
  const simulate = (channel?: Channel) => run('sim', async () => { const c = await api<Conversation>('/inbox/simulate', 'POST', { channel: channel || (ch === 'all' ? undefined : ch) }); setSel(c.id); }, 'Incoming event processed by the AI');
  const a = cur?.analysis;
  const confColor = !a ? '#64748b' : a.confidence >= th ? '#10b981' : '#f59e0b';

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row sb wrap">
        <div className="seg">
          <button className={ch === 'all' ? 'on' : ''} onClick={() => setCh('all')}>All Inboxes</button>
          {(Object.keys(CH) as Channel[]).map((k) => <button key={k} className={ch === k ? 'on' : ''} onClick={() => setCh(k)}><span style={{ color: CH[k].color, marginRight: 6, verticalAlign: -2 }}><Icon n={CH[k].icon} size={14} /></span>{CH[k].label}</button>)}
        </div>
        <div className="row wrap">
          <div className="seg"><button className={flt === 'all' ? 'on' : ''} onClick={() => setFlt('all')}>All</button><button className={flt === 'review' ? 'on' : ''} onClick={() => setFlt('review')}>Needs Review</button><button className={flt === 'auto' ? 'on' : ''} onClick={() => setFlt('auto')}>AI Auto-Replied</button></div>
          <button className="btn primary" disabled={busy === 'sim'} onClick={() => simulate()}><Icon n="sparkle" /> Simulate Incoming Event</button>
        </div>
      </div>
      {settings && !settings.geminiConfigured && <div className="muted" style={{ fontSize: 12.5 }}>No GEMINI_API_KEY set: a keyword classifier is used instead of {settings.geminiModel}. In Live mode its drafts are never auto-sent, only staged for your review.</div>}

      <div className="inbox">
        <div className="convs">
          <div className="hd"><span>Conversations ({list.length})</span><span className="mono">Hybrid Autopilot ≥ {Math.round(th * 100)}%</span></div>
          <div className="list">
            {!list.length && <div className="empty">No conversations yet.<br />Use “Simulate Incoming Event” or connect a channel webhook.</div>}
            {list.map((c) => {
              const last = c.messages[c.messages.length - 1];
              return (
                <button key={c.id} className={'conv' + (sel === c.id ? ' on' : '')} onClick={() => setSel(c.id)}>
                  <div className="top2"><span style={{ color: CH[c.channel].color, display: 'flex', gap: 8, alignItems: 'center' }}><Icon n={CH[c.channel].icon} size={14} /><span style={{ color: '#fff' }}>{c.contactName}</span>{c.unread && <span style={{ width: 6, height: 6, borderRadius: 3, background: '#6366f1' }} />}</span><span className="mono dim" style={{ fontSize: 11, fontWeight: 400 }}>{fmtTime(c.updatedAt)}</span></div>
                  <div className="mono dim" style={{ fontSize: 11.5 }}>{c.contactHandle}</div>
                  <div className="prev">{[...c.messages].reverse().find((m) => m.dir === 'in')?.text ?? last?.text}</div>
                  <div className="meta"><span>{c.analysis ? (INTENT[c.analysis.intent] || c.analysis.intent).toLowerCase() : ''}</span><span>{c.analysis && <span>{Math.round(c.analysis.confidence * 100)}% conf · </span>}{statusTag(c.status, c.held)}</span></div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="detail">
          {!cur ? <div className="empty" style={{ margin: 'auto' }}>Select a conversation</div> : (
            <>
              <div className="hd">
                <div><div className="row" style={{ gap: 8 }}><span style={{ color: CH[cur.channel].color }}><Icon n={CH[cur.channel].icon} /></span><b style={{ fontFamily: 'var(--display)', fontSize: 16 }}>{cur.contactName}</b><span className="mono dim" style={{ fontSize: 12 }}>{cur.contactHandle}</span></div>
                  {cur.subject && <div className="muted" style={{ fontSize: 12.5 }}>Subject: {cur.subject}</div>}</div>
                <div className="row">{cur.status === 'auto_replied' && <span className="tag ok">AI AUTONOMOUSLY REPLIED</span>}{cur.status === 'needs_review' && <span className="tag warn">NEEDS HUMAN REVIEW</span>}
                  {cur.status !== 'closed' && <button className="btn sm ghost" onClick={() => run('close', () => api(`/inbox/${cur.id}/close`, 'POST'))}>Close</button>}</div>
              </div>
              <div className="body">
                {cur.messages.map((m) => (
                  <div key={m.id} className={'bubble' + (m.dir === 'out' ? ' out' : '')}>
                    <div className="who"><span>{m.dir === 'in' ? `Inbound Message (${cur.channel})` : `Outbound · ${m.by === 'ai' ? 'AI' : 'You'}${m.sandbox ? ' · sandbox (not delivered)' : ''}`}</span><span>{new Date(m.at).toLocaleString()}</span></div>
                    <p>{m.text}</p>
                  </div>
                ))}
                {a && (
                  <div className="ai">
                    <div className="row sb"><b className="row" style={{ gap: 8, fontFamily: 'var(--display)', fontSize: 13.5 }}><span className="accent"><Icon n="sparkle" /></span>{a.engine === 'gemini' ? (settings?.geminiModel || 'Gemini') : 'Keyword classifier'} Intent &amp; Risk Assessment</b>
                      <span className="mono" style={{ fontSize: 12.5 }}>Confidence: <b style={{ color: confColor }}>{Math.round(a.confidence * 100)}%</b> <span className="dim">(≥{Math.round(th * 100)}% threshold)</span></span></div>
                    <div className="g"><div><span className="dim">Classified Intent:</span><b>{INTENT[a.intent] || a.intent}</b></div><div><span className="dim">Sentiment:</span><b style={{ textTransform: 'capitalize' }}>{a.sentiment}</b></div></div>
                    <div className="conf"><i style={{ width: a.confidence * 100 + '%', background: confColor }} /><u style={{ left: th * 100 + '%' }} /></div>
                    {a.reasons && <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>{a.reasons}</div>}
                    {cur.held && <div className="warn" style={{ fontSize: 12.5, marginTop: 8 }}>Held by Inbox Agent, not auto-replied: {cur.heldReason}</div>}
                  </div>
                )}
              </div>
              {cur.status !== 'closed' && (
                <div className="reply">
                  <div className="row sb"><b style={{ fontFamily: 'var(--display)', fontSize: 13 }}><span className="accent"><Icon n="sparkle" size={14} /></span> Send Follow-up Message</b>
                    <div className="row" style={{ gap: 8 }}><input style={{ width: 240 }} placeholder="Custom instruction (e.g. ask for a call)" value={instr} onChange={(e) => setInstr(e.target.value)} />
                      <button className="btn" aria-label="Regenerate draft" disabled={busy === 'redraft'} onClick={() => run('redraft', () => api(`/inbox/${cur.id}/redraft`, 'POST', { instruction: instr }), 'Draft regenerated')}><Icon n="refresh" /></button></div></div>
                  <textarea rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Write a reply…" style={{ fontFamily: 'var(--body)', fontSize: 14 }} />
                  <div className="row sb"><span className="mono dim" style={{ fontSize: 11.5 }}>Target Channel: {cur.channel.toUpperCase()} ({cur.contactHandle}){settings?.mode === 'sandbox' ? ' · sandbox' : ''}</span>
                    <button className="btn primary" disabled={busy === 'send' || !draft.trim()} onClick={() => run('send', () => api(`/inbox/${cur.id}/reply`, 'POST', { text: draft, approvedAiDraft: draft === a?.suggestedReply }), settings?.mode === 'sandbox' ? 'Reply recorded (sandbox: not delivered)' : 'Reply sent')}><Icon n="send" /> Send Follow-up</button></div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
