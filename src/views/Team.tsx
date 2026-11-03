import { useState } from 'react';
import { api, usePoll } from '../api';
import { Icon, Modal, useToast } from '../components/ui';
import type { Me } from '../App';

interface U { id: string; username: string; name: string; role: 'admin' | 'operator' | 'viewer'; totpEnabled: boolean; disabled: boolean; lastLoginAt?: string }
interface Audit { id: string; at: string; user: string; role: string; method: string; path: string; status: number; ip: string; note?: string }
const ROLE_HELP = { admin: 'Everything: mailboxes, settings, users', operator: 'Campaigns, inbox, agent, do-not-send list', viewer: 'Read only' };

function Account({ me }: { me: Me }) {
  const toast = useToast();
  const [pw, setPw] = useState({ current: '', next: '' });
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [on, setOn] = useState(me.totpEnabled);
  const [off, setOff] = useState({ password: '', code: '' });
  const wrap = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <div className="two" style={{ alignItems: 'start' }}>
      <div className="card stack">
        <h3><Icon n="shield" /> Change password</h3>
        <label className="f">Current password<input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></label>
        <label className="f">New password<small>At least 10 characters. Other devices are signed out.</small><input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" /></label>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => wrap(async () => { await api('/account/password', 'POST', pw); setPw({ current: '', next: '' }); toast('Password changed'); })}>Change password</button></div>
      </div>
      <div className="card stack">
        <h3><Icon n="shield" /> Two-factor authentication</h3>
        {on ? (
          <>
            <div className="ok">2FA is on for {me.username}.</div>
            <div className="two"><label className="f">Password<input type="password" value={off.password} onChange={(e) => setOff({ ...off, password: e.target.value })} /></label><label className="f">Current 6-digit code<input value={off.code} onChange={(e) => setOff({ ...off, code: e.target.value })} inputMode="numeric" /></label></div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn danger" onClick={() => wrap(async () => { await api('/account/2fa/disable', 'POST', off); setOn(false); setOff({ password: '', code: '' }); toast('2FA turned off'); })}>Turn off 2FA</button></div>
          </>
        ) : setup ? (
          <>
            <div className="muted" style={{ fontSize: 13 }}>In an authenticator app (Google Authenticator, Authy, 1Password) add an account by key, then type the 6-digit code it shows.</div>
            <pre className="code">{setup.secret}</pre>
            <label className="f">6-digit code<input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" /></label>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => wrap(async () => { const r = await api<{ recoveryCodes: string[] }>('/account/2fa/enable', 'POST', { code }); setCodes(r.recoveryCodes); setOn(true); setSetup(null); setCode(''); })}>Turn on 2FA</button></div>
          </>
        ) : (
          <>
            <div className="muted" style={{ fontSize: 13 }}>Adds a code from your phone to every sign-in. Strongly recommended for admins.</div>
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => wrap(async () => setSetup(await api('/account/2fa/setup', 'POST')))}>Set up 2FA</button></div>
          </>
        )}
      </div>
      {codes && (
        <Modal title="Save your recovery codes" onClose={() => setCodes(null)}>
          <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>Each code works once if you lose your phone. They are shown only now. Store them somewhere safe.</div>
          <pre className="code">{codes.join('\n')}</pre>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}><button className="btn primary" onClick={() => setCodes(null)}>I saved them</button></div>
        </Modal>
      )}
    </div>
  );
}

function Users({ me }: { me: Me }) {
  const { data, refresh } = usePoll<U[]>('/users', 0);
  const toast = useToast();
  const [f, setF] = useState({ username: '', name: '', role: 'operator', password: '' });
  const wrap = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok); refresh(); } catch (e) { toast((e as Error).message, 'err'); } };
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card stack">
        <h3><Icon n="users" /> Add a team member</h3>
        <div className="two">
          <label className="f">Username<input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
          <label className="f">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
        </div>
        <div className="two">
          <label className="f">Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{(['admin', 'operator', 'viewer'] as const).map((r) => <option key={r} value={r}>{r}: {ROLE_HELP[r]}</option>)}</select></label>
          <label className="f">Temporary password<small>At least 10 characters. They can change it after signing in.</small><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" /></label>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => wrap(async () => { await api('/users', 'POST', f); setF({ username: '', name: '', role: 'operator', password: '' }); }, 'User added')}>Add user</button></div>
      </div>
      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table className="t"><thead><tr><th>USER</th><th>ROLE</th><th>2FA</th><th>LAST SIGN-IN</th><th /></tr></thead>
          <tbody>{(data || []).map((u) => (
            <tr key={u.id} style={{ opacity: u.disabled ? 0.5 : 1 }}>
              <td><b style={{ fontFamily: 'var(--display)' }}>{u.name}</b><br /><span className="mono dim" style={{ fontSize: 11.5 }}>{u.username}{u.id === me.id ? ' (you)' : ''}</span></td>
              <td><select style={{ width: 130 }} value={u.role} onChange={(e) => wrap(() => api('/users/' + u.id, 'PUT', { role: e.target.value }), 'Role updated')}>{['admin', 'operator', 'viewer'].map((r) => <option key={r}>{r}</option>)}</select></td>
              <td className={u.totpEnabled ? 'ok mono' : 'dim mono'}>{u.totpEnabled ? 'on' : 'off'}</td>
              <td className="mono dim" style={{ fontSize: 12 }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'}</td>
              <td><div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => { const p = prompt(`New password for ${u.username} (min 10 characters):`); if (p) wrap(() => api('/users/' + u.id, 'PUT', { password: p }), 'Password reset'); }}>Reset password</button>
                {u.totpEnabled && <button className="btn sm" onClick={() => confirm('Turn off 2FA for this user?') && wrap(() => api('/users/' + u.id, 'PUT', { resetTotp: true }), '2FA reset')}>Reset 2FA</button>}
                {u.id !== me.id && <button className="btn sm" onClick={() => wrap(() => api('/users/' + u.id, 'PUT', { disabled: !u.disabled }))}>{u.disabled ? 'Enable' : 'Disable'}</button>}
                {u.id !== me.id && <button className="btn sm danger" onClick={() => confirm(`Delete ${u.username}?`) && wrap(() => api('/users/' + u.id, 'DELETE'), 'User deleted')}>Delete</button>}
              </div></td>
            </tr>))}</tbody></table>
      </div>
    </div>
  );
}

function AuditLog() {
  const { data } = usePoll<Audit[]>('/audit?limit=300', 8000);
  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      {!data?.length ? <div className="empty">Nothing recorded yet.</div> : (
        <table className="t"><thead><tr><th>TIME</th><th>USER</th><th>ACTION</th><th>RESULT</th><th>IP</th></tr></thead>
          <tbody>{data.map((e) => (
            <tr key={e.id}>
              <td className="mono dim" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</td>
              <td className="mono" style={{ fontSize: 12 }}>{e.user} <span className="dim">({e.role})</span></td>
              <td className="mono" style={{ fontSize: 12 }}>{e.method} {e.path}{e.note ? <span className="warn"> · {e.note}</span> : ''}</td>
              <td className={'mono ' + (e.status < 400 ? 'ok' : 'err')} style={{ fontSize: 12 }}>{e.status}</td>
              <td className="mono dim" style={{ fontSize: 12 }}>{e.ip}</td>
            </tr>))}</tbody></table>
      )}
    </div>
  );
}

export default function Team({ me }: { me: Me }) {
  const [tab, setTab] = useState<'account' | 'users' | 'audit'>('account');
  const admin = me.role === 'admin';
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="seg" style={{ width: 'fit-content' }}>
        <button className={tab === 'account' ? 'on' : ''} onClick={() => setTab('account')}>My account</button>
        {admin && <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>Team</button>}
        {admin && <button className={tab === 'audit' ? 'on' : ''} onClick={() => setTab('audit')}>Audit log</button>}
      </div>
      {tab === 'account' && <Account me={me} />}
      {tab === 'users' && admin && <Users me={me} />}
      {tab === 'audit' && admin && <AuditLog />}
    </div>
  );
}
