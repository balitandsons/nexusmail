import { useCallback, useEffect, useState } from 'react';
import { api, usePoll, type InboxState, type Settings } from './api';
import { Icon, ToastProvider, useToast } from './components/ui';
import Mailboxes from './views/Mailboxes';
import Campaigns from './views/Campaigns';
import LiveQueue from './views/LiveQueue';
import Inbox from './views/Inbox';
import ApiHub from './views/ApiHub';
import Agent from './views/Agent';
import Team from './views/Team';

export type View = 'mailboxes' | 'campaigns' | 'queue' | 'inbox' | 'agent' | 'api' | 'team';
export interface Me { id: string; username: string; name: string; role: 'admin' | 'operator' | 'viewer'; totpEnabled: boolean }
const NAV: { id: View; label: string; icon: string; title: string }[] = [
  { id: 'mailboxes', label: 'Mailbox Accounts', icon: 'server', title: 'Mailbox Accounts & Multi-Provider Pools' },
  { id: 'campaigns', label: 'Bulk Campaigns', icon: 'layers', title: 'Campaign Orchestrator & Recipient Lists' },
  { id: 'queue', label: 'Live Queue & Pacing', icon: 'send', title: 'Active Dispatch Queue & Jitter Pacing' },
  { id: 'inbox', label: 'AI Omnichannel Inbox', icon: 'inbox', title: 'Omnichannel Inbound Hub & AI Autopilot' },
  { id: 'agent', label: 'Inbox Agent', icon: 'shield', title: 'Inbox Agent: Triage, Filter & Trash' },
  { id: 'team', label: 'Team & Security', icon: 'users', title: 'Team, Security & Audit Log' },
  { id: 'api', label: 'API & Webhooks', icon: 'sliders', title: 'API & Webhook Hub' },
];

function Login({ onDone }: { onDone: (u: Me) => void }) {
  const [username, setUsername] = useState('admin');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [need2fa, setNeed2fa] = useState(false);
  const [err, setErr] = useState('');
  return (
    <div className="login">
      <form onSubmit={async (e) => {
        e.preventDefault();
        try { const r = await api<{ user: Me }>('/login', 'POST', { username, password: pw, code }); onDone(r.user); }
        catch (x) { const m = (x as Error).message; if ((x as { needs2fa?: boolean }).needs2fa || /6-digit/.test(m)) setNeed2fa(true); setErr(m); }
      }}>
        <div className="brand" style={{ padding: 0 }}><div className="logo">NM</div><div><b>NexusMail</b><small>Outreach &amp; AI Engine</small></div></div>
        <label className="f">Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
        <label className="f">Password<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus autoComplete="current-password" /></label>
        {need2fa && <label className="f">6-digit code (or a recovery code)<input value={code} onChange={(e) => setCode(e.target.value)} autoFocus inputMode="numeric" autoComplete="one-time-code" /></label>}
        {err && <div className="err">{err}</div>}
        <button className="btn primary" style={{ justifyContent: 'center' }}>Sign in</button>
      </form>
    </div>
  );
}

function Shell({ onLogout, me }: { onLogout: () => void; me: Me }) {
  const [view, setView] = useState<View>((localStorage.getItem('nm-view') as View) || 'mailboxes');
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const settings = usePoll<Settings>('/settings', 0);
  const inbox = usePoll<InboxState>('/inbox', 5000);
  const mailboxes = usePoll<{ id: string; health: number; sentToday: number; enabled: boolean }[]>('/mailboxes', 5000);
  const toast = useToast();
  const go = useCallback((v: View, cid?: string) => { setView(v); if (cid !== undefined) setCampaignId(cid); localStorage.setItem('nm-view', v); }, []);

  const s = settings.data;
  const mbs = mailboxes.data || [];
  const enabled = mbs.filter((m) => m.enabled);
  const pool = enabled.length ? Math.round(enabled.reduce((a, m) => a + m.health, 0) / enabled.length) : 0;
  const sentToday = mbs.reduce((a, m) => a + m.sentToday, 0);
  const needs = inbox.data?.counts.needsReview || 0;

  const setMode = async (mode: 'sandbox' | 'live') => {
    if (mode === s?.mode) return;
    if (mode === 'live' && !confirm('Switch to Live Production? Campaigns will send real emails and replies will go out on real channels.')) return;
    try { await api('/settings', 'PUT', { mode }); await settings.refresh(); toast(mode === 'live' ? 'Live Production mode' : 'Test Sandbox mode'); }
    catch (e) { toast((e as Error).message, 'err'); }
  };
  const cur = NAV.find((n) => n.id === view)!;
  const ctx = { settings: s, refreshSettings: settings.refresh, go, campaignId, refreshAll: () => { mailboxes.refresh(); inbox.refresh(); } };

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand"><div className="logo">NM</div><div><b>NexusMail</b><small>Outreach &amp; AI Engine</small></div></div>
        <nav className="nav">
          {NAV.map((n) => (
            <button key={n.id} className={view === n.id ? 'on' : ''} onClick={() => go(n.id)}>
              <Icon n={n.icon} size={17} />{n.label}
              {n.id === 'mailboxes' && <span className="badge">{enabled.length}/{mbs.length}</span>}
              {n.id === 'inbox' && needs > 0 && <span className="badge alert">{needs}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div><span><Icon n="shield" size={13} /> Pool Health</span><b>{mbs.length ? pool + '%' : '–'}</b></div>
          <div><span><Icon n="sparkle" size={13} /> AI Auto-Replied</span><b>{inbox.data?.counts.autoReplied ?? 0}</b></div>
          <div><span><Icon n="activity" size={13} /> Sent Today</span><b>{sentToday}</b></div>
          <div className="muted" style={{ fontSize: 12 }}>{me.name} · {me.role}</div>
          <button className="btn ghost sm" onClick={async () => { await api('/logout', 'POST'); onLogout(); }}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <select className="mnav" value={view} onChange={(e) => go(e.target.value as View)} aria-label="Navigate">{NAV.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</select>
          <div className="crumb"><small>NEXUSMAIL</small><span className="sep">/</span><h1>{cur.title}</h1></div>
          <div className="mode" title="Sandbox simulates deliveries; Live uses real SMTP/API and channels">
            <button className={'sandbox ' + (s?.mode === 'sandbox' ? 'on' : '')} onClick={() => setMode('sandbox')}>TEST SANDBOX</button>
            <button className={'live ' + (s?.mode === 'live' ? 'on' : '')} onClick={() => setMode('live')}>LIVE</button>
          </div>
        </header>
        <main className="content">
          {view === 'mailboxes' && <Mailboxes {...ctx} onChange={ctx.refreshAll} />}
          {view === 'campaigns' && <Campaigns {...ctx} />}
          {view === 'queue' && <LiveQueue {...ctx} />}
          {view === 'inbox' && <Inbox {...ctx} onChange={ctx.refreshAll} />}
          {view === 'agent' && <Agent {...ctx} />}
          {view === 'team' && <Team me={me} />}
          {view === 'api' && <ApiHub {...ctx} />}
        </main>
      </div>
    </div>
  );
}

export interface ViewCtx { settings: Settings | null; refreshSettings: () => void; go: (v: View, cid?: string) => void; campaignId: string | null }

export default function App() {
  const [auth, setAuth] = useState<'unknown' | 'in' | 'out'>('unknown');
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<{ user: Me }>('/me').then((r) => { setMe(r.user); setAuth('in'); }).catch(() => setAuth('out'));
    const f = () => setAuth('out');
    window.addEventListener('nm-auth', f);
    return () => window.removeEventListener('nm-auth', f);
  }, []);
  return (
    <ToastProvider>
      {auth === 'unknown' ? null : auth === 'out' || !me ? <Login onDone={(u) => { setMe(u); setAuth('in'); }} /> : <Shell me={me} onLogout={() => setAuth('out')} />}
    </ToastProvider>
  );
}
