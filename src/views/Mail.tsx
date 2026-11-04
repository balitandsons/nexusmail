import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { Icon, Modal, useToast } from '../components/ui';
import type { ViewCtx } from '../App';

interface Acc { id: string; name: string; email: string; fromName: string }
interface Folder { path: string; name: string; special: string; total: number; unread: number }
interface Row { uid: number; accountId: string; accountName: string; folder: string; from: string; fromName: string; to: string; subject: string; date: string; seen: boolean; flagged: boolean; answered: boolean; hasAttachment: boolean; badge: 'relevant' | 'review' | 'junk'; badgeWhy: string }
interface Msg { uid: number; accountId: string; folder: string; messageId: string; from: string; fromName: string; to: string; cc: string; replyTo: string; subject: string; date: string; html: string; text: string; flagged: boolean; attachments: { index: number; filename: string; size: number; contentType: string; inline: boolean }[] }
interface Draft { accountId: string; to: string; cc: string; bcc: string; subject: string; text: string; replyUid?: number; forwardUid?: number; folder?: string; origAttachments?: number; files: File[] }

const UNIFIED = 'unified';
const emails = (s: string) => (s.match(/[^\s<>,;"]+@[^\s<>,;"]+\.[^\s<>,;"]+/g) || []).map((x) => x.toLowerCase());
const when = (d: string) => { const x = new Date(d), n = new Date(); return x.toDateString() === n.toDateString() ? x.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : x.toLocaleDateString([], { day: 'numeric', month: 'short', year: x.getFullYear() === n.getFullYear() ? undefined : 'numeric' }); };
const kb = (n: number) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const HINT = { relevant: 'Customer / sales', junk: 'Likely junk', review: 'Review' } as const;

function Compose({ init, accounts, onClose, onSent, sandbox }: { init: Draft; accounts: Acc[]; onClose: () => void; onSent: () => void; sandbox: boolean }) {
  const [d, setD] = useState<Draft>(init);
  const [more, setMore] = useState(!!(init.cc || init.bcc));
  const [busy, setBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const toast = useToast();
  const set = (k: keyof Draft, v: unknown) => setD((x) => ({ ...x, [k]: v }));
  const send = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('to', d.to); fd.append('cc', d.cc); fd.append('bcc', d.bcc); fd.append('subject', d.subject); fd.append('text', d.text);
      if (d.replyUid) { fd.append('replyUid', String(d.replyUid)); fd.append('replyFolder', d.folder || 'INBOX'); }
      if (d.forwardUid) { fd.append('forwardUid', String(d.forwardUid)); fd.append('forwardFolder', d.folder || 'INBOX'); fd.append('includeOriginalAttachments', String(!!d.origAttachments)); }
      d.files.forEach((f) => fd.append('files', f));
      await api(`/mail/${d.accountId}/send`, 'POST', fd);
      toast('Sent'); onSent(); onClose();
    } catch (e) { toast((e as Error).message, 'err'); } finally { setBusy(false); }
  };
  const aiDraft = async () => {
    if (!d.replyUid) return;
    setAiBusy(true);
    try {
      const r = await api<{ draft: string; engine: string }>(`/mail/${d.accountId}/ai/reply`, 'POST', { folder: d.folder, uid: d.replyUid });
      if (!r.draft) { toast('The AI had no suggestion for this message.', 'err'); return; }
      const quoteAt = d.text.indexOf('\n\nOn ');
      set('text', r.draft + (quoteAt >= 0 ? d.text.slice(quoteAt) : ''));
      toast(r.engine === 'gemini' ? 'AI draft added. Check it before sending.' : 'Draft added (offline template, set GEMINI_API_KEY for smarter replies)');
    } catch (e) { toast((e as Error).message, 'err'); } finally { setAiBusy(false); }
  };
  return (
    <Modal title={d.replyUid ? 'Reply' : d.forwardUid ? 'Forward' : 'New message'} onClose={onClose}>
      <div className="stack compose" style={{ gap: 10 }}>
        {sandbox && <div className="warn" style={{ fontSize: 12.5 }}>Test Sandbox mode: sending is switched off. Switch to Live in the top bar to send.</div>}
        <label className="f">From<select value={d.accountId} onChange={(e) => set('accountId', e.target.value)} disabled={!!d.replyUid || !!d.forwardUid}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name} &lt;{a.email}&gt;</option>)}</select></label>
        <label className="f"><span className="row sb"><span>To</span>{!more && <button type="button" className="btn sm ghost" onClick={() => setMore(true)}>Cc / Bcc</button>}</span><input value={d.to} onChange={(e) => set('to', e.target.value)} placeholder="name@example.com, other@example.com" autoFocus={!d.to} /></label>
        {more && <div className="two"><label className="f">Cc<input value={d.cc} onChange={(e) => set('cc', e.target.value)} /></label><label className="f">Bcc<input value={d.bcc} onChange={(e) => set('bcc', e.target.value)} /></label></div>}
        <label className="f">Subject<input value={d.subject} onChange={(e) => set('subject', e.target.value)} /></label>
        <textarea rows={12} value={d.text} onChange={(e) => set('text', e.target.value)} style={{ fontFamily: 'var(--body)', fontSize: 14 }} autoFocus={!!d.to} />
        <div className="row wrap">
          <label className="btn sm" style={{ cursor: 'pointer' }}><Icon n="paperclip" size={13} /> Attach<input type="file" multiple hidden onChange={(e) => { set('files', [...d.files, ...Array.from(e.target.files || [])]); e.target.value = ''; }} /></label>
          {d.files.map((f, i) => <span key={i} className="mono muted" style={{ fontSize: 12 }}>{f.name} ({kb(f.size)}) <button type="button" className="icon-btn" style={{ display: 'inline-grid', padding: 2 }} onClick={() => set('files', d.files.filter((_, j) => j !== i))} aria-label="Remove"><Icon n="x" size={12} /></button></span>)}
          {!!d.origAttachments && d.forwardUid && <label className="row" style={{ fontSize: 12.5 }}><input type="checkbox" checked={!!d.origAttachments} onChange={(e) => set('origAttachments', e.target.checked ? 1 : 0)} /> Include original attachments</label>}
        </div>
        <div className="row sb">
          {d.replyUid ? <button type="button" className="btn" onClick={aiDraft} disabled={aiBusy}><Icon n="sparkle" /> {aiBusy ? 'Thinking…' : 'Draft with AI'}</button> : <span />}
          <div className="row"><button className="btn" onClick={onClose}>Discard</button><button className="btn primary" onClick={send} disabled={busy || sandbox}><Icon n="send" /> {busy ? 'Sending…' : 'Send'}</button></div>
        </div>
      </div>
    </Modal>
  );
}

function Reader({ m, accounts, onAct, onCompose }: { m: Msg; accounts: Acc[]; onAct: (a: 'delete' | 'unread' | 'star', m: Msg) => void; onCompose: (d: Draft) => void }) {
  const toast = useToast();
  const [ai, setAi] = useState<{ kind: 'classify'; text: string } | null>(null);
  const acc = accounts.find((a) => a.id === m.accountId);
  const me = acc?.email.toLowerCase() || '';
  const quote = (intro: string) => `\n\n${intro}\n${(m.text || '').split('\n').map((l) => '> ' + l).join('\n')}`;
  const stamp = new Date(m.date).toLocaleString();
  const reply = (all: boolean) => {
    const to = emails(m.replyTo || m.from);
    const cc = all ? [...emails(m.to), ...emails(m.cc)].filter((x) => x !== me && !to.includes(x)) : [];
    onCompose({ accountId: m.accountId, to: to.join(', '), cc: cc.join(', '), bcc: '', subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject, text: quote(`On ${stamp}, ${m.fromName || m.from} wrote:`), replyUid: m.uid, folder: m.folder, files: [] });
  };
  const forward = () => onCompose({ accountId: m.accountId, to: '', cc: '', bcc: '', subject: /^fwd?:/i.test(m.subject) ? m.subject : 'Fwd: ' + m.subject, text: `\n\n---------- Forwarded message ----------\nFrom: ${m.fromName ? `${m.fromName} <${m.from}>` : m.from}\nDate: ${stamp}\nSubject: ${m.subject}\nTo: ${m.to}\n\n${m.text}`, forwardUid: m.uid, folder: m.folder, origAttachments: m.attachments.some((a) => !a.inline) ? 1 : 0, files: [] });
  const doc = useMemo(() => m.html ? `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{font:14px/1.5 Arial,sans-serif;color:#222;margin:16px;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${m.html}</body></html>` : '', [m.html]);
  const classify = async () => {
    try {
      const r = await api<{ category: string; confidence: number; engine: string; action: string; reason: string }>(`/mail/${m.accountId}/ai/classify`, 'POST', { folder: m.folder, uid: m.uid });
      setAi({ kind: 'classify', text: `${r.category.replace(/_/g, ' ')} (${Math.round(r.confidence * 100)}%, ${r.engine === 'gemini' ? 'Gemini' : 'offline'}). ${r.reason}` });
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  return (
    <div className="pane reader">
      <div className="rh">
        <h2>{m.subject}</h2>
        <div style={{ fontSize: 13 }}><b>{m.fromName || m.from}</b> <span className="mono dim" style={{ fontSize: 12 }}>&lt;{m.from}&gt;</span></div>
        <div className="muted" style={{ fontSize: 12 }}>to {m.to}{m.cc ? ` · cc ${m.cc}` : ''} · {stamp}{acc ? ` · in ${acc.name}` : ''}</div>
      </div>
      <div className="acts">
        <button className="btn sm" onClick={() => reply(false)}><Icon n="reply" size={14} /> Reply</button>
        <button className="btn sm" onClick={() => reply(true)}><Icon n="reply" size={14} /> Reply all</button>
        <button className="btn sm" onClick={forward}><Icon n="forward" size={14} /> Forward</button>
        <button className="btn sm" onClick={() => onAct('star', m)}><Icon n="star" size={14} /> {m.flagged ? 'Unstar' : 'Star'}</button>
        <button className="btn sm" onClick={() => onAct('unread', m)}>Mark unread</button>
        <button className="btn sm danger" onClick={() => onAct('delete', m)}><Icon n="trash" size={14} /> Delete</button>
        <button className="btn sm" onClick={classify}><Icon n="sparkle" size={14} /> Junk or relevant?</button>
      </div>
      {ai && <div className="aibox"><b className="accent">AI check:</b> {ai.text}</div>}
      <div className="rb">{doc ? <iframe title="Message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} /> : <pre className="txt">{m.text || '(empty message)'}</pre>}</div>
      {m.attachments.filter((a) => !a.inline).length > 0 && (
        <div className="atts">{m.attachments.filter((a) => !a.inline).map((a) => (
          <a key={a.index} href={`/api/mail/${m.accountId}/attachment?folder=${encodeURIComponent(m.folder)}&uid=${m.uid}&index=${a.index}`}><Icon n="paperclip" size={13} /> {a.filename} <span className="dim mono">{kb(a.size)}</span></a>
        ))}</div>
      )}
    </div>
  );
}

export default function Mail({ settings }: ViewCtx) {
  const toast = useToast();
  const [accounts, setAccounts] = useState<Acc[]>([]);
  const [meta, setMeta] = useState<{ aiUsedToday: number; aiDailyLimit: number; geminiConfigured: boolean }>({ aiUsedToday: 0, aiDailyLimit: 0, geminiConfigured: false });
  const [acc, setAcc] = useState<string>(UNIFIED);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState('INBOX');
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Msg | null>(null);
  const [openKey, setOpenKey] = useState('');
  const [compose, setCompose] = useState<Draft | null>(null);
  const loadId = useRef(0);
  const key = (r: Row) => `${r.accountId}:${r.folder}:${r.uid}`;
  const sandbox = settings?.mode !== 'live';

  useEffect(() => { api<{ accounts: Acc[] } & typeof meta>('/mail/accounts').then((r) => { setAccounts(r.accounts); setMeta(r); if (r.accounts.length === 1) setAcc(r.accounts[0].id); }).catch((e) => toast((e as Error).message, 'err')); }, []); // eslint-disable-line

  const loadFolders = useCallback(async (id: string, fresh = false) => {
    if (id === UNIFIED) { setFolders([]); return; }
    try { setFolders(await api<Folder[]>(`/mail/${id}/folders${fresh ? '?fresh=1' : ''}`)); } catch (e) { toast((e as Error).message, 'err'); }
  }, [toast]);

  const load = useCallback(async (fresh = false) => {
    const my = ++loadId.current;
    setLoading(true);
    try {
      if (acc === UNIFIED) {
        const r = await api<{ rows: Row[]; errors: Record<string, string> }>(`/mail/unified/inbox?perPage=25${fresh ? '&fresh=1' : ''}`);
        if (my === loadId.current) { setRows(r.rows); setTotal(r.rows.length); setErrors(r.errors); }
      } else {
        const r = await api<{ rows: Row[]; total: number }>(`/mail/${acc}/messages?folder=${encodeURIComponent(folder)}&page=${page}&perPage=25${qLive ? '&q=' + encodeURIComponent(qLive) : ''}`);
        if (my === loadId.current) { setRows(r.rows); setTotal(r.total); setErrors({}); }
      }
    } catch (e) { if (my === loadId.current) { setRows([]); toast((e as Error).message, 'err'); } }
    finally { if (my === loadId.current) setLoading(false); }
  }, [acc, folder, page, qLive, toast]);

  useEffect(() => { setSel(new Set()); setOpen(null); loadFolders(acc); }, [acc, loadFolders]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(), 90_000); return () => clearInterval(t); }, [load]);

  const openRow = async (r: Row) => {
    setOpenKey(key(r));
    try {
      const m = await api<Msg>(`/mail/${r.accountId}/message?folder=${encodeURIComponent(r.folder)}&uid=${r.uid}`);
      setOpen(m); setRows((x) => x.map((y) => (key(y) === key(r) ? { ...y, seen: true } : y)));
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const act = async (a: 'delete' | 'unread' | 'star' | 'read' | 'move', items: { accountId: string; folder: string; uid: number; flagged?: boolean }[], target?: string) => {
    const byAcc = new Map<string, typeof items>();
    items.forEach((i) => byAcc.set(i.accountId + '|' + i.folder, [...(byAcc.get(i.accountId + '|' + i.folder) || []), i]));
    try {
      for (const [k, list] of byAcc) {
        const [accountId, fol] = k.split('|'); const uids = list.map((i) => i.uid);
        if (a === 'delete') {
          const isTrash = folders.find((f) => f.path === fol)?.special === 'Trash';
          if (isTrash && !confirm(`Permanently delete ${uids.length} message(s)? This cannot be undone.`)) return;
          await api(`/mail/${accountId}/delete`, 'POST', { folder: fol, uids });
        } else if (a === 'move') await api(`/mail/${accountId}/move`, 'POST', { folder: fol, uids, target });
        else if (a === 'unread') await api(`/mail/${accountId}/flags`, 'POST', { folder: fol, uids, remove: ['seen'] });
        else if (a === 'read') await api(`/mail/${accountId}/flags`, 'POST', { folder: fol, uids, add: ['seen'] });
        else await api(`/mail/${accountId}/flags`, 'POST', { folder: fol, uids, [list[0].flagged ? 'remove' : 'add']: ['flagged'] });
      }
      if (a === 'delete') toast('Moved to Trash'); if (a === 'move') toast('Moved');
      setSel(new Set()); if (a === 'delete' || a === 'move') setOpen(null);
      await load(true); loadFolders(acc, true);
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const selected = rows.filter((r) => sel.has(key(r)));
  const pages = Math.max(1, Math.ceil(total / 25));
  const accOf = (id: string) => accounts.find((a) => a.id === id);
  const newMsg = () => setCompose({ accountId: acc === UNIFIED ? accounts[0]?.id || '' : acc, to: '', cc: '', bcc: '', subject: '', text: '', files: [] });

  if (!accounts.length) return <div className="card empty">No mailbox with a saved SMTP password yet. Add a Hostinger or SMTP mailbox under Mailbox Accounts, and it appears here.</div>;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row sb wrap">
        <div className="row wrap">
          <button className="btn primary" onClick={newMsg}><Icon n="edit" /> Compose</button>
          <select style={{ width: 'auto', minWidth: 240 }} value={acc} onChange={(e) => { setAcc(e.target.value); setFolder('INBOX'); setPage(1); setQ(''); setQLive(''); }} aria-label="Mailbox">
            {accounts.length > 1 && <option value={UNIFIED}>All inboxes (combined)</option>}
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.email}</option>)}
          </select>
        </div>
        <span className="muted mono" style={{ fontSize: 11.5 }}>{sandbox ? 'Sandbox: you can read and organise, sending is off' : 'Live'} · AI checks today {meta.aiUsedToday}/{meta.aiDailyLimit}{meta.geminiConfigured ? '' : ' (offline)'}</span>
      </div>
      {Object.entries(errors).map(([k, v]) => <div key={k} className="err" style={{ fontSize: 12.5 }}>{k}: {v}</div>)}

      <div className="mailx">
        <div className="pane folders">
          {acc === UNIFIED ? <button className="on"><span>Inbox (all)</span></button> : folders.map((f) => (
            <button key={f.path} className={folder === f.path ? 'on' : ''} onClick={() => { setFolder(f.path); setPage(1); setQ(''); setQLive(''); setOpen(null); setSel(new Set()); }}>
              <span>{f.special || f.name}</span><span className="cnt">{f.unread > 0 ? f.unread : f.special === 'Inbox' || f.special === 'Trash' || f.special === 'Sent' ? f.total : ''}</span>
            </button>
          ))}
        </div>

        <div className="pane">
          <div className="mtool">
            <input type="checkbox" aria-label="Select all" checked={!!rows.length && sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map(key)) : new Set())} />
            <button className="icon-btn" title="Refresh" onClick={() => { load(true); loadFolders(acc, true); }}><Icon n="refresh" size={15} /></button>
            {selected.length > 0 && (<>
              <button className="icon-btn" title="Delete" onClick={() => act('delete', selected)}><Icon n="trash" size={15} /></button>
              <button className="btn sm" onClick={() => act('read', selected)}>Mark read</button>
              <button className="btn sm" onClick={() => act('unread', selected)}>Mark unread</button>
              {acc !== UNIFIED && <select style={{ width: 'auto', padding: '4px 8px' }} value="" onChange={(e) => e.target.value && act('move', selected, e.target.value)} aria-label="Move to"><option value="">Move to…</option>{folders.filter((f) => f.path !== folder).map((f) => <option key={f.path} value={f.path}>{f.special || f.name}</option>)}</select>}
            </>)}
            {acc !== UNIFIED && !selected.length && (
              <form style={{ display: 'flex', flex: 1 }} onSubmit={(e) => { e.preventDefault(); setPage(1); setQLive(q.trim()); }}>
                <input className="q" type="search" placeholder="Search subject, sender, recipient" value={q} onChange={(e) => { setQ(e.target.value); if (!e.target.value) setQLive(''); }} />
              </form>
            )}
          </div>
          <div className="mlist">
            {loading && !rows.length && <div className="empty">Loading…</div>}
            {!loading && !rows.length && <div className="empty">{qLive ? 'Nothing matches that search.' : 'This folder is empty.'}</div>}
            {rows.map((r) => (
              <div key={key(r)} role="button" tabIndex={0} className={'mrow' + (r.seen ? '' : ' unread') + (openKey === key(r) ? ' on' : '')} onClick={() => openRow(r)} onKeyDown={(e) => e.key === 'Enter' && openRow(r)}>
                <input type="checkbox" checked={sel.has(key(r))} onClick={(e) => e.stopPropagation()} onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(key(r)); else n.delete(key(r)); return n; })} aria-label="Select" />
                <button className={'starbtn' + (r.flagged ? ' on' : '')} onClick={(e) => { e.stopPropagation(); act('star', [r]); }} aria-label="Star"><Icon n="star" size={15} /></button>
                <div style={{ minWidth: 0 }}>
                  <div className="from">{r.fromName || r.from}{acc === UNIFIED && <span className="dim" style={{ fontWeight: 400 }}> · {accOf(r.accountId)?.name || r.accountName}</span>}</div>
                  <div className="subj">{r.subject}</div>
                  <div className={'hint ' + r.badge} title={r.badgeWhy}>{HINT[r.badge]}{r.answered ? ' · replied' : ''}</div>
                </div>
                <div className="meta">{when(r.date)}{r.hasAttachment && <><br /><Icon n="paperclip" size={12} /></>}</div>
              </div>
            ))}
          </div>
          {acc !== UNIFIED && total > 25 && (
            <div className="mtool" style={{ borderTop: '1px solid var(--border)', borderBottom: 0, justifyContent: 'space-between' }}>
              <span className="mono dim" style={{ fontSize: 11.5 }}>{total} messages · page {page}/{pages}</span>
              <span className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button><button className="btn sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older</button></span>
            </div>
          )}
        </div>

        {open ? <Reader m={open} accounts={accounts} onCompose={setCompose} onAct={(a, m) => act(a === 'delete' ? 'delete' : a === 'unread' ? 'unread' : 'star', [{ accountId: m.accountId, folder: m.folder, uid: m.uid, flagged: m.flagged }])} /> : <div className="pane"><div className="empty" style={{ margin: 'auto' }}>Select a message to read it</div></div>}
      </div>
      {compose && <Compose init={compose} accounts={accounts} sandbox={sandbox} onClose={() => setCompose(null)} onSent={() => { load(true); loadFolders(acc, true); }} />}
    </div>
  );
}
