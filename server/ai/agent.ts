import { GoogleGenAI } from '@google/genai';
import { today } from '../util.js';
import { searchKnowledge } from './knowledge.js';
import { db, markDirty, type Analysis, type Channel, type Conversation, type Intent } from '../store.js';

const INTENTS: Intent[] = ['lead_interested', 'pricing_question', 'support_request', 'objection', 'unsubscribe', 'spam', 'other'];
const clamp01 = (n: unknown) => { const v = Number(n); return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; };

const MODEL = () => process.env.GEMINI_MODEL || 'gemini-3.8-flash';
let client: GoogleGenAI | null = null;
/** Returns the Gemini client and counts the call against the daily cap; null (offline fallback) once the cap is reached. */
export const getClient = () => {
  if (!process.env.GEMINI_API_KEY) return null;
  const u = db.aiUsage;
  if (u.date !== today()) { u.date = today(); u.count = 0; }
  if (u.count >= db.settings.aiDailyLimit) return null;
  u.count++; markDirty();
  return (client ||= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));
};
export const aiUsageToday = () => (db.aiUsage.date === today() ? db.aiUsage.count : 0);
export const aiConfigured = () => !!process.env.GEMINI_API_KEY;
export const aiModel = MODEL;

const CHANNEL_STYLE: Record<Channel, string> = {
  email: 'Professional business email: greeting, short paragraphs, sign off with the sender name.',
  whatsapp: 'Conversational WhatsApp message: short, friendly, no subject line, max 3 sentences.',
  instagram: 'Instagram DM: casual, concise, max 2 sentences.',
  messenger: 'Facebook Messenger: friendly and concise, max 3 sentences.',
};

/** Deterministic fallback used when no Gemini key is set or the API call fails. */
export function heuristic(conv: Conversation, text: string): Analysis {
  const t = text.toLowerCase();
  const has = (...w: string[]) => w.some((x) => t.includes(x));
  const first = conv.contactName.split(/\s+/)[0] || 'there';
  let intent: Intent = 'other', sentiment: Analysis['sentiment'] = 'neutral', confidence = 0.55, reply = '';
  if (has('unsubscribe', 'remove me', 'stop emailing', 'do not contact', "don't contact", 'opt out', 'opt-out')) {
    intent = 'unsubscribe'; sentiment = 'negative'; confidence = 0.97;
    reply = `Hi ${first}, understood — you have been removed from our list and won't hear from us again.`;
  } else if (has('viagra', 'crypto giveaway', 'click here to claim', 'winner', 'lottery', 'seo services')) {
    intent = 'spam'; sentiment = 'negative'; confidence = 0.92;
  } else if (has('price', 'pricing', 'cost', 'quote', 'how much', 'plan')) {
    intent = 'pricing_question'; sentiment = 'positive'; confidence = 0.9;
    reply = `Hi ${first}, thanks for asking! Pricing depends on volume and the number of connected mailboxes. Could you share roughly how many emails per day you plan to send so I can recommend a plan?`;
  } else if (has('interested', 'works', 'thursday', 'schedule', 'call', 'demo', 'timely', 'sounds good', 'does your system support')) {
    intent = 'lead_interested'; sentiment = 'positive'; confidence = 0.9;
    reply = `Hi ${first}, great to hear from you! Yes, that's supported. Happy to set up a quick call. Does your suggested time still work?`;
  } else if (has('not interested', 'too expensive', 'already use', 'no thanks', 'competitor')) {
    intent = 'objection'; sentiment = 'negative'; confidence = 0.72;
    reply = `Hi ${first}, thanks for the honest feedback. Could you tell me what would make this a better fit?`;
  } else if (has('hipaa', 'compliance', 'baa', 'legal', 'contract', 'refund', 'problem', 'issue', 'not working', 'help')) {
    intent = 'support_request'; sentiment = 'neutral'; confidence = 0.7;
    reply = `Hi ${first}, thanks for reaching out. I want to give you an accurate answer, so I'm checking with the team and will reply shortly.`;
  } else {
    reply = `Hi ${first}, thanks for your message! Could you tell me a bit more about what you're looking for?`;
  }
  return { intent, sentiment, confidence, summary: text.slice(0, 140), suggestedReply: reply, reasons: 'Keyword classifier (no Gemini key configured or Gemini unavailable).', engine: 'heuristic' };
}

const FACTUAL: Intent[] = ['pricing_question', 'support_request', 'lead_interested', 'objection'];
/** Records which knowledge entries were used, and refuses to be confident about facts that no entry backs up. */
function ground(a: Analysis, passages: { title: string }[]): Analysis {
  if (passages.length) a.sources = [...new Set(passages.map((p) => p.title))];
  else if (db.knowledge.length && FACTUAL.includes(a.intent) && a.confidence > 0.75) {
    a.confidence = 0.75;
    a.reasons = (a.reasons ? a.reasons + ' ' : '') + 'Capped at 75%: nothing in the knowledge base covers this question.';
  }
  return a;
}
/** Without Gemini, quote the best matching knowledge passage so the staged draft is at least factual. */
function offlineWithKnowledge(a: Analysis, conv: Conversation, passages: { text: string }[]): Analysis {
  if (!passages.length || !FACTUAL.includes(a.intent)) return a;
  const first = conv.contactName.split(/\s+/)[0] || 'there';
  a.suggestedReply = `Hi ${first},\n\n${passages[0].text.slice(0, 700)}\n\nLet me know if you would like more detail.`;
  a.confidence = Math.min(a.confidence, 0.8);
  return a;
}

export async function analyze(conv: Conversation, text: string, instruction?: string): Promise<Analysis> {
  const ai = getClient();
  const passages = searchKnowledge(text + ' ' + (conv.subject || ''), 4);
  if (!ai || !db.settings.aiEnabled) return ground(offlineWithKnowledge(heuristic(conv, text), conv, passages), passages);
  const history = conv.messages.slice(-8).map((m) => `${m.dir === 'in' ? 'CONTACT' : 'US'}: ${m.text}`).join('\n');
  const prompt = [
    `Channel: ${conv.channel}. Style: ${CHANNEL_STYLE[conv.channel]}`,
    `About us: ${db.settings.businessContext}`,
    passages.length ? `Verified facts from our knowledge base (the only product, price, policy and delivery facts you may state):\n${passages.map((p, i) => `[${i + 1}] ${p.title}: ${p.text}`).join('\n')}` : (db.knowledge.length ? 'Our knowledge base has nothing relevant to this message, so do not state any specific product, price, policy or delivery facts; ask a clarifying question or say a colleague will follow up.' : ''),
    conv.subject ? `Subject: ${conv.subject}` : '',
    `Conversation so far:\n${history}`,
    `Newest inbound message:\n${text}`,
    instruction ? `Extra instruction for the reply: ${instruction}` : '',
    'Classify the newest inbound message and draft a reply. Be honest about uncertainty: confidence is the probability (0-1) that sending the drafted reply unreviewed is correct and safe. Use LOW confidence for legal/medical/compliance claims, pricing commitments, refunds, complaints, or anything you would have to guess. Never invent facts, prices or promises; use only the verified facts above when they are given. For unsubscribe or spam, leave suggestedReply empty.',
  ].filter(Boolean).join('\n\n');
  try {
    const res = await ai.models.generateContent({
      model: MODEL(),
      contents: prompt,
      config: {
        systemInstruction: 'You are the inbound triage and reply assistant for a business outreach team. Reply with JSON only.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            intent: { type: 'string', enum: INTENTS },
            sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            confidence: { type: 'number' },
            summary: { type: 'string' },
            suggestedReply: { type: 'string' },
            reasons: { type: 'string' },
          },
          required: ['intent', 'sentiment', 'confidence', 'summary', 'suggestedReply', 'reasons'],
        } as never,
      },
    });
    const j = JSON.parse(res.text || '{}');
    const intent: Intent = INTENTS.includes(j.intent) ? j.intent : 'other';
    return ground({
      intent,
      sentiment: ['positive', 'neutral', 'negative'].includes(j.sentiment) ? j.sentiment : 'neutral',
      confidence: clamp01(j.confidence),
      summary: String(j.summary || '').slice(0, 300),
      suggestedReply: String(j.suggestedReply || ''),
      reasons: String(j.reasons || ''),
      engine: 'gemini',
    }, passages);
  } catch (e) {
    console.error('Gemini analysis failed, using fallback:', (e as Error).message);
    const h = ground(offlineWithKnowledge(heuristic(conv, text), conv, passages), passages);
    h.reasons = `Gemini call failed (${(e as Error).message.slice(0, 120)}); keyword classifier used.`;
    return h;
  }
}
