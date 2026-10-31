import { api, usePoll, type QueueState } from '../api';
import { Icon, fmtTime, useToast } from '../components/ui';
import type { ViewCtx } from '../App';

const STATE_LABEL: Record<string, string> = { running: 'Sending', resting: 'Resting', limit: 'Daily limit', cap: 'Volume reached', done: 'Done', error: 'Stopped (error)', paused: 'Paused' };

export default function LiveQueue({ campaignId, settings }: ViewCtx) {
  const { data: q, refresh } = usePoll<QueueState>('/queue' + (campaignId ? `?campaign=${campaignId}` : ''), 1500, [campaignId]);
  const toast = useToast();
  if (!q) return <div className="muted">Loading…</div>;
  const c = q.campaign, st = q.stats;
  const total = st?.total || 0, done = (st?.sent || 0) + (st?.failed || 0) + (st?.skipped || 0);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const act = async (path: string, ok: string) => { try { await api(path, 'POST'); toast(ok); refresh(); } catch (e) { toast((e as Error).message, 'err'); } };
  const status = !c ? 'No campaign selected' : q.running ? 'Running' : c.status === 'scheduled' ? 'Waiting for next day' : c.status === 'done' ? 'Complete' : 'Idle / Paused';
  return (
    <div className="stack" style={{ gap: 22 }}>
      <div className="card">
        <div className="row sb wrap">
          <div>
            <div className="eyebrow"><span className="accent">Dispatch engine status</span> <span className="dim">·</span> <span className="muted">{status}</span> <span className="dim">·</span> <span className={q.mode === 'live' ? 'ok' : 'warn'}>{q.mode === 'live' ? 'Live' : 'Sandbox'}</span></div>
            <h2 style={{ margin: '6px 0 0', font: '700 22px var(--display)' }}>{c ? c.name : 'No Active Campaign Running'}</h2>
          </div>
          <div className="row">
            {c && q.running && <button className="btn" onClick={() => act(`/campaigns/${c.id}/pause`, 'Pausing after in-flight emails')}><Icon n="pause" /> Pause Queue</button>}
            {c && !q.running && c.status !== 'done' && <button className="btn go" onClick={() => act(`/campaigns/${c.id}/start`, 'Queue resumed')}><Icon n="play" /> Resume Queue</button>}
            {c && (st?.failed || 0) > 0 && !q.running && <button className="btn" onClick={() => act(`/campaigns/${c.id}/retry`, 'Failed sends re-queued')}><Icon n="refresh" /> Retry failed</button>}
            {c && <a className="btn" href={`/api/campaigns/${c.id}/report.csv`}><Icon n="download" /> Report CSV</a>}
            {c && <span className="btn ghost mono" style={{ cursor: 'default' }}><Icon n="bolt" size={14} /> {c.minDelay}-{c.maxDelay}s Jitter</span>}
          </div>
        </div>
        <div className="stats4">
          <div className="stat"><div className="k">Remaining In Queue</div><div className="v">{st?.pending ?? 0} emails</div></div>
          <div className="stat"><div className="k">Processed in Batch</div><div className="v ok">{st?.sent ?? 0} sent{(st?.failed || 0) > 0 && <span className="err" style={{ fontSize: 14 }}> · {st?.failed} failed</span>}</div></div>
          <div className="stat"><div className="k">Next Dispatch Timer</div><div className="v warn">{q.running ? (q.nextInSec != null ? q.nextInSec + 's' : 'Sending…') : 'Paused'}</div></div>
          <div className="stat"><div className="k">Active Rotating Mailbox</div><div className="v" style={{ font: '600 15px var(--display)', color: '#a5b4fc' }}>{q.rotating.length ? (q.rotating.length > 2 ? `${q.rotating.length} mailboxes in parallel` : q.rotating.join(', ')) : 'Round-robin standby'}</div><small>Health-balanced</small></div>
        </div>
        <div className="row sb muted" style={{ fontSize: 12.5, marginBottom: 6 }}><span>Overall Batch Completion</span><b className="mono" style={{ color: '#fff' }}>{pct}%</b></div>
        <div className="bar green" style={{ height: 8 }}><i style={{ width: pct + '%' }} /></div>
      </div>

      {!!q.mailboxes.length && (
        <div className="card">
          <h3><Icon n="server" /> Mailbox workers</h3>
          <div className="grid3" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: 12 }}>
            {q.mailboxes.map((m) => (
              <div key={m.id} className="meter">
                <div className="row sb"><b style={{ fontFamily: 'var(--display)', fontSize: 13 }}>{m.name}</b><span className={'mono ' + (m.health >= 80 ? 'ok' : m.health >= 50 ? 'warn' : 'err')} style={{ fontSize: 12 }}>{m.health}%</span></div>
                <div className="line"><span>{m.state ? STATE_LABEL[m.state.status] || m.state.status : 'Idle'}{m.state?.nextIn ? ` · next in ${m.state.nextIn}s` : ''}</span><b>{m.state ? `${m.state.sent}/${m.state.cap}` : '–'}</b></div>
                <div className="bar"><i style={{ width: m.state?.cap ? Math.min(100, (m.state.sent / m.state.cap) * 100) + '%' : '0%' }} /></div>
                <div className="line"><span>Today</span><b>{m.sentToday} / {m.limit}</b></div>
                {m.state?.error && <div className="err" style={{ fontSize: 11.5 }}>{m.state.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="row sb"><div><h3 style={{ margin: 0 }}><Icon n="activity" /> Real-Time Dispatch Log</h3><div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Chronological audit trail of SMTP connections, rate limits, and delivery confirmations.</div></div>
          <button className="btn" onClick={() => { const blob = new Blob([JSON.stringify(q.logs, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'dispatch-log.json'; a.click(); }}><Icon n="download" /> Export Logs (JSON)</button></div>
        <div className="log" style={{ marginTop: 12 }}>
          {!q.logs.length && <div className="empty">No dispatch activity yet.</div>}
          {q.logs.map((l) => (
            <div className="l" key={l.id}>
              <span className={l.level === 'ok' ? 'ok' : l.level === 'err' ? 'err' : l.level === 'warn' ? 'warn' : 'muted'}><Icon n={l.level === 'ok' ? 'check' : l.level === 'err' ? 'x' : 'activity'} size={15} /></span>
              <span className="t">{fmtTime(l.t)}</span>
              <b className="mono" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.mailbox || '·'}</b>
              <span className="m" title={l.msg}>{l.msg}</span>
              {l.jitter != null ? <span className="jit">+{l.jitter}s jitter</span> : <span />}
            </div>
          ))}
        </div>
      </div>
      {settings?.mode === 'sandbox' && <div className="muted" style={{ fontSize: 12.5 }}>Sandbox mode: deliveries are simulated and no email leaves this server. Pacing, balancing and quotas behave exactly as in Live.</div>}
    </div>
  );
}
