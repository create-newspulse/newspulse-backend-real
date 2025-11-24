// Phase 2 AI & Policy Layer (initial real integration)
// Uses OpenAI to produce advisory rewrite + risk assessment.
// Never auto-publishes; founder review always required.
// If OPENAI_API_KEY missing or any failure occurs, we fallback gracefully.

const openai = require('../lib/openai');
const { computeCommunityPriority } = require('./communityPriority');
const MODEL_NAME = process.env.COMMUNITY_AI_MODEL || 'gpt-4.1-mini';

function buildPrompt(submission) {
  return `You are an AI assistant for News Pulse performing an ethics & policy pass on a community submitted news tip. \n\nGuidelines (PTI-style ethics):\n- No hate speech or communal incitement.\n- No graphic self-harm / gore detail.\n- Protect minors & sensitive victims (avoid identifying details).\n- Avoid unverified accusations / defamation.\n- Flag potentially unverified political or legal claims.\n- If content is extremely short, you may lightly clarify wording but do not invent facts.\n\nReturn ONLY strict JSON with this shape (no markdown, no extra commentary):\n{\n  "aiHeadline": "string",\n  "aiBody": "string",\n  "riskScore": 0,\n  "flags": ["string", "..."]\n}\n\nInputs:\nHeadline: ${submission.headline}\nBody: ${submission.body}\nLocation: ${submission.location || 'N/A'}\nCategory: ${submission.category || 'N/A'}\n\nProvide improved clarity while preserving factual claims; do not add new facts. Risk score: 0 (very safe) to 100 (very risky). Flags: machine readable tokens like: mentions_minor, possible_defamation, graphic_violence, political_claim_unverified, needs_verification.`;
}

async function runCommunityAiChecks(submission) {
  if (!submission) return submission;
  let parsed = null;
  const fallback = () => ({
    aiHeadline: submission.headline,
    aiBody: submission.body,
    riskScore: 50,
    flags: ['ai_parse_error'],
  });
  try {
    if (!openai) throw new Error('OpenAI client not initialized');
    const prompt = buildPrompt(submission);
    const response = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        { role: 'system', content: 'You analyze and rewrite community submissions, respond ONLY with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });
    const raw = response?.choices?.[0]?.message?.content || '';
    try {
      parsed = JSON.parse(raw);
    } catch (jsonErr) {
      console.warn('[CommunityAI][json-parse-failed]', jsonErr?.message || jsonErr);
      parsed = fallback();
    }
  } catch (e) {
    console.warn('[CommunityAI][invoke-failed]', e?.message || e);
    parsed = fallback();
  }

  // Defensive assignments
  submission.aiHeadline = typeof parsed.aiHeadline === 'string' && parsed.aiHeadline.trim() ? parsed.aiHeadline.trim() : submission.headline;
  submission.aiBody = typeof parsed.aiBody === 'string' && parsed.aiBody.trim() ? parsed.aiBody.trim() : submission.body;
  const riskScore = Number(parsed.riskScore);
  submission.riskScore = Number.isFinite(riskScore) ? Math.min(100, Math.max(0, Math.round(riskScore))) : 50;
  submission.flags = Array.isArray(parsed.flags) ? parsed.flags.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim()) : ['ai_error'];
  submission.status = 'PENDING_FOUNDER';
  submission.priority = computeCommunityPriority({
    category: submission.category,
    body: submission.body,
    location: submission.location,
    riskScore: submission.riskScore,
    flags: submission.flags,
  });
  await submission.save();

  // Safe logging (avoid PII & full content in production)
  const logPayload = {
    id: submission._id?.toString(),
    riskScore: submission.riskScore,
    flags: submission.flags,
    status: submission.status,
  };
  if (String(process.env.NODE_ENV).toLowerCase() === 'production') {
    console.log('[CommunityAI] Result', logPayload);
  } else {
    console.log('[CommunityAI] Result (dev)', { ...logPayload, aiHeadline: submission.aiHeadline.slice(0, 120) });
  }
  return submission;
}

module.exports = { runCommunityAiChecks };