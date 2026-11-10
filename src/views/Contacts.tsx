import { useEffect, useState } from 'react';
import { api, usePoll, type CampaignSummary } from '../api';
import { Icon, Modal, useToast } from '../components/ui';
import type { Me, ViewCtx } from '../App';

interface Contact { id: string; name: string; emails: string[]; phones: string[]; company: string; state?: string; tags: string[]; stage: string; stageManual?: boolean; source: string; lastActivityAt: string; noteCount?: number }
interface Detail extends Contact { notes: { id: string; at: string; by: string; text: string }[]; timeline: { at: string; kind: string; title: string; detail?: string }[] }
interface List { total: number; all: number; counts: Record<string, number>; tags: string[]; states: Record<string, number>; contacts: Contact[] }
const STAGES = ['new', 'contacted', 'replied', 'interested', 'customer', 'lost'];
const STAGE_CLS: Record<string, string> = { new: 'muted', contacted: 'muted', replied: 'accent', interested: 'ok', customer: 'ok', lost: 'err' };
const ago = (d: string) => { const s = (Date.now() - +new Date(d)) / 1000; return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };

function Card({ id, me, onClose, onChange }: { id: string; me: Me; onClose: () => void; onChange: () => void }) {
  const [c, setC] = useState<Detail | null>(null);
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [add, setAdd] = useState('');
  const toast = useToast();
  const ro = me.role === 'viewer';
  const load = () => api<Detail>('/contacts/' + id).then((d) => { setC(d); setTags(d.tags.join(', ')); }).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);
  const save = async (body: object, ok?: string) => { try { setC(await api<Detail>('/contacts/' + id, 'PUT', body)); if (ok) toast(ok); onChange(); } catch (e) { toast((e as Error).message, 'err'); } };
  if (!c) return <Modal title="Contact" onClose={onClose}><div className="muted">Loading…</div></Modal>;
  return (
    <Modal title={c.name} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <div className="two">
          <label className="f">Name<input defaultValue={c.name} disabled={ro} onBlur={(e) => e.target.value !== c.name && save({ name: e.target.value })} /></label>
          <label className="f">Company<input defaultValue={c.company} disabled={ro} onBlur={(e) => e.target.value !== c.company && save({ company: e.target.value })} /></label>
        </div>
        <label className="f">State<input defaultValue={c.state || ''} disabled={ro} onBlur={(e) => e.target.value !== (c.state || '') && save({ state: e.target.value })} /></label>
        <div className="muted mono" style={{ fontSize: 12 }}>{[...c.emails, ...c.phones.map((p) => '+' + p)].join(' · ') || 'no email or phone'}</div>
        {!ro && <div className="row"><input placeholder="Add another email or phone for this person" value={add} onChange={(e) => setAdd(e.target.value)} /><button className="btn sm" onClick={() => { if (!add.trim()) return; save(add.includes('@') ? { addEmail: add } : { addPhone: add }, 'Added'); setAdd(''); }}>Add</button></div>}
        <div className="two">
          <label className="f">Stage{c.stageManual && <small>Set by hand: automation will not change it.</small>}
            <select value={c.stage} disabled={ro} onChange={(e) => save({ stage: e.target.value }, 'Stage updated')}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></label>
          <label className="f">Tags<small>Comma separated. The tag “vip” always sends their messages to a person.</small><input value={tags} disabled={ro} onChange={(e) => setTags(e.target.value)} onBlur={() => save({ tags })} /></label>
        </div>
        {c.stageManual && !ro && <button className="btn sm" style={{ width: 'fit-content' }} onClick={() => save({ autoStage: true }, 'Stage is automatic again')}>Let the stage update automatically</button>}
        {!ro && <div className="row"><input placeholder="Write a note…" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn sm primary" onClick={async () => { if (!note.trim()) return; try { setC(await api<Detail>(`/contacts/${id}/notes`, 'POST', { text: note })); setNote(''); } catch (e) { toast((e as Error).message, 'err'); } }}>Add note</button></div>}
        <div className="eyebrow muted">Timeline</div>
        <div style={{ maxHeight: 280, overflow: 'auto', display: 'grid', gap: 8 }}>
          {!c.timeline.length && <div className="dim">No activity yet.</div>}
          {c.timeline.map((t, i) => (
            <div key={i} style={{ borderLeft: '2px solid var(--border2)', paddingLeft: 10, fontSize: 13 }}>
              <div><b style={{ fontFamily: 'var(--display)' }}>{t.title}</b> <span className="mono dim" style={{ fontSize: 11 }}>{new Date(t.at).toLocaleString()}</span></div>
              {t.detail && <div className="muted" style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>{t.detail}</div>}
            </div>))}
        </div>
      </div>
    </Modal>
  );
}

export default function Contacts({ me }: ViewCtx & { me: Me }) {
  const [stage, setStage] = useState('');
  const [tag, setTag] = useState('');
  const [stateF, setStateF] = useState('');
  const [bulkLimit, setBulkLimit] = useState(100);
  const [bulkCamp, setBulkCamp] = useState('');
  const [onlyNew, setOnlyNew] = useState(true);
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [page, setPage] = useState(1);
  const { data, refresh } = usePoll<List>(`/contacts?stage=${stage}&tag=${encodeURIComponent(tag)}&state=${encodeURIComponent(stateF)}&q=${encodeURIComponent(qLive)}&page=${page}`, 15000, [stage, tag, stateF, qLive, page]);
  const campaigns = usePoll<{ campaigns: CampaignSummary[] }>('/campaigns', 0);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [f, setF] = useState({ name: '', email: '', phone: '', company: '', tags: '' });
  const [csv, setCsv] = useState('');
  const toast = useToast();
  const ro = me.role === 'viewer';
  const wrap = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { toast((e as Error).message, 'err'); } };
  const pages = Math.max(1, Math.ceil((data?.total || 0) / 50));
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row sb wrap">
        <div className="seg">
          <button className={stage === '' ? 'on' : ''} onClick={() => { setStage(''); setPage(1); }}>All {data ? `(${data.all})` : ''}</button>
          {STAGES.map((s) => <button key={s} className={stage === s ? 'on' : ''} onClick={() => { setStage(s); setPage(1); }}>{s[0].toUpperCase() + s.slice(1)} {data ? `(${data.counts[s] ?? 0})` : ''}</button>)}
        </div>
        <div className="row wrap">
          {!ro && <button className="btn primary" onClick={() => setAdding(true)}><Icon n="plus" /> Add contact</button>}
          {!ro && <button className="btn" onClick={() => setImporting(true)}>Import CSV</button>}
          <a className="btn" href="/api/contacts/export.csv"><Icon n="download" /> Export</a>
        </div>
      </div>
      <div className="row wrap">
        <form style={{ flex: 1, minWidth: 220 }} onSubmit={(e) => { e.preventDefault(); setPage(1); setQLive(q.trim()); }}><input type="search" placeholder="Search name, company, email, phone, tag" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setQLive(''); }} /></form>
        <select style={{ width: 'auto' }} value={stateF} onChange={(e) => { setStateF(e.target.value); setPage(1); }} aria-label="State"><option value="">All states</option>{Object.entries(data?.states || {}).sort().map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}</select>
        <select style={{ width: 'auto' }} value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }} aria-label="Tag"><option value="">All tags</option>{data?.tags.map((t) => <option key={t}>{t}</option>)}</select>
        {!ro && sel.size > 0 && (
          <select style={{ width: 'auto' }} value="" aria-label="Add to campaign" onChange={(e) => e.target.value && wrap(async () => { const r = await api<{ added: number; suppressed: number; noEmail: number }>('/contacts/to-campaign', 'POST', { campaignId: e.target.value, ids: [...sel] }); toast(`${r.added} added to the campaign${r.suppressed ? ` · ${r.suppressed} skipped (unsubscribed/lost)` : ''}${r.noEmail ? ` · ${r.noEmail} have no email` : ''}`); setSel(new Set()); })}>
            <option value="">Add {sel.size} to campaign…</option>{campaigns.data?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>)}
      </div>
      {!ro && !!data?.total && (
        <div className="card row wrap" style={{ padding: '10px 14px', gap: 10 }}>
          <span style={{ fontSize: 13 }}><b>{data.total}</b> contact{data.total === 1 ? '' : 's'} match{data.total === 1 ? 'es' : ''}{stateF ? ` in ${stateF}` : ''}{tag ? ` tagged ${tag}` : ''}{stage ? ` at stage ${stage}` : ''}. Add</span>
          <input type="number" min={1} style={{ width: 90 }} value={bulkLimit} onChange={(e) => setBulkLimit(Math.max(1, Number(e.target.value) || 1))} aria-label="How many" />
          <span style={{ fontSize: 13 }}>of them to</span>
          <select style={{ width: 'auto', minWidth: 180 }} value={bulkCamp} onChange={(e) => setBulkCamp(e.target.value)} aria-label="Campaign"><option value="">choose a campaign…</option>{campaigns.data?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          <label className="row" style={{ fontSize: 12.5 }}><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} /> only people not emailed yet</label>
          <button className="btn primary" disabled={!bulkCamp} onClick={() => wrap(async () => { const r = await api<{ added: number; suppressed: number; alreadyContacted: number }>('/contacts/to-campaign', 'POST', { campaignId: bulkCamp, filter: { q: qLive, stage, tag, state: stateF }, limit: bulkLimit, onlyNew }); toast(`${r.added} added to the campaign${r.alreadyContacted ? ` · ${r.alreadyContacted} skipped (already emailed)` : ''}${r.suppressed ? ` · ${r.suppressed} skipped (unsubscribed/lost)` : ''}`); })}>Add to campaign</button>
        </div>)}
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        {data && !data.contacts.length ? <div className="empty">{data.all ? 'No contacts match.' : 'No contacts yet. They are created automatically when you send campaigns or receive replies, or you can add or import them.'}</div> : (
          <table className="t"><thead><tr><th style={{ width: 28 }}><input type="checkbox" aria-label="Select all" checked={!!data?.contacts.length && sel.size === data.contacts.length} onChange={(e) => setSel(e.target.checked ? new Set(data!.contacts.map((c) => c.id)) : new Set())} /></th><th>CONTACT</th><th>STATE</th><th>STAGE</th><th>TAGS</th><th>LAST ACTIVITY</th></tr></thead>
            <tbody>{data?.contacts.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(c.id)}>
                <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(c.id)} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} aria-label={'Select ' + c.name} /></td>
                <td><b style={{ fontFamily: 'var(--display)' }}>{c.name}</b>{c.company && <span className="dim"> · {c.company}</span>}<br /><span className="mono dim" style={{ fontSize: 11.5 }}>{c.emails[0] || '+' + c.phones[0]}{c.emails.length + c.phones.length > 1 ? ` (+${c.emails.length + c.phones.length - 1})` : ''}</span></td>
                <td className="muted" style={{ fontSize: 12.5 }}>{c.state || ''}</td>
                <td className={'mono ' + (STAGE_CLS[c.stage] || '')} style={{ fontSize: 12 }}>{c.stage}{c.stageManual ? ' ·manual' : ''}</td>
                <td className="mono dim" style={{ fontSize: 11.5 }}>{c.tags.join(' · ')}</td>
                <td className="mono dim" style={{ fontSize: 12 }}>{ago(c.lastActivityAt)}</td>
              </tr>))}</tbody></table>)}
      </div>
      {(data?.total || 0) > 50 && <div className="row sb"><span className="mono dim" style={{ fontSize: 12 }}>{data!.total} contacts · page {page}/{pages}</span><span className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button></span></div>}
      {open && <Card id={open} me={me} onClose={() => setOpen(null)} onChange={refresh} />}
      {adding && (
        <Modal title="Add contact" onClose={() => setAdding(false)}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="two"><label className="f">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label><label className="f">Company<input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} /></label></div>
            <div className="two"><label className="f">Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label><label className="f">Phone / WhatsApp<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+91 98765 43210" /></label></div>
            <label className="f">Tags<input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="vip, wholesale" /></label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => wrap(async () => { const r = await api<{ existed: boolean }>('/contacts', 'POST', f); toast(r.existed ? 'Already in your contacts, details merged' : 'Contact added'); setAdding(false); setF({ name: '', email: '', phone: '', company: '', tags: '' }); refresh(); })}>Add</button></div>
          </div>
        </Modal>)}
      {importing && (
        <Modal title="Import contacts from CSV" onClose={() => setImporting(false)}>
          <div className="stack" style={{ gap: 10 }}>
            <div className="muted" style={{ fontSize: 13 }}>First row = column names. Use any of: <span className="mono">email, phone, name, company, state, tags</span>. People already in your list are merged, never duplicated.</div>
            <input type="file" accept=".csv,.txt,text/csv" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} />
            <textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'email,name,company,state,tags\npriya@acme.com,Priya Sharma,Acme,Gujarat,vip'} />
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={!csv.trim()} onClick={() => wrap(async () => { const r = await api<{ added: number; merged: number; skipped: number }>('/contacts/import', 'POST', { text: csv }); toast(`${r.added} added · ${r.merged} merged · ${r.skipped} skipped`); setImporting(false); setCsv(''); refresh(); })}>Import</button></div>
          </div>
        </Modal>)}
    </div>
  );
}
