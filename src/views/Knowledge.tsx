import { useEffect, useState } from 'react';
import { api, usePoll } from '../api';
import { Icon, useToast } from '../components/ui';
import type { Me, ViewCtx } from '../App';

interface Entry { id: string; title: string; text: string; tags: string[]; updatedAt: string }
interface Handoff { enabled: boolean; keywords: string[]; negative: boolean; vip: boolean; notifyEmail: string; notifyAccountId: string }
interface Data { entries: Entry[]; handoff: Handoff; mailboxes: { id: string; name: string }[] }

export default function Knowledge({ me }: ViewCtx & { me: Me }) {
  const { data, refresh } = usePoll<Data>('/knowledge', 0);
  const [tab, setTab] = useState<'kb' | 'rules'>('kb');
  const [cur, setCur] = useState<Partial<Entry> & { tagText?: string }>({});
  const [imp, setImp] = useState('');
  const [question, setQuestion] = useState('');
  const [hits, setHits] = useState<{ title: string; text: string; score: number }[] | null>(null);
  const [h, setH] = useState<{ keywords: string; notifyEmail: string; notifyAccountId: string; enabled: boolean; negative: boolean; vip: boolean } | null>(null);
  const toast = useToast();
  const ro = me.role === 'viewer';
  useEffect(() => { if (data && !h) setH({ ...data.handoff, keywords: data.handoff.keywords.join(', ') }); }, [data, h]);
  const wrap = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { toast((e as Error).message, 'err'); } };
  if (!data || !h) return <div className="muted">Loading…</div>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="seg" style={{ width: 'fit-content' }}><button className={tab === 'kb' ? 'on' : ''} onClick={() => setTab('kb')}>Knowledge base ({data.entries.length})</button><button className={tab === 'rules' ? 'on' : ''} onClick={() => setTab('rules')}>Handoff rules</button></div>

      {tab === 'kb' && (
        <>
          <div className="muted" style={{ fontSize: 13 }}>The AI may only state product, price, policy and delivery facts that are written here. If nothing here covers a question, its confidence is capped so a person reviews the reply. Keep entries short and factual.</div>
          <div className="two" style={{ gridTemplateColumns: 'minmax(260px, 340px) 1fr', alignItems: 'start' }}>
            <div className="card" style={{ padding: 0, maxHeight: 520, overflow: 'auto' }}>
              {!ro && <button className="btn sm primary" style={{ margin: 12 }} onClick={() => setCur({ title: '', text: '', tagText: '' })}><Icon n="plus" size={13} /> New entry</button>}
              {!data.entries.length && <div className="empty">No entries yet. Add one, or paste your FAQ below.</div>}
              {data.entries.map((e) => <button key={e.id} className={'conv' + (cur.id === e.id ? ' on' : '')} onClick={() => setCur({ ...e, tagText: e.tags.join(', ') })}><div className="top2"><span>{e.title}</span></div><div className="prev">{e.text}</div></button>)}
            </div>
            <div className="card stack">
              <label className="f">Title / question<input value={cur.title ?? ''} disabled={ro} onChange={(e) => setCur({ ...cur, title: e.target.value })} placeholder="Shipping and delivery times" /></label>
              <label className="f">Answer / facts<textarea rows={8} value={cur.text ?? ''} disabled={ro} onChange={(e) => setCur({ ...cur, text: e.target.value })} style={{ fontFamily: 'var(--body)' }} placeholder="We ship across India in 3 to 5 working days…" /></label>
              <label className="f">Tags (optional)<input value={cur.tagText ?? ''} disabled={ro} onChange={(e) => setCur({ ...cur, tagText: e.target.value })} /></label>
              {!ro && <div className="row sb"><button className="btn danger" disabled={!cur.id} onClick={() => confirm('Delete this entry?') && wrap(async () => { await api('/knowledge/' + cur.id, 'DELETE'); setCur({}); refresh(); })}>Delete</button><button className="btn primary" onClick={() => wrap(async () => { const e = await api<Entry>('/knowledge', 'POST', { id: cur.id, title: cur.title, text: cur.text, tags: cur.tagText }); setCur({ ...e, tagText: e.tags.join(', ') }); toast('Saved'); refresh(); })}>Save entry</button></div>}
            </div>
          </div>
          <div className="two" style={{ alignItems: 'start' }}>
            {!ro && <div className="card stack"><h3>Paste your FAQ</h3><div className="muted" style={{ fontSize: 12.5 }}>Use <span className="mono">Q: question</span> then <span className="mono">A: answer</span> blocks, or <span className="mono"># Heading</span> sections.</div><textarea rows={6} value={imp} onChange={(e) => setImp(e.target.value)} /><div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" disabled={!imp.trim()} onClick={() => wrap(async () => { const r = await api<{ added: number }>('/knowledge/import', 'POST', { text: imp }); toast(`${r.added} entries added`); setImp(''); refresh(); })}>Import</button></div></div>}
            <div className="card stack"><h3><Icon n="sparkle" /> Test a customer question</h3><div className="row"><input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="How long does delivery take?" /><button className="btn" onClick={() => wrap(async () => setHits((await api<{ passages: typeof hits }>('/knowledge/test', 'POST', { question })).passages))}>Find</button></div>
              {hits && (!hits.length ? <div className="warn" style={{ fontSize: 13 }}>Nothing matches. The AI would not state facts for this question.</div> : hits.map((p, i) => <div key={i} style={{ fontSize: 13 }}><b>{p.title}</b> <span className="mono dim" style={{ fontSize: 11 }}>score {p.score}</span><div className="muted" style={{ whiteSpace: 'pre-wrap' }}>{p.text.slice(0, 260)}</div></div>))}</div>
          </div>
        </>
      )}

      {tab === 'rules' && (
        <div className="card stack" style={{ maxWidth: 760 }}>
          <h3><Icon n="shield" /> When a person must answer</h3>
          <label className="row"><input type="checkbox" checked={h.enabled} disabled={ro} onChange={(e) => setH({ ...h, enabled: e.target.checked })} /> Handoff rules on</label>
          <label className="f">Always hand over messages containing<small>Comma separated words or phrases. The AI still writes a draft, but it is never sent automatically.</small><textarea rows={2} value={h.keywords} disabled={ro} onChange={(e) => setH({ ...h, keywords: e.target.value })} /></label>
          <label className="row"><input type="checkbox" checked={h.negative} disabled={ro} onChange={(e) => setH({ ...h, negative: e.target.checked })} /> …and anyone who sounds unhappy</label>
          <label className="row"><input type="checkbox" checked={h.vip} disabled={ro} onChange={(e) => setH({ ...h, vip: e.target.checked })} /> …and contacts tagged “vip”</label>
          <div className="eyebrow muted" style={{ marginTop: 6 }}>Email me when a person is needed</div>
          <div className="two"><label className="f">Alert email<input type="email" value={h.notifyEmail} disabled={ro} onChange={(e) => setH({ ...h, notifyEmail: e.target.value })} placeholder="you@yourdomain.com" /></label>
            <label className="f">Send the alert from<select value={h.notifyAccountId} disabled={ro} onChange={(e) => setH({ ...h, notifyAccountId: e.target.value })}><option value="">(choose a mailbox)</option>{data.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label></div>
          <div className="muted" style={{ fontSize: 12.5 }}>You get at most one alert per conversation per hour. Alerts are only sent in Live mode.</div>
          {!ro && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => wrap(async () => { await api('/handoff', 'PUT', h); toast('Handoff rules saved'); refresh(); })}>Save rules</button></div>}
        </div>
      )}
    </div>
  );
}
