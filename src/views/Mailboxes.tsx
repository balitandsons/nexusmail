import { useState } from 'react';
import { api, usePoll, type Mailbox } from '../api';
import { Icon, Modal, healthClass, providerLabel, useToast } from '../components/ui';
import type { ViewCtx } from '../App';

type Form = Record<string, any>;
const blank = (type: Mailbox['type']): Form => ({
  type, label: '', fromName: '', fromEmail: '', replyTo: '', limit: 100, host: type === 'hostinger' ? 'smtp.hostinger.com' : '', port: 465, secure: true,
  user: '', pass: '', apiKey: '', region: 'in', imapEnabled: false, warmupEnabled: false, warmupStart: 20, warmupRamp: 5,
});

function MailboxModal({ initial, editing, onClose, onSaved }: { initial: Form; editing?: Mailbox; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(initial);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const smtp = f.type === 'hostinger' || f.type === 'smtp';
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, imap: smtp ? { enabled: !!f.imapEnabled } : undefined, warmup: { enabled: !!f.warmupEnabled, startLimit: Number(f.warmupStart), rampPerDay: Number(f.warmupRamp) } };
      const saved = editing ? await api<Mailbox>('/mailboxes/' + editing.id, 'PUT', body) : await api<Mailbox>('/mailboxes', 'POST', body);
      toast(editing ? 'Mailbox updated' : 'Mailbox connected');
      onSaved();
      if (!editing) {
        try { const r = await api<{ message: string }>(`/mailboxes/${saved.id}/test`, 'POST', {}); toast(r.message); } catch (e) { toast('Saved, but test failed: ' + (e as Error).message, 'err'); }
      }
      onClose();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  return (
    <Modal title={editing ? 'Edit mailbox' : 'Connect mailbox'} onClose={onClose}>
      <div className="stack">
        {!editing && (
          <div className="seg" role="tablist">
            {(['hostinger', 'brevo', 'zepto', 'smtp'] as const).map((t) => (
              <button key={t} className={f.type === t ? 'on' : ''} onClick={() => setF({ ...blank(t), label: f.label, fromEmail: f.fromEmail, fromName: f.fromName })}>{providerLabel[t].charAt(0) + providerLabel[t].slice(1).toLowerCase()}</button>
            ))}
          </div>
        )}
        <div className="two">
          <label className="f">Label<input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder="Hostinger Sales – Marcus" /></label>
          <label className="f">Daily limit<input type="number" min={1} value={f.limit} onChange={(e) => set('limit', e.target.value)} /></label>
        </div>
        <div className="two">
          <label className="f">From email<input type="email" value={f.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} /></label>
          <label className="f">From name<input value={f.fromName} onChange={(e) => set('fromName', e.target.value)} /></label>
        </div>
        <div className="card" style={{ background: '#0d1426', padding: '12px 14px' }}>
          <label className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={!!f.warmupEnabled} onChange={(e) => set('warmupEnabled', e.target.checked)} /> <b>Warm-up</b>: raise the daily limit gradually (recommended for new mailboxes)</label>
          {f.warmupEnabled && <div className="two" style={{ marginTop: 10 }}><label className="f">Start at (emails/day)<input type="number" min={1} value={f.warmupStart} onChange={(e) => set('warmupStart', e.target.value)} /></label><label className="f">Add per day<input type="number" min={1} value={f.warmupRamp} onChange={(e) => set('warmupRamp', e.target.value)} /></label></div>}
          {f.warmupEnabled && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Day 1 sends up to {f.warmupStart}, then +{f.warmupRamp} each day until the daily limit above ({f.limit}).</div>}
        </div>
        <label className="f">Reply-to (optional)<input type="email" value={f.replyTo} onChange={(e) => set('replyTo', e.target.value)} /></label>
        {smtp && (
          <>
            <div className="two">
              <label className="f">SMTP host<input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" /></label>
              <label className="f">Port<input type="number" value={f.port} onChange={(e) => setF((x) => ({ ...x, port: e.target.value, secure: Number(e.target.value) === 465 }))} /></label>
            </div>
            <div className="two">
              <label className="f">Username<small>Defaults to the From email</small><input value={f.user} onChange={(e) => set('user', e.target.value)} /></label>
              <label className="f">Password{editing?.hasPass && <small>Leave blank to keep the saved password</small>}<input type="password" value={f.pass} onChange={(e) => set('pass', e.target.value)} autoComplete="new-password" /></label>
            </div>
            <label className="row" style={{ fontSize: 13 }}><input type="checkbox" checked={!!f.imapEnabled} onChange={(e) => set('imapEnabled', e.target.checked)} /> Read replies from this mailbox via IMAP (feeds the AI inbox, Live mode only)</label>
          </>
        )}
        {f.type === 'brevo' && <label className="f">Brevo v3 API key{editing && <small>Saved: {editing.apiKeyHint}. Leave blank to keep it.</small>}<input type="password" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} autoComplete="new-password" /><small>Brevo → SMTP &amp; API → API keys. The From address must be a verified sender.</small></label>}
        {f.type === 'zepto' && (
          <div className="two">
            <label className="f">Send Mail token{editing && <small>Saved: {editing.apiKeyHint}</small>}<input type="password" value={f.apiKey} onChange={(e) => set('apiKey', e.target.value)} autoComplete="new-password" /></label>
            <label className="f">Data centre<select value={f.region} onChange={(e) => set('region', e.target.value)}>{['in', 'com', 'eu', 'com.au', 'jp', 'ca', 'sa'].map((r) => <option key={r} value={r}>zeptomail.{r}</option>)}</select></label>
          </div>
        )}
        {f.type === 'zepto' && <div className="muted" style={{ fontSize: 12.5 }}>ZeptoMail is transactional-only. Using it for promotional bulk mail violates its terms and risks suspension.</div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Connect & test'}</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Mailboxes({ onChange }: ViewCtx & { onChange: () => void }) {
  const { data, refresh } = usePoll<Mailbox[]>('/mailboxes', 5000);
  const [tab, setTab] = useState<'all' | Mailbox['type']>('all');
  const [modal, setModal] = useState<{ form: Form; editing?: Mailbox } | null>(null);
  const [busyId, setBusyId] = useState('');
  const toast = useToast();
  const list = (data || []).filter((m) => tab === 'all' || m.type === tab);
  const reload = () => { refresh(); onChange(); };
  const act = async (id: string, what: 'test' | 'dns') => {
    setBusyId(id + what);
    try {
      if (what === 'test') { const r = await api<{ message: string }>(`/mailboxes/${id}/test`, 'POST', {}); toast(r.message); }
      else { const d = await api<{ spf: boolean; dkim: boolean; dmarc: boolean }>(`/mailboxes/${id}/dns`, 'POST'); toast(`SPF ${d.spf ? 'found' : 'missing'} · DKIM ${d.dkim ? 'found' : 'not detected'} · DMARC ${d.dmarc ? 'found' : 'missing'}`, d.spf && d.dmarc ? 'ok' : 'err'); }
      reload();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusyId(''); }
  };
  const remove = async (m: Mailbox) => {
    if (!confirm(`Remove ${m.label || m.fromEmail}?`)) return;
    try { await api('/mailboxes/' + m.id, 'DELETE'); reload(); } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="row sb wrap">
        <div className="seg">
          {([['all', 'All Mailboxes'], ['hostinger', 'Hostinger'], ['brevo', 'Brevo'], ['zepto', 'Zeptomail'], ['smtp', 'Smtp']] as const).map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="row">
          <span className="muted mono" style={{ fontSize: 12 }}>Showing <b style={{ color: '#fff' }}>{list.length}</b> connected accounts</span>
          <button className="btn" onClick={reload} aria-label="Refresh"><Icon n="refresh" /></button>
          <button className="btn primary" onClick={() => setModal({ form: blank('hostinger') })}><Icon n="plus" /> Connect Mailbox</button>
        </div>
      </div>
      {data && !list.length && (
        <div className="card empty">No mailboxes yet. Connect a Hostinger, Brevo, ZeptoMail or custom SMTP account to start sending.<br /><br /><button className="btn primary" onClick={() => setModal({ form: blank('hostinger') })}><Icon n="plus" /> Connect Mailbox</button></div>
      )}
      <div className="grid3">
        {list.map((m) => (
          <div key={m.id} className="card mb" style={{ opacity: m.enabled ? 1 : 0.6 }}>
            <div className="head">
              <span><span className="eyebrow accent">{providerLabel[m.type]}</span> <span className="dim">·</span> <span className={m.resting ? 'warn' : m.enabled ? 'muted' : 'dim'}>{m.resting ? 'Resting' : m.enabled ? 'Active' : 'Paused'}</span></span>
              <span className="row" style={{ gap: 0 }}>
                <button className="icon-btn" title="Edit" onClick={() => setModal({ form: { ...blank(m.type), ...m, pass: '', apiKey: '', user: m.fromEmail === (m as any).user ? '' : (m as any).user || '', imapEnabled: !!m.imap?.enabled, warmupEnabled: !!m.warmup?.enabled, warmupStart: m.warmup?.startLimit ?? 20, warmupRamp: m.warmup?.rampPerDay ?? 5 }, editing: m })}><Icon n="sliders" size={15} /></button>
                <button className="icon-btn" title="Delete" onClick={() => remove(m)}><Icon n="trash" size={15} /></button>
              </span>
            </div>
            <h4>{m.label || m.fromEmail}</h4>
            <div className="addr">{m.fromEmail}</div>
            <div className="meter">
              <div className="line"><span><Icon n="shield" size={13} /> Health Score</span><b>{m.health}% ({m.healthLabel})</b></div>
              <div className="line"><span>Daily Volume</span><b>{m.sentToday} / {m.effectiveLimit} emails</b></div>
              {m.warmupDaysLeft > 0 && <div className="line"><span>Warm-up</span><b>limit {m.limit} in {m.warmupDaysLeft}d</b></div>}
              <div className={'bar ' + healthClass(m.health)}><i style={{ width: Math.min(100, (m.sentToday / m.effectiveLimit) * 100) + '%' }} /></div>
            </div>
            <div className="foot">
              <span>{m.host ? `${m.host}:${m.port}` : m.type === 'brevo' ? 'api.brevo.com' : `api.zeptomail.${m.region}`}</span>
              <span className="dnsflags">
                {m.dns ? (['spf', 'dkim', 'dmarc'] as const).map((k) => <span key={k} className={m.dns![k] ? 'ok' : 'bad'}>{k.toUpperCase()}</span>) : <span className="dim">DNS unchecked</span>}
              </span>
            </div>
            {!!m.dns?.fixes?.length && <details style={{ marginTop: 10, fontSize: 12 }}><summary className="warn" style={{ cursor: 'pointer' }}>{m.dns.fixes.length} DNS thing{m.dns.fixes.length === 1 ? '' : 's'} to fix</summary><ul style={{ margin: '6px 0 0', paddingLeft: 18, color: '#cbd5e1' }}>{m.dns.fixes.map((x, i) => <li key={i} style={{ marginBottom: 4 }}>{x}</li>)}</ul></details>}
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn sm" disabled={busyId === m.id + 'test'} onClick={() => act(m.id, 'test')}>{busyId === m.id + 'test' ? 'Testing…' : 'Test connection'}</button>
              <button className="btn sm" disabled={busyId === m.id + 'dns'} onClick={() => act(m.id, 'dns')}>Check DNS</button>
              <button className="btn sm ghost" onClick={async () => { try { await api('/mailboxes/' + m.id, 'PUT', { enabled: !m.enabled }); reload(); } catch (e) { toast((e as Error).message, 'err'); } }}>{m.enabled ? 'Pause' : 'Enable'}</button>
            </div>
          </div>
        ))}
      </div>
      {modal && <MailboxModal initial={modal.form} editing={modal.editing} onClose={() => setModal(null)} onSaved={reload} />}
    </div>
  );
}
