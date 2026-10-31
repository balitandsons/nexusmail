import { useEffect, useRef, useState } from 'react';
import { api, usePoll, type CampaignDetail, type CampaignSummary, type Mailbox, type Settings } from '../api';
import { Icon, useToast } from '../components/ui';
import type { ViewCtx } from '../App';

const SAMPLE_BODY = `Hi {{firstName|there}},

I was reviewing {{company|your team}}'s recent growth and wanted to share how we helped similar teams scale outreach across multiple mailboxes.

Would you be open to a 5-minute chat this week?

Best,
Alex`;

function Editor({ id, settings, go }: { id: string; settings: Settings | null; go: ViewCtx['go'] }) {
  const toast = useToast();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [tab, setTab] = useState<'setup' | 'preview'>('setup');
  const [csv, setCsv] = useState('');
  const [recMode, setRecMode] = useState<'generate' | 'paste'>(settings?.mode === 'sandbox' ? 'generate' : 'paste');
  const [genCount, setGenCount] = useState(0);
  const [preview, setPreview] = useState<{ to: string; subject: string; html: string; attachments: string[] } | null>(null);
  const [testTo, setTestTo] = useState('');
  const [busy, setBusy] = useState('');
  const mailboxes = usePoll<Mailbox[]>('/mailboxes', 0);
  const saveTimer = useRef<number | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => { try { setC(await api<CampaignDetail>('/campaigns/' + id)); } catch (e) { toast((e as Error).message, 'err'); } };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);
  useEffect(() => { if (settings?.mode === 'live' && recMode === 'generate') setRecMode('paste'); }, [settings?.mode, recMode]);

  const patch = (p: Partial<CampaignDetail>) => {
    setC((x) => (x ? { ...x, ...p } : x));
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      try { await api('/campaigns/' + id, 'PUT', p); } catch (e) { toast((e as Error).message, 'err'); load(); }
    }, 500);
  };
  useEffect(() => () => window.clearTimeout(saveTimer.current), []);
  useEffect(() => {
    if (tab !== 'preview' || !c) return;
    const t = setTimeout(async () => { try { setPreview(await api('/campaigns/' + id + '/preview')); } catch { /* ignore */ } }, 400);
    return () => clearTimeout(t);
  }, [tab, c?.subject, c?.body, c?.footer, id]);

  if (!c) return <div className="muted">Loading…</div>;
  const mbs = mailboxes.data || [];
  const selected = mbs.filter((m) => m.enabled && (c.accountIds.length ? c.accountIds.includes(m.id) : false));
  const sending = c.activeId === c.id;
  const total = selected.length * c.volumePerMailbox;
  const pending = (c.stats.pending || 0);
  const dispatch = Math.min(pending, total);
  const toggle = (mid: string) => patch({ accountIds: c.accountIds.includes(mid) ? c.accountIds.filter((x) => x !== mid) : [...c.accountIds, mid] });

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(''); }
  };
  const flushSave = async () => { window.clearTimeout(saveTimer.current); await api('/campaigns/' + id, 'PUT', { name: c.name, subject: c.subject, body: c.body, footer: c.footer, minDelay: c.minDelay, maxDelay: c.maxDelay, volumePerMailbox: c.volumePerMailbox, accountIds: c.accountIds }); };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row sb wrap">
        <div className="seg">
          <button className={tab === 'setup' ? 'on' : ''} onClick={() => setTab('setup')}>Campaign Setup &amp; Pacing</button>
          <button className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>Live Template Preview</button>
          <button onClick={() => go('campaigns', '')}>Past Campaigns</button>
        </div>
        <div className="row">
          <button className="btn" disabled={busy === 'test'} onClick={() => run('test', async () => { await flushSave(); const r = await api<{ to: string; via: string; mode: string }>('/campaigns/' + id + '/test', 'POST', { to: testTo }); toast(`Test sent to ${r.to} via ${r.via}${r.mode === 'sandbox' ? ' (sandbox: simulated)' : ''}`); })}><Icon n="mail" /> Send Test Email</button>
          {sending
            ? <button className="btn" onClick={() => run('pause', () => api('/campaigns/' + id + '/pause', 'POST'), 'Pausing…')}><Icon n="pause" /> Pause</button>
            : <button className="btn go" disabled={busy === 'start' || !pending || !selected.length} onClick={() => run('start', async () => { await flushSave(); await api('/campaigns/' + id + '/start', 'POST'); go('queue', id); })}><Icon n="play" /> Launch Batch ({dispatch} Emails)</button>}
        </div>
      </div>

      {tab === 'preview' ? (
        <div className="card">
          <h3><Icon n="doc" /> Rendered for {preview?.to || '…'}</h3>
          <div className="muted" style={{ marginBottom: 10 }}>Subject: <b style={{ color: '#fff' }}>{preview?.subject}</b></div>
          <div className="preview" dangerouslySetInnerHTML={{ __html: preview?.html || '' }} />
          {!!preview?.attachments.length && <div className="muted" style={{ marginTop: 10 }}>Attachments: {preview.attachments.join(', ')}</div>}
        </div>
      ) : (
        <div className="campaign-grid">
          <div className="stack" style={{ gap: 18 }}>
            <div className="card stack">
              <h3><Icon n="doc" /> Message Composition &amp; Dynamic Variables</h3>
              <label className="f">Campaign Title<input value={c.name} onChange={(e) => patch({ name: e.target.value })} disabled={sending} /></label>
              <label className="f">Subject Line (Supports variables)<input className="mono" value={c.subject} onChange={(e) => patch({ subject: e.target.value })} placeholder="Quick question regarding {{company}}'s workflow" disabled={sending} /></label>
              <label className="f"><span className="row sb"><span>Email Body</span><span className="mono dim" style={{ fontSize: 11.5 }}>Tags: {'{{firstName}}'} {'{{company}}'} {'{{anyCsvColumn}}'} · spin {'{Hi|Hello}'}</span></span>
                <textarea rows={11} value={c.body} onChange={(e) => patch({ body: e.target.value })} disabled={sending} placeholder={SAMPLE_BODY} />
              </label>
              <label className="f">Footer (business name &amp; address)<textarea rows={2} value={c.footer} onChange={(e) => patch({ footer: e.target.value })} disabled={sending} /></label>
              <div className="muted" style={{ fontSize: 12.5 }}>An unsubscribe link and List-Unsubscribe header are added to every email{settings?.publicUrl ? '.' : '. Set the Public URL in API & Webhooks so the link works in one click.'}</div>
              <div className="row wrap">
                <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={sending}><Icon n="plus" size={13} /> Attach files</button>
                <input ref={fileRef} type="file" multiple hidden onChange={(e) => { const fd = new FormData(); Array.from(e.target.files || []).forEach((f) => fd.append('files', f)); run('att', () => api('/campaigns/' + id + '/attachments', 'POST', fd)); e.target.value = ''; }} />
                {c.attachments.map((a) => (
                  <span key={a.id} className="mono muted" style={{ fontSize: 12 }}>{a.name} ({Math.round(a.size / 1024)} KB) <button className="icon-btn" style={{ display: 'inline-grid', padding: 2 }} onClick={() => run('att', () => api(`/campaigns/${id}/attachments/${a.id}`, 'DELETE'))} aria-label={'Remove ' + a.name}><Icon n="x" size={12} /></button></span>
                ))}
              </div>
              <label className="f">Test recipient<input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder={settings?.testEmail || 'you@example.com'} /></label>
            </div>

            <div className="card stack">
              <div className="row sb">
                <h3 style={{ margin: 0 }}><Icon n="users" /> Target Recipients</h3>
                <div className="seg">
                  {settings?.mode === 'sandbox' && <button className={recMode === 'generate' ? 'on' : ''} onClick={() => setRecMode('generate')}>Auto-Generate Leads</button>}
                  <button className={recMode === 'paste' ? 'on' : ''} onClick={() => setRecMode('paste')}>Paste CSV Data</button>
                </div>
              </div>
              {recMode === 'generate' ? (
                <div className="row wrap">
                  <label className="f" style={{ width: 160 }}>Number of fake leads<input type="number" min={1} value={genCount || total || 100} onChange={(e) => setGenCount(Number(e.target.value))} /></label>
                  <button className="btn" style={{ alignSelf: 'end' }} disabled={sending || busy === 'gen'} onClick={() => run('gen', () => api('/campaigns/' + id + '/generate-leads', 'POST', { count: genCount || total || 100 }), 'Sandbox leads generated (example.com addresses)')}><Icon n="sparkle" /> Generate</button>
                  <span className="muted" style={{ fontSize: 12.5, alignSelf: 'end' }}>Sandbox only. Addresses containing “bounce” hard-bounce and “softfail” soft-bounce so you can test the balancer.</span>
                </div>
              ) : (
                <>
                  <textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'email,name,company\npriya@acme.com,Priya Sharma,Acme Corp'} disabled={sending} />
                  <div className="row wrap">
                    <input type="file" accept=".csv,.txt,text/csv" style={{ width: 'auto' }} onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
                    <button className="btn" disabled={!csv.trim() || sending} onClick={() => run('rec', async () => { const r = await api<any>('/campaigns/' + id + '/recipients', 'POST', { text: csv, mode: 'replace' }); toast(`${r.added} added · ${r.invalid} invalid · ${r.dupes} duplicates · ${r.suppressed} on do-not-send`); })}>Replace list</button>
                    <button className="btn" disabled={!csv.trim() || sending} onClick={() => run('rec', async () => { const r = await api<any>('/campaigns/' + id + '/recipients', 'POST', { text: csv, mode: 'append' }); toast(`${r.added} added · ${r.invalid} invalid · ${r.dupes} duplicates · ${r.suppressed} on do-not-send`); })}>Add to list</button>
                  </div>
                </>
              )}
              <div className="card" style={{ background: '#0d1426', borderColor: '#27346b' }}>
                <div className="row"><Icon n="sparkle" /><b>Calculated Dispatch Pool</b></div>
                <div className="muted" style={{ marginTop: 6, fontSize: 13 }}>
                  {selected.length} mailbox{selected.length === 1 ? '' : 'es'} attached × {c.volumePerMailbox} emails per mailbox = <b style={{ color: '#fff' }}>{total} emails</b> per run with automatic health-based rotation.
                  {' '}Loaded: <b className="num" style={{ color: '#fff' }}>{c.stats.total}</b> recipients ({pending} pending · {c.stats.sent || 0} sent · {c.stats.failed || 0} failed).
                  {pending > total && total > 0 && ' The remainder continues automatically on the next day.'}
                </div>
                {(c.stats.failed || 0) > 0 && !sending && <button className="btn sm" style={{ marginTop: 10 }} onClick={() => run('retry', () => api('/campaigns/' + id + '/retry', 'POST'), 'Failed recipients moved back to pending')}>Retry failed</button>}
                {c.stats.total > 0 && <a className="btn sm" style={{ marginTop: 10, marginLeft: 8 }} href={`/api/campaigns/${id}/report.csv`}><Icon n="download" size={13} /> Export report</a>}
              </div>
            </div>
          </div>

          <div className="stack" style={{ gap: 18 }}>
            <div className="card stack">
              <div className="row sb"><h3 style={{ margin: 0 }}><Icon n="clock" /> Humanized Jitter Pacing</h3><span className="mono warn">{c.minDelay}s – {c.maxDelay}s</span></div>
              <div className="muted" style={{ fontSize: 12.5 }}>Each mailbox waits a randomized delay between {c.minDelay} and {c.maxDelay} seconds before its next email. This breaks mechanical sending patterns and protects IP/domain reputation.</div>
              <label className="f"><span className="row sb"><span>Min Delay</span><b className="mono">{c.minDelay} seconds</b></span><input type="range" min={1} max={120} value={c.minDelay} disabled={sending} onChange={(e) => { const v = Number(e.target.value); patch({ minDelay: v, maxDelay: Math.max(v, c.maxDelay) }); }} /></label>
              <label className="f"><span className="row sb"><span>Max Delay</span><b className="mono">{c.maxDelay} seconds</b></span><input type="range" min={1} max={300} value={c.maxDelay} disabled={sending} onChange={(e) => { const v = Number(e.target.value); patch({ maxDelay: v, minDelay: Math.min(v, c.minDelay) }); }} /></label>
            </div>
            <div className="card stack">
              <div className="row sb"><h3 style={{ margin: 0 }}><Icon n="server" /> Attach Mailbox Accounts</h3>
                <button className="btn sm ghost" onClick={() => patch({ accountIds: selected.length === mbs.filter((m) => m.enabled).length ? [] : mbs.filter((m) => m.enabled).map((m) => m.id) })}>{selected.length === mbs.filter((m) => m.enabled).length ? 'Deselect All' : 'Select All'}</button></div>
              <div className="muted" style={{ fontSize: 12.5 }}>{selected.length} of {mbs.filter((m) => m.enabled).length} accounts attached</div>
              <label className="f">Volume per mailbox (e.g. 100 emails)<input type="number" min={1} value={c.volumePerMailbox} disabled={sending} onChange={(e) => patch({ volumePerMailbox: Math.max(1, Number(e.target.value) || 1) })} /></label>
              <div className="stack" style={{ gap: 8, maxHeight: 360, overflow: 'auto' }}>
                {!mbs.length && <div className="muted">Connect a mailbox first.</div>}
                {mbs.filter((m) => m.enabled).map((m) => (
                  <label key={m.id} className="row" style={{ border: '1px solid ' + (c.accountIds.includes(m.id) ? '#4f46e5' : 'var(--border)'), borderRadius: 10, padding: '10px 12px', background: '#0d1426', cursor: 'pointer' }}>
                    <input type="checkbox" checked={c.accountIds.includes(m.id)} disabled={sending} onChange={() => toggle(m.id)} />
                    <span style={{ minWidth: 0, flex: 1 }}><b style={{ fontFamily: 'var(--display)', fontSize: 13.5 }}>{m.label || m.fromEmail}</b><br /><span className="mono dim" style={{ fontSize: 11 }}>{m.fromEmail}</span></span>
                    <span className={'mono ' + (m.health >= 80 ? 'ok' : m.health >= 50 ? 'warn' : 'err')} style={{ fontSize: 12 }}>{m.health}%</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Campaigns(ctx: ViewCtx) {
  const { campaignId, go, settings } = ctx;
  const list = usePoll<{ campaigns: CampaignSummary[]; activeId: string | null }>('/campaigns', campaignId ? 0 : 4000, [campaignId]);
  const toast = useToast();
  const create = async () => {
    try {
      const c = await api<CampaignDetail>('/campaigns', 'POST', { name: 'Enterprise Outreach Batch' });
      go('campaigns', c.id);
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  if (campaignId) return <Editor id={campaignId} settings={settings} go={go} />;
  const items = list.data?.campaigns || [];
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row sb">
        <div className="seg"><button className="on">Past Campaigns ({items.length})</button></div>
        <button className="btn primary" onClick={create}><Icon n="plus" /> New Campaign</button>
      </div>
      {list.data && !items.length && <div className="card empty">No campaigns yet. Create one to compose a message, load recipients and attach mailboxes.</div>}
      <div className="card" style={{ padding: 0, overflow: 'auto', display: items.length ? 'block' : 'none' }}>
        <table className="t">
          <thead><tr><th>CAMPAIGN</th><th>STATUS</th><th>TOTAL</th><th>SENT</th><th>PENDING</th><th>FAILED</th><th /></tr></thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td><b style={{ fontFamily: 'var(--display)' }}>{c.name}</b><br /><span className="dim mono" style={{ fontSize: 11 }}>{new Date(c.createdAt).toLocaleString()}</span></td>
                <td className={c.status === 'running' ? 'ok' : c.status === 'done' ? 'accent' : 'muted'}>{c.status}</td>
                <td className="mono">{c.stats.total}</td><td className="mono ok">{c.stats.sent || 0}</td><td className="mono">{c.stats.pending || 0}</td><td className="mono err">{c.stats.failed || 0}</td>
                <td><div className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => go('campaigns', c.id)}>Open</button>
                  <button className="btn sm" onClick={() => go('queue', c.id)}>Queue</button>
                  <button className="btn sm" onClick={async () => { try { const d = await api<CampaignDetail>(`/campaigns/${c.id}/duplicate`, 'POST'); go('campaigns', d.id); } catch (e) { toast((e as Error).message, 'err'); } }}>Duplicate</button>
                  <button className="btn sm danger" onClick={async () => { if (!confirm(`Delete "${c.name}" and its recipients?`)) return; try { await api('/campaigns/' + c.id, 'DELETE'); list.refresh(); } catch (e) { toast((e as Error).message, 'err'); } }}>Delete</button>
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
