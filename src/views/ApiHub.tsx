import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../components/ui';
import type { ViewCtx } from '../App';

export default function ApiHub({ settings, refreshSettings }: ViewCtx) {
  const toast = useToast();
  const [f, setF] = useState<Record<string, any>>({});
  const [supp, setSupp] = useState('');
  const [sim, setSim] = useState({ channel: 'whatsapp', name: 'Test Contact', handle: '14155550123', text: 'Hi! What is the pricing for 10 mailboxes?' });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  useEffect(() => {
    if (!settings) return;
    setF({ publicUrl: settings.publicUrl, testEmail: settings.testEmail, defaultMin: settings.defaultMin, defaultMax: settings.defaultMax, threshold: Math.round(settings.confidenceThreshold * 100), autopilot: settings.autopilot, aiEnabled: settings.aiEnabled, aiDailyLimit: settings.aiDailyLimit, autoUnsub: settings.autoUnsub, businessContext: settings.businessContext, waPhone: settings.whatsapp.phoneId, waVerify: settings.whatsapp.verifyToken, metaVerify: settings.meta.verifyToken, waToken: '', metaToken: '', metaSecret: '' });
    api<{ text: string }>('/suppress').then((r) => setSupp(r.text)).catch(() => undefined);
  }, [settings]);
  if (!settings) return null;
  const base = f.publicUrl || window.location.origin;
  const save = async () => {
    try {
      await api('/settings', 'PUT', {
        publicUrl: f.publicUrl, testEmail: f.testEmail, defaultMin: Number(f.defaultMin), defaultMax: Number(f.defaultMax), confidenceThreshold: Number(f.threshold) / 100,
        autopilot: f.autopilot, aiEnabled: f.aiEnabled, aiDailyLimit: Number(f.aiDailyLimit), autoUnsub: f.autoUnsub, businessContext: f.businessContext,
        whatsapp: { token: f.waToken, phoneId: f.waPhone, verifyToken: f.waVerify }, meta: { pageToken: f.metaToken, appSecret: f.metaSecret, verifyToken: f.metaVerify },
      });
      await api('/suppress', 'PUT', { text: supp });
      toast('Settings saved'); refreshSettings();
    } catch (e) { toast((e as Error).message, 'err'); }
  };
  const endpoints = [
    ['GET/POST', '/webhooks/whatsapp', 'WhatsApp Cloud API. Verify token below; payloads must be signed with your Meta app secret (X-Hub-Signature-256).'],
    ['GET/POST', '/webhooks/meta', 'Instagram & Facebook Messenger (Meta Graph webhooks). Same verify token / app secret rules.'],
    ['POST', '/webhooks/email', 'Inbound email (e.g. a provider’s inbound-parse). Header Authorization: Bearer <verify token>. JSON: {from, name, subject, text}.'],
    ['GET', '/u/:token', 'One-click unsubscribe page (also used for List-Unsubscribe-Post).'],
  ];
  return (
    <div className="stack" style={{ gap: 20 }}>
      <div className="card stack">
        <h3>Webhook Endpoints</h3>
        <div className="muted" style={{ fontSize: 13 }}>Paste these URLs into your Meta developer app. They must be publicly reachable over HTTPS (set the Public URL below on your server or tunnel).</div>
        <table className="t"><tbody>{endpoints.map(([m, p, d]) => (
          <tr key={p}><td className="mono dim" style={{ width: 90 }}>{m}</td><td className="mono" style={{ wordBreak: 'break-all' }}>{base}{p}</td><td className="muted">{d}</td></tr>
        ))}</tbody></table>
      </div>

      <div className="two" style={{ alignItems: 'start' }}>
        <div className="card stack">
          <h3>Channels &amp; Secrets</h3>
          <label className="f">WhatsApp Cloud access token{settings.whatsapp.hasToken && <small>A token is saved. Leave blank to keep it.</small>}<input type="password" value={f.waToken || ''} onChange={(e) => set('waToken', e.target.value)} autoComplete="new-password" /></label>
          <div className="two"><label className="f">Phone number ID<input value={f.waPhone || ''} onChange={(e) => set('waPhone', e.target.value)} /></label><label className="f">WhatsApp verify token<input value={f.waVerify || ''} onChange={(e) => set('waVerify', e.target.value)} /></label></div>
          <label className="f">Meta page access token (Instagram / Messenger){settings.meta.hasPageToken && <small>Saved. Leave blank to keep it.</small>}<input type="password" value={f.metaToken || ''} onChange={(e) => set('metaToken', e.target.value)} autoComplete="new-password" /></label>
          <div className="two"><label className="f">Meta app secret{settings.meta.hasAppSecret && <small>Saved.</small>}<input type="password" value={f.metaSecret || ''} onChange={(e) => set('metaSecret', e.target.value)} autoComplete="new-password" /></label><label className="f">Meta verify token<input value={f.metaVerify || ''} onChange={(e) => set('metaVerify', e.target.value)} /></label></div>
          <div className="muted" style={{ fontSize: 12.5 }}>Gemini: {settings.geminiConfigured ? `configured (${settings.geminiModel})` : 'GEMINI_API_KEY not set in the server environment'}. API keys for Gemini are read from the server environment only.</div>
        </div>
        <div className="card stack">
          <h3>AI Autopilot &amp; Sending Defaults</h3>
          <label className="row"><input type="checkbox" checked={!!f.aiEnabled} onChange={(e) => set('aiEnabled', e.target.checked)} /> Use Gemini for intent analysis and drafts</label>
          <label className="f">Daily AI call limit<small>Keeps the Gemini bill near zero. Over the limit, the free offline classifier is used. Today: {settings.aiUsedToday ?? 0} used.</small><input type="number" min={0} value={f.aiDailyLimit ?? 300} onChange={(e) => set('aiDailyLimit', e.target.value)} /></label>
          <label className="row"><input type="checkbox" checked={!!f.autopilot} onChange={(e) => set('autopilot', e.target.checked)} /> Hybrid autopilot: auto-send replies at or above the confidence threshold</label>
          <label className="f"><span className="row sb"><span>Confidence threshold</span><b className="mono">{f.threshold}%</b></span><input type="range" min={50} max={99} value={f.threshold || 85} onChange={(e) => set('threshold', e.target.value)} /></label>
          <label className="f">Business context for the AI<textarea rows={3} value={f.businessContext || ''} onChange={(e) => set('businessContext', e.target.value)} style={{ fontFamily: 'var(--body)' }} /></label>
          <div className="two"><label className="f">Default min delay (s)<input type="number" value={f.defaultMin || ''} onChange={(e) => set('defaultMin', e.target.value)} /></label><label className="f">Default max delay (s)<input type="number" value={f.defaultMax || ''} onChange={(e) => set('defaultMax', e.target.value)} /></label></div>
          <label className="f">Public URL<small>Used for unsubscribe links and webhook URLs</small><input value={f.publicUrl || ''} onChange={(e) => set('publicUrl', e.target.value)} placeholder="https://mail.yourdomain.com" /></label>
          <label className="f">Default test email<input type="email" value={f.testEmail || ''} onChange={(e) => set('testEmail', e.target.value)} /></label>
          <label className="row"><input type="checkbox" checked={!!f.autoUnsub} onChange={(e) => set('autoUnsub', e.target.checked)} /> Always append an unsubscribe link</label>
        </div>
      </div>

      <div className="card stack">
        <h3>Do-not-send list ({settings.suppressCount})</h3>
        <textarea rows={4} value={supp} onChange={(e) => setSupp(e.target.value)} placeholder="One email per line. People who unsubscribe or ask to be removed are added automatically." />
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={save}>Save settings</button></div>
      </div>

      <div className="card stack">
        <h3>Incoming Event Simulator</h3>
        <div className="muted" style={{ fontSize: 13 }}>Runs a fake inbound message through the real AI pipeline. In Sandbox mode nothing is delivered externally.</div>
        <div className="two">
          <label className="f">Channel<select value={sim.channel} onChange={(e) => setSim({ ...sim, channel: e.target.value })}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option><option value="messenger">Messenger</option></select></label>
          <label className="f">Contact name<input value={sim.name} onChange={(e) => setSim({ ...sim, name: e.target.value })} /></label>
        </div>
        <label className="f">Handle (email / phone / scoped ID)<input value={sim.handle} onChange={(e) => setSim({ ...sim, handle: e.target.value })} /></label>
        <label className="f">Message<textarea rows={3} value={sim.text} onChange={(e) => setSim({ ...sim, text: e.target.value })} style={{ fontFamily: 'var(--body)' }} /></label>
        <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={async () => { try { const c = await api<any>('/inbox/simulate', 'POST', sim); toast(`Processed: ${c.analysis?.intent} · ${Math.round((c.analysis?.confidence || 0) * 100)}% · ${c.status}`); } catch (e) { toast((e as Error).message, 'err'); } }}>Send simulated event</button></div>
      </div>
    </div>
  );
}
