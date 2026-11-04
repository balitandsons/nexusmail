import { useState } from 'react';
import { usePoll } from '../api';
import { Icon } from '../components/ui';
import type { ViewCtx } from '../App';

interface Counts { sent: number; failed: number; bounced: number; replied: number; unsubscribed: number; pending: number; bounceRate: number; replyRate: number; unsubRate: number }
interface Stats {
  totals: Counts;
  days: { date: string; sent: number; bounced: number; replied: number; unsubscribed: number }[];
  mailboxes: (Counts & { id: string; name: string; email: string; health: number; limit: number; effectiveLimit: number })[];
  campaigns: (Counts & { id: string; name: string; status: string; createdAt: string })[];
}
const pct = (n: number) => (n ? n.toFixed(1) + '%' : '0%');
const tone = (bounce: number) => (bounce >= 5 ? 'err' : bounce >= 2 ? 'warn' : 'ok');

function Bars({ days }: { days: Stats['days'] }) {
  const max = Math.max(1, ...days.map((d) => d.sent));
  return (
    <div role="img" aria-label="Emails sent per day" style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 150, padding: '8px 0' }}>
      {days.map((d) => (
        <div key={d.date} title={`${d.date}: ${d.sent} sent, ${d.replied} replies, ${d.bounced} bounces, ${d.unsubscribed} unsubscribes`} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', height: '100%', gap: 4 }}>
          <span className="mono dim" style={{ fontSize: 10 }}>{d.sent || ''}</span>
          <div style={{ width: '100%', maxWidth: 38, height: Math.max(d.sent ? 3 : 1, (d.sent / max) * 100) + '%', background: d.sent ? 'var(--indigo)' : 'var(--border)', borderRadius: '4px 4px 0 0' }} />
          <span className="mono dim" style={{ fontSize: 10 }}>{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

export default function StatsView(_: ViewCtx) {
  const [days, setDays] = useState(14);
  const { data, refresh } = usePoll<Stats>('/stats?days=' + days, 15000, [days]);
  if (!data) return <div className="muted">Loading…</div>;
  const t = data.totals;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row sb wrap">
        <div className="seg">{[7, 14, 30, 90].map((d) => <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d)}>{d} days</button>)}</div>
        <div className="row"><button className="btn" onClick={refresh}><Icon n="refresh" /> Refresh</button><a className="btn" href="/api/stats/export.csv"><Icon n="download" /> Export all (CSV)</a></div>
      </div>
      <div className="stats4" style={{ margin: 0 }}>
        <div className="stat"><div className="k">Delivered to server</div><div className="v">{t.sent}</div><small>{t.pending} still queued · {t.failed} failed</small></div>
        <div className="stat"><div className="k">Bounce rate</div><div className={'v ' + tone(t.bounceRate)}>{pct(t.bounceRate)}</div><small>{t.bounced} bounced · keep under 2%</small></div>
        <div className="stat"><div className="k">Reply rate</div><div className="v ok">{pct(t.replyRate)}</div><small>{t.replied} replies</small></div>
        <div className="stat"><div className="k">Unsubscribes</div><div className={'v ' + (t.unsubRate >= 1 ? 'warn' : '')}>{pct(t.unsubRate)}</div><small>{t.unsubscribed} people</small></div>
      </div>

      <div className="card"><h3><Icon n="activity" /> Emails sent per day</h3><Bars days={data.days} /></div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <h3 style={{ padding: '16px 20px 0' }}><Icon n="server" /> By mailbox</h3>
        <table className="t"><thead><tr><th>MAILBOX</th><th>HEALTH</th><th>TODAY LIMIT</th><th>SENT</th><th>BOUNCE</th><th>REPLY</th><th>UNSUB</th></tr></thead>
          <tbody>{data.mailboxes.map((m) => (
            <tr key={m.id}>
              <td><b style={{ fontFamily: 'var(--display)' }}>{m.name}</b><br /><span className="mono dim" style={{ fontSize: 11 }}>{m.email}</span></td>
              <td className={'mono ' + (m.health >= 80 ? 'ok' : m.health >= 50 ? 'warn' : 'err')}>{m.health}%</td>
              <td className="mono">{m.effectiveLimit}{m.effectiveLimit < m.limit ? <span className="dim"> / {m.limit} (warm-up)</span> : ''}</td>
              <td className="mono">{m.sent}</td>
              <td className={'mono ' + tone(m.bounceRate)}>{pct(m.bounceRate)} <span className="dim">({m.bounced})</span></td>
              <td className="mono">{pct(m.replyRate)} <span className="dim">({m.replied})</span></td>
              <td className="mono">{pct(m.unsubRate)}</td>
            </tr>))}</tbody></table>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <h3 style={{ padding: '16px 20px 0' }}><Icon n="layers" /> By campaign</h3>
        {!data.campaigns.length ? <div className="empty">No campaigns yet.</div> : (
          <table className="t"><thead><tr><th>CAMPAIGN</th><th>STATUS</th><th>SENT</th><th>FAILED</th><th>BOUNCE</th><th>REPLY</th><th>UNSUB</th></tr></thead>
            <tbody>{data.campaigns.map((c) => (
              <tr key={c.id}>
                <td><b style={{ fontFamily: 'var(--display)' }}>{c.name}</b></td><td className="muted">{c.status}</td>
                <td className="mono">{c.sent}</td><td className="mono err">{c.failed || 0}</td>
                <td className={'mono ' + tone(c.bounceRate)}>{pct(c.bounceRate)} <span className="dim">({c.bounced})</span></td>
                <td className="mono">{pct(c.replyRate)} <span className="dim">({c.replied})</span></td>
                <td className="mono">{pct(c.unsubRate)}</td>
              </tr>))}</tbody></table>
        )}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>Bounces and replies are detected when a mailbox with <b>Read replies via IMAP</b> receives them (Live mode). "Delivered to server" means the mail server accepted it; it does not prove inbox placement.</div>
    </div>
  );
}
