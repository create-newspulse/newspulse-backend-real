// services/communityAiReview.js
// Community Reporter Phase 2: AI policy & quality review
// - Uses existing OpenAI client at lib/openai.js when available
// - Produces { aiTitle, aiBody, riskScore, flags, policyNotes, aiSuggestedCategory, aiSuggestedTags, aiTipOnlySuggested }
// - Never throws; returns safe fallback on errors

const openai = require('../lib/openai');

const MODEL = process.env.COMMUNITY_AI_MODEL || 'gpt-4.1-mini';

function clampScore(n, min = 0, max = 100) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function fallbackResult() {
  return {
    aiTitle: null,
    aiBody: null,
    riskScore: 0,
    flags: ['ai_error'],
    policyNotes: 'AI review failed – treat with manual care.',
    aiSuggestedCategory: null,
    aiSuggestedTags: [],
    aiTipOnlySuggested: false,
  };
}

function buildMessages(input) {
  const system = [
    'You are an assistant performing an ethics & policy pass for a news desk.',
    'Rules:',
    '- Detect hate speech, communal tension, targeted insults.',
    '- Detect exposure of private data (phone numbers, exact addresses, medical details).',
    '- Detect minors or sensitive victims (avoid identifying details).',
    '- Detect strong unverified accusations / defamation risk.',
    '- Rewrite into neutral, factual news style (no abuse) in aiBody.',
    '- Suggest a clean headline in aiTitle.',
    '- Output riskScore 0-100 (0 very safe, 100 extremely risky).',
    '- Output policyNotes: a short one-line founder note.',
    'Respond ONLY with strict JSON. No markdown.',
  ].join('\n');

  const user = [
    `UserName: ${input.userName || 'N/A'}`,
    `City: ${input.city || input.location || 'N/A'}`,
    `Category: ${input.category || 'N/A'}`,
    `Headline: ${input.headline || ''}`,
    `Body: ${input.body || ''}`,
    input.ageGroup ? `AgeGroup: ${input.ageGroup}` : '',
    '',
    'Also suggest a NewsPulse section (one of: "regional", "youth", "campus", "civic", "lifestyle", "other").',
    'Generate 3–8 relevant plain-language tags (no hashtags).',
    'Decide if this is a tip/lead (unverified/missing details) -> aiTipOnlySuggested = true, else false.',
    'Return JSON with keys: aiTitle, aiBody, riskScore, flags (array), policyNotes, aiSuggestedCategory, aiSuggestedTags (array, max 8), aiTipOnlySuggested (boolean).',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

async function callOpenAi(messages) {
  if (!openai) throw new Error('OpenAI client not initialized');
  const res = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 900,
    response_format: { type: 'json_object' },
  });
  const content = res?.choices?.[0]?.message?.content || '';
  return JSON.parse(content);
}

/**
 * @param {{userName?:string, city?:string, location?:string, category?:string, headline:string, body:string, ageGroup?:string}} input
 * @returns {Promise<{aiTitle:string|null, aiBody:string|null, riskScore:number, flags:string[], policyNotes:string, aiSuggestedCategory:string|null, aiSuggestedTags:string[], aiTipOnlySuggested:boolean}>}
 */
async function runCommunityAiReview(input) {
  try {
    const messages = buildMessages(input || {});
    const raw = await callOpenAi(messages);
    const aiTitle = typeof raw.aiTitle === 'string' ? raw.aiTitle.trim() : null;
    const aiBody = typeof raw.aiBody === 'string' ? raw.aiBody.trim() : null;
    const riskScore = clampScore(raw.riskScore);
    const flags = Array.isArray(raw.flags) ? raw.flags.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim()) : [];
    const policyNotes = typeof raw.policyNotes === 'string' && raw.policyNotes.trim() ? raw.policyNotes.trim() : '';

    let aiSuggestedCategory = null;
    if (typeof raw.aiSuggestedCategory === 'string') {
      const cat = raw.aiSuggestedCategory.trim().toLowerCase();
      const allowed = new Set(['regional', 'youth', 'campus', 'civic', 'lifestyle', 'other']);
      aiSuggestedCategory = allowed.has(cat) ? cat : 'other';
    }

    let aiSuggestedTags = [];
    if (Array.isArray(raw.aiSuggestedTags)) {
      aiSuggestedTags = raw.aiSuggestedTags
        .filter(t => typeof t === 'string' && t.trim())
        .map(t => t.trim())
        .slice(0, 8);
    }

    const aiTipOnlySuggested = Boolean(raw.aiTipOnlySuggested);

    return { aiTitle, aiBody, riskScore, flags, policyNotes, aiSuggestedCategory, aiSuggestedTags, aiTipOnlySuggested };
  } catch (e) {
    console.error('[communityAiReview] AI call failed:', e?.message || e);
    return fallbackResult();
  }
}

module.exports = { runCommunityAiReview };
