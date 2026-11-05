import { uid } from '../util.js';
import { db, markDirty, type KnowledgeEntry } from '../store.js';

const STOP = new Set('the and for are but not you your yours with this that from have has had was were will can could would should about what when where which who how why any all our out too very just into over than then them they their there here been being does did doing also more most some such only own same its it is in on of to a an as at by be or if do so we i me my us he she his her am'.split(' '));
const tokens = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, (m) => (w.length - m.length >= 3 ? '' : m)));

export interface Passage { entryId: string; title: string; text: string; score: number }
interface Chunk { entryId: string; title: string; text: string; tf: Map<string, number>; len: number }

let chunks: Chunk[] = [], idf = new Map<string, number>(), avgLen = 1, stamp = '';
const sig = () => db.knowledge.map((k) => k.id + k.updatedAt).join('|');

/** Splits entries into paragraph-sized chunks (about 600 characters) and prepares BM25 statistics. */
function build() {
  chunks = [];
  for (const k of db.knowledge) {
    const paras = k.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let cur = '';
    const flush = () => { if (cur) { push(k, cur); cur = ''; } };
    for (const p of paras) { if (cur && cur.length + p.length > 600) flush(); cur += (cur ? '\n\n' : '') + p; }
    flush();
    if (!paras.length) push(k, k.title);
  }
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + (chunks.length - n + 0.5) / (n + 0.5))]));
  avgLen = chunks.reduce((s, c) => s + c.len, 0) / Math.max(1, chunks.length);
  stamp = sig();
}
function push(k: KnowledgeEntry, text: string) {
  const tf = new Map<string, number>();
  const toks = [...tokens(k.title), ...tokens(k.title), ...tokens(k.tags.join(' ')), ...tokens(text)]; // title and tags count double
  for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
  chunks.push({ entryId: k.id, title: k.title, text, tf, len: toks.length });
}

/** BM25 search: the best passages for a customer's question. Returns nothing when no real term overlaps. */
export function searchKnowledge(query: string, k = 4): Passage[] {
  if (!db.knowledge.length) return [];
  if (stamp !== sig()) build();
  const q = [...new Set(tokens(query))];
  const out: Passage[] = [];
  for (const c of chunks) {
    let score = 0, hits = 0;
    for (const t of q) {
      const f = c.tf.get(t); if (!f) continue;
      hits++; score += (idf.get(t) || 0) * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (c.len / avgLen))));
    }
    if (hits && score > 0.3) out.push({ entryId: c.entryId, title: c.title, text: c.text, score: Math.round(score * 100) / 100 });
  }
  out.sort((a, b) => b.score - a.score);
  return out.filter((p) => p.score >= out[0].score * 0.4).slice(0, k); // drop weak matches that only share a stray word
}

export function saveEntry(i: { id?: string; title: string; text: string; tags?: string[] }): KnowledgeEntry {
  const now = new Date().toISOString();
  let e = i.id ? db.knowledge.find((x) => x.id === i.id) : undefined;
  if (!e) { e = { id: uid(), title: '', text: '', tags: [], updatedAt: now }; db.knowledge.push(e); }
  e.title = i.title.trim().slice(0, 160); e.text = i.text.trim().slice(0, 20000); e.tags = (i.tags ?? e.tags).map((t) => t.trim().toLowerCase()).filter(Boolean); e.updatedAt = now;
  markDirty(); return e;
}

/** Accepts pasted FAQ text: "Q: ... A: ..." pairs, or sections starting with "# Title". */
export function parseImport(text: string): { title: string; text: string }[] {
  const out: { title: string; text: string }[] = [];
  const qa = [...text.matchAll(/^\s*Q:\s*([^\n]+)\n\s*A:\s*([\s\S]*?)(?=\n\s*Q:|\s*$)/gim)];
  if (qa.length) { for (const m of qa) out.push({ title: m[1].trim(), text: m[2].trim() }); return out; }
  const parts = text.split(/^#{1,3}\s+/m).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1 || /^#/.test(text.trim())) { for (const p of parts) { const [t, ...rest] = p.split('\n'); out.push({ title: t.trim(), text: rest.join('\n').trim() || t.trim() }); } return out; }
  for (const p of text.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) out.push({ title: p.split(/[.!?\n]/)[0].slice(0, 80), text: p });
  return out;
}
