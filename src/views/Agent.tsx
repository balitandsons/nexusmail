import { useEffect, useState } from 'react';
import { api, usePoll } from '../api';
import { Icon, useToast } from '../components/ui';
import type { ViewCtx } from '../App';

interface Log { id: string; at: string; from: string; subject: string; category: string; confidence: number; action: 'trashed' | 'would_trash' | 'kept' | 'held'; reason: string; engine: string; restored?: boolean }
interface AgentState {
  settings: { enabled: boolean; dryRun: boolean; trashThreshold: number; allowList: string[]; blockList: string[] };
  geminiConfigured: boolean; log: Log[]; imapMailboxes: number;
  counts: { trashed: number; wouldTrash: number; kept: number; held: number };
}
const ACTION: Record<Log['action'], { label: string; cls: string }> = {
  trashed: { label: 'MOVED TO TRASH', cls: 'err' }, would_trash: { label: 'WOULD TRASH (dry run)', cls: 'warn' },
  kept: { label: 'KEPT', cls: 'ok' }, held: { label: 'HELD FOR REVIEW', cls: 'accent' },
};
const cat = (c: string) => c.replace(/_/g, ' ');

export default function Agent(_: ViewCtx) {
  const { data, refresh } = usePoll<AgentState>('/agent', 5000);
  const toast = useToast();
  const [f, setF] = useState({ threshold: 90, allow: '', block: '' });
  const [t, setT] = useState({ from: 'news@brand.com', subject: 'Weekly newsletter', text: 'Our latest tips. View in browser. Unsubscribe.', headers: 'List-Unsubscribe: <mailto:x@brand.com>' });
  const [res, setRes] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (data && !loaded) { setF({ threshold: Math.round(data.settings.trashThreshold * 100), allow: data.settings.allowList.join('\n'), block: data.settings.blockList.join('\n') }); setLoaded(true); }
  }, [data, loaded]);
  if (!data) return <div className="muted">Loading…</div>;
  const s = data.settings;
  const put = async (body: object, ok?: string) => { try { await api('/agent/settings', 'PUT', body); if (ok) toast(ok); refresh(); } catch (e) { toast((e as Error).message, 'err'); } };

  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card stack">
        <div className="row sb wrap">
          <h3 style={{ margin: 0 }}><Icon n="shield" /> Inbox Agent</h3>
          <div className="row wrap">
            <label className="row"><input type="checkbox" checked={s.enabled} onChange={(e) => put({ enabled: e.target.checked })} /> Agent enabled</label>
            <label className="row"><input type="checkbox" checked={s.dryRun} onChange={(e) => put({ dryRun: e.target.checked }, e.target.checked ? 'Dry run: nothing will be moved' : 'Live: confident junk will be moved to Trash')} /> Dry run (log only, never touch the mailbox)</label>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 13 }}>
          Every email arriving in your IMAP-enabled mailboxes is read by {data.geminiConfigured ? 'Gemini' : 'the offline keyword classifier (no GEMINI_API_KEY, so it can only keep or hold, never trash)'}.
          Mail from customers, prospects, or about your products, pricing, orders and support is passed to the inbox for analysis and reply. Newsletters, promotions, notifications, phishing and bounce notices
          are moved to the mailbox's <b>Trash</b> folder when the agent is confident (never permanently deleted). Invoices, legal and security notices, and anything unclear are held for your review.
          {data.imapMailboxes === 0 && <b className="warn"> No mailbox has IMAP reading enabled yet: edit a Hostinger/SMTP mailbox and tick “Read replies via IMAP”, then switch to Live.</b>}
        </div>
        <div className="stats4" style={{ margin: 0 }}>
          <div className="stat"><div className="k">Moved to Trash</div><div className="v err">{data.counts.trashed}</div></div>
          <div className="stat"><div className="k">Would trash (dry run)</div><div className="v warn">{data.counts.wouldTrash}</div></div>
          <div className="stat"><div className="k">Kept for customers</div><div className="v ok">{data.counts.kept}</div></div>
          <div className="stat"><div className="k">Held for review</div><div className="v accent">{data.counts.held}</div></div>
        </div>
      </div>

      <div className="two" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <h3>Rules</h3>
          <label className="f"><span className="row sb"><span>Confidence needed to trash</span><b className="mono">{f.threshold}%</b></span><input type="range" min={70} max={99} value={f.threshold} onChange={(e) => setF({ ...f, threshold: Number(e.target.value) })} /></label>
          <label className="f">Always keep (allow list)<small>One email or @domain per line. These senders are never trashed.</small><textarea rows={3} value={f.allow} onChange={(e) => setF({ ...f, allow: e.target.value })} placeholder="@bigcustomer.com" /></label>
          <label className="f">Always trash (block list)<small>One email or @domain per line. Trashed without asking the AI, unless it replies to your own email.</small><textarea rows={3} value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} placeholder="@spammer.biz" /></label>
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={() => put({ trashThreshold: f.threshold / 100, allowList: f.allow, blockList: f.block }, 'Agent rules saved')}>Save rules</button></div>
        </div>

        <div className="card stack">
          <h3>Test an email</h3>
          <div className="muted" style={{ fontSize: 12.5 }}>See what the agent would decide. Nothing is moved or logged.</div>
          <div className="two"><label className="f">From<input value={t.from} onChange={(e) => setT({ ...t, from: e.target.value })} /></label><label className="f">Subject<input value={t.subject} onChange={(e) => setT({ ...t, subject: e.target.value })} /></label></div>
          <label className="f">Body<textarea rows={4} value={t.text} onChange={(e) => setT({ ...t, text: e.target.value })} style={{ fontFamily: 'var(--body)' }} /></label>
          <label className="f">Headers (optional, one per line)<textarea rows={2} value={t.headers} onChange={(e) => setT({ ...t, headers: e.target.value })} /></label>
          <div className="row sb">
            <button className="btn primary" onClick={async () => { try { setRes(await api('/agent/test', 'POST', t)); } catch (e) { toast((e as Error).message, 'err'); } }}><Icon n="sparkle" /> Analyse</button>
            {res && <span className="mono" style={{ fontSize: 12.5 }}><b className={res.decision.action === 'trash' ? 'err' : res.decision.action === 'keep' ? 'ok' : 'accent'}>{res.decision.action === 'trash' ? 'TRASH' : res.decision.action.toUpperCase()}</b> · {cat(res.verdict.category)} · {Math.round(res.verdict.confidence * 100)}% · {res.verdict.engine}</span>}
          </div>
          {res && <div className="muted" style={{ fontSize: 12.5 }}>{res.decision.reason}{res.sig.junk.length > 0 && <><br />Automated signs: {res.sig.junk.join('; ')}</>}{res.sig.keep.length > 0 && <><br />Human/known signs: {res.sig.keep.join('; ')}</>}</div>}
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <h3 style={{ padding: '16px 20px 0' }}><Icon n="activity" /> Agent activity</h3>
        {!data.log.length ? <div className="empty">Nothing yet. The agent checks IMAP mailboxes every minute while in Live mode.</div> : (
          <table className="t"><thead><tr><th>TIME</th><th>FROM / SUBJECT</th><th>CATEGORY</th><th>DECISION</th><th /></tr></thead>
            <tbody>{data.log.map((e) => (
              <tr key={e.id}>
                <td className="mono dim" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(e.at).toLocaleString()}</td>
                <td style={{ maxWidth: 360 }}><b style={{ fontFamily: 'var(--display)', fontSize: 13 }}>{e.from}</b><br /><span className="muted" style={{ fontSize: 12.5 }}>{e.subject}</span><br /><span className="dim" style={{ fontSize: 11.5 }}>{e.reason}</span></td>
                <td className="mono" style={{ fontSize: 12 }}>{cat(e.category)}<br /><span className="dim">{Math.round(e.confidence * 100)}% · {e.engine}</span></td>
                <td className={'tag ' + ACTION[e.action].cls}>{e.restored ? 'RESTORED' : ACTION[e.action].label}</td>
                <td>{(e.action === 'trashed' || e.action === 'would_trash') && !e.restored && <button className="btn sm" onClick={async () => { try { await api(`/agent/log/${e.id}/restore`, 'POST'); toast(e.action === 'trashed' ? 'Restored to the inbox; sender added to your allow list' : 'Sender added to your allow list'); refresh(); } catch (x) { toast((x as Error).message, 'err'); } }}>{e.action === 'trashed' ? 'Restore' : 'Never trash'}</button>}</td>
              </tr>))}</tbody></table>
        )}
      </div>
    </div>
  );
}
