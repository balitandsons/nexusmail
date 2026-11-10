import { Router } from 'express';
import { EMAIL_RE, clampInt, fail, str, uid } from '../util.js';
import { db, markDirty, setRecips, recips, suppressSet, type Contact, type Stage } from '../store.js';
import { h } from './api.js';
import { STAGES, findContact, mergeInto, normEmail, normPhone, reindex, timeline, upsertContact } from '../crm.js';
import { parseCSV } from '../engine/template.js';
import { parseImport, saveEntry, searchKnowledge } from '../ai/knowledge.js';

const router = Router();
const getContact = (id: string) => { const c = db.contacts.find((x) => x.id === id); if (!c) throw fail('Contact not found', 404); return c; };
const view = (c: Contact) => ({ ...c, notes: undefined, noteCount: c.notes.length });
const tags = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]/)).map((t) => String(t).trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean);

interface Filter { q?: string; stage?: string; tag?: string; state?: string }
const matches = (c: Contact, f: Filter) => (!f.stage || c.stage === f.stage) && (!f.tag || c.tags.includes(f.tag)) && (!f.state || (c.state || '') === f.state)
  && (!f.q || [c.name, c.company, c.state, ...c.emails, ...c.phones, ...c.tags].join(' ').toLowerCase().includes(f.q));
const filterOf = (o: Record<string, unknown>): Filter => ({ q: str(o.q).toLowerCase() || undefined, stage: str(o.stage) || undefined, tag: str(o.tag).toLowerCase() || undefined, state: str(o.state) || undefined });

router.get('/contacts', (req, res) => {
  const f = filterOf(req.query);
  const page = clampInt(req.query.page, 1, 10000, 1), per = clampInt(req.query.perPage, 10, 200, 50);
  const list = db.contacts.filter((c) => matches(c, f)).sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt));
  const counts = Object.fromEntries(STAGES.map((s) => [s, db.contacts.filter((c) => c.stage === s).length]));
  const states: Record<string, number> = {};
  for (const c of db.contacts) if (c.state) states[c.state] = (states[c.state] || 0) + 1;
  res.json({ total: list.length, counts, all: db.contacts.length, tags: [...new Set(db.contacts.flatMap((c) => c.tags))].sort(), states, contacts: list.slice((page - 1) * per, page * per).map(view) });
});
router.get('/contacts/export.csv', (_req, res) => {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['name', 'email', 'phone', 'company', 'state', 'stage', 'tags', 'source', 'last_activity'].join(',')];
  for (const c of db.contacts) lines.push([c.name, c.emails.join(' '), c.phones.join(' '), c.company, c.state, c.stage, c.tags.join(' '), c.source, c.lastActivityAt].map(q).join(','));
  res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="contacts.csv"'); res.send('﻿' + lines.join('\n'));
});
router.get('/contacts/:id', h((req, res) => { const c = getContact(String(req.params.id)); res.json({ ...c, timeline: timeline(c) }); }));

router.post('/contacts', h((req, res) => {
  const b = req.body || {};
  if (!b.email && !b.phone) throw fail('Add an email address or a phone number.');
  if (b.email && !EMAIL_RE.test(normEmail(String(b.email)))) throw fail('That email address is not valid.');
  const existing = findContact(b.email, b.phone);
  const c = upsertContact({ email: b.email, phone: b.phone, name: str(b.name), company: str(b.company), source: 'manual', tags: tags(b.tags) });
  if (!c) throw fail('Could not add that contact.');
  res.json({ ...view(c), existed: !!existing });
}));
router.put('/contacts/:id', h((req, res) => {
  const c = getContact(String(req.params.id)), b = req.body || {};
  if (b.name !== undefined) c.name = str(b.name) || c.emails[0] || c.phones[0] || 'Unnamed';
  if (b.company !== undefined) c.company = str(b.company);
  if (b.state !== undefined) c.state = str(b.state) || undefined;
  if (b.tags !== undefined) c.tags = [...new Set(tags(b.tags))];
  if (b.stage !== undefined) { if (!STAGES.includes(b.stage as Stage)) throw fail('Unknown stage.'); c.stage = b.stage; c.stageManual = true; }
  if (b.autoStage === true) c.stageManual = false;
  if (b.addEmail) { const e = normEmail(String(b.addEmail)); if (!EMAIL_RE.test(e)) throw fail('Invalid email.'); const other = findContact(e); if (other && other !== c) mergeInto(c, other); else if (!c.emails.includes(e)) c.emails.push(e); }
  if (b.addPhone) { const p = normPhone(String(b.addPhone)); if (p.length < 7) throw fail('Invalid phone number.'); const other = findContact(undefined, p); if (other && other !== c) mergeInto(c, other); else if (!c.phones.includes(p)) c.phones.push(p); }
  reindex(); markDirty(); res.json({ ...c, timeline: timeline(c) });
}));
router.delete('/contacts/:id', h((req, res) => { const c = getContact(String(req.params.id)); db.contacts = db.contacts.filter((x) => x !== c); reindex(); markDirty(); res.json({ ok: true }); }));
router.post('/contacts/:id/notes', h((req, res) => {
  const c = getContact(String(req.params.id)), text = str(req.body?.text);
  if (!text) throw fail('Write a note first.');
  c.notes.push({ id: uid(), at: new Date().toISOString(), by: req.user?.username ?? '?', text: text.slice(0, 4000) }); markDirty();
  res.json({ ...c, timeline: timeline(c) });
}));

/** CSV with an email or phone column; extra columns company/name/tags are used. */
router.post('/contacts/import', h((req, res) => {
  const rows = parseCSV(String(req.body?.text || '').replace(/^﻿/, ''));
  if (rows.length < 2) throw fail('Paste a CSV with a header row, e.g. email,name,company,state,phone,tags');
  const head = rows[0].map((x) => x.toLowerCase().replace(/[\s-]+/g, '_'));
  const col = (re: RegExp) => head.findIndex((x) => re.test(x));
  const ie = col(/^(e_?mail|email_address)$/), ip = col(/^(phone|mobile|whatsapp|phone_number)$/), inn = col(/^(name|full_name|first_name)$/), ic = col(/^(company|organi[sz]ation)$/), it = col(/^tags?$/), is = col(/^(state|name_of_state|region)$/);
  if (ie < 0 && ip < 0) throw fail('The CSV needs an email or phone column.');
  let added = 0, merged = 0, skipped = 0;
  for (const r of rows.slice(1)) {
    const email = ie >= 0 ? r[ie] : undefined, phone = ip >= 0 ? r[ip] : undefined;
    const had = findContact(email, phone);
    const c = upsertContact({ email, phone, name: inn >= 0 ? r[inn] : undefined, company: ic >= 0 ? r[ic] : undefined, state: is >= 0 ? r[is] : undefined, source: 'import', tags: it >= 0 ? tags(r[it]) : [] });
    if (!c) skipped++; else if (had) merged++; else added++;
  }
  res.json({ added, merged, skipped });
}));

/** Adds contacts to a campaign: either the ids ticked on screen, or everyone matching a filter (optionally only people not emailed yet, up to a limit). */
router.post('/contacts/to-campaign', h((req, res) => {
  const camp = db.campaigns.find((c) => c.id === req.body?.campaignId);
  if (!camp) throw fail('Pick a campaign.', 404);
  const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String));
  const filter = req.body?.filter ? filterOf(req.body.filter) : null;
  const onlyNew = req.body?.onlyNew !== false;
  const limit = clampInt(req.body?.limit, 1, 20000, 20000);
  const list = recips(camp.id), seen = new Set(list.map((r) => r.email));
  let added = 0, suppressed = 0, noEmail = 0, alreadyContacted = 0, matched = 0;
  for (const c of db.contacts) {
    if (filter ? !matches(c, filter) : !ids.has(c.id)) continue;
    matched++;
    if (added >= limit) break;
    const email = c.emails[0];
    if (!email) { noEmail++; continue; }
    if (seen.has(email)) continue;
    if (suppressSet.has(email) || c.stage === 'lost') { suppressed++; continue; }
    if (filter && onlyNew && c.stage !== 'new') { alreadyContacted++; continue; }
    seen.add(email); added++;
    list.push({ email, name: c.name === email ? '' : c.name, vars: { company: c.company, name: c.name, state: c.state || '' }, status: 'pending', acc: '', at: '', error: '' });
  }
  setRecips(camp.id, list);
  if (camp.status === 'done') camp.status = 'paused';
  markDirty(); res.json({ added, suppressed, noEmail, alreadyContacted, matched });
}));

/* ---------------- knowledge base + handoff rules ---------------- */
router.get('/knowledge', (_req, res) => res.json({ entries: [...db.knowledge].sort((a, b) => a.title.localeCompare(b.title)), handoff: db.settings.handoff, mailboxes: db.accounts.map((a) => ({ id: a.id, name: a.label || a.fromEmail })) }));
router.post('/knowledge', h((req, res) => {
  const title = str(req.body?.title), text = str(req.body?.text);
  if (!title || !text) throw fail('Give the entry a title and some text.');
  res.json(saveEntry({ id: req.body?.id, title, text, tags: tags(req.body?.tags) }));
}));
router.delete('/knowledge/:id', h((req, res) => { db.knowledge = db.knowledge.filter((k) => k.id !== req.params.id); markDirty(); res.json({ ok: true }); }));
router.post('/knowledge/import', h((req, res) => {
  const items = parseImport(String(req.body?.text || ''));
  if (!items.length) throw fail('Nothing to import. Use "Q: question" then "A: answer" blocks, or "# Title" sections.');
  items.slice(0, 200).forEach((i) => saveEntry({ title: i.title, text: i.text }));
  res.json({ added: Math.min(items.length, 200) });
}));
router.post('/knowledge/test', h((req, res) => res.json({ passages: searchKnowledge(str(req.body?.question), 4) })));

router.put('/handoff', h((req, res) => {
  const b = req.body || {}, hf = db.settings.handoff;
  if (b.enabled !== undefined) hf.enabled = !!b.enabled;
  if (b.keywords !== undefined) hf.keywords = tags(b.keywords).map((k) => k.replace(/-/g, ' ')).slice(0, 50);
  if (b.negative !== undefined) hf.negative = !!b.negative;
  if (b.vip !== undefined) hf.vip = !!b.vip;
  if (b.notifyEmail !== undefined) { const e = str(b.notifyEmail); if (e && !EMAIL_RE.test(e)) throw fail('Alert email is not valid.'); hf.notifyEmail = e; }
  if (b.notifyAccountId !== undefined) hf.notifyAccountId = String(b.notifyAccountId);
  markDirty(); res.json(hf);
}));

export default router;
