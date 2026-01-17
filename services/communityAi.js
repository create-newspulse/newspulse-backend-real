// Phase 2 AI & Policy Layer (initial real integration)
// Uses OpenAI to produce advisory rewrite + risk assessment.
// Never auto-publishes; founder review always required.
// If OPENAI_API_KEY missing or any failure occurs, we fallback gracefully.

const openai = require('../lib/openai');
const ActivityLog = require('../models/ActivityLog');
const mongoose = require('mongoose');
const { computeCommunityPriority } = require('./communityPriority');
const MODEL_NAME = process.env.COMMUNITY_AI_MODEL || 'gpt-4.1-mini';
// lightweight module state for health reporting
let lastInvoke = { ok: false, at: null, message: 'never-invoked', riskScore: null, flags: null };

function buildPrompt(submission) {
  return `You are an AI assistant for News Pulse performing an ethics & policy pass on a community submitted news tip. \n\nGuidelines (PTI-style ethics):\n- No hate speech or communal incitement.\n- No graphic self-harm / gore detail.\n- Protect minors & sensitive victims (avoid identifying details).\n- Avoid unverified accusations / defamation.\n- Flag potentially unverified political or legal claims.\n- If content is extremely short, you may lightly clarify wording but do not invent facts.\n\nReturn ONLY strict JSON with this shape (no markdown, no extra commentary):\n{\n  "aiHeadline": "string",\n  "aiBody": "string",\n  "riskScore": 0,\n  "flags": ["string", "..."]\n}\n\nInputs:\nHeadline: ${submission.headline}\nBody: ${submission.body}\nLocation: ${submission.location || 'N/A'}\nCategory: ${submission.category || 'N/A'}\n\nProvide improved clarity while preserving factual claims; do not add new facts. Risk score: 0 (very safe) to 100 (very risky). Flags: machine readable tokens like: mentions_minor, possible_defamation, graphic_violence, political_claim_unverified, needs_verification.`;
}

// Config validation for CommunityAI integration (non-fatal)
const COMMUNITY_AI_URL = process.env.COMMUNITY_AI_URL || '';
const COMMUNITY_AI_API_KEY = process.env.COMMUNITY_AI_API_KEY || '';
const HAS_COMMUNITY_AI_CFG = Boolean(COMMUNITY_AI_URL) && Boolean(COMMUNITY_AI_API_KEY);
if (!HAS_COMMUNITY_AI_CFG) {
  console.info('[CommunityAI][config]', {
    hasUrl: Boolean(COMMUNITY_AI_URL),
    hasKey: Boolean(COMMUNITY_AI_API_KEY),
  });
}

async function runCommunityAiChecks(submission) {
  if (!submission) return submission;

  // Tests monkey-patch CommunitySubmission to avoid real Mongo + external calls.
  // Keep tests deterministic and avoid background DB writes.
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') {
    return submission;
  }

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
      console.warn('[CommunityAI][parse][json-parse-failed]', { message: jsonErr?.message || String(jsonErr) });
      parsed = fallback();
    }
    lastInvoke = { ok: true, at: new Date().toISOString(), message: 'success', riskScore: parsed.riskScore ?? null, flags: parsed.flags ?? null };
  } catch (e) {
    // Log with more context (submission id + stack when available)
    try {
      console.error('[CommunityAI][invoke-failed]', {
        id: submission._id?.toString(),
        message: e?.message || e,
        stack: e?.stack,
        url: COMMUNITY_AI_URL || 'openai-sdk',
        hasKey: Boolean(COMMUNITY_AI_API_KEY || process.env.OPENAI_API_KEY),
      });
      // non-blocking activity log record for observability
      try {
        if (mongoose?.connection?.readyState === 1) {
          ActivityLog.create({ type: 'community_ai_fail', meta: { submissionId: submission._id?.toString(), error: e?.message || String(e) } });
        }
      } catch (_) {}
    } catch (_) {}
    parsed = fallback();
    lastInvoke = { ok: false, at: new Date().toISOString(), message: e?.message || String(e), riskScore: parsed.riskScore, flags: parsed.flags };
  }

  // Defensive assignments
  submission.aiHeadline = typeof parsed.aiHeadline === 'string' && parsed.aiHeadline.trim() ? parsed.aiHeadline.trim() : submission.headline;
  submission.aiBody = typeof parsed.aiBody === 'string' && parsed.aiBody.trim() ? parsed.aiBody.trim() : submission.body;
  const riskScore = Number(parsed.riskScore);
  submission.riskScore = Number.isFinite(riskScore) ? Math.min(100, Math.max(0, Math.round(riskScore))) : 50;
  submission.flags = Array.isArray(parsed.flags) ? parsed.flags.filter(f => typeof f === 'string' && f.trim()).map(f => f.trim()) : ['ai_parse_error'];
  submission.status = 'PENDING_FOUNDER';
  submission.priority = computeCommunityPriority({
    category: submission.category,
    body: submission.body,
    location: submission.location,
    riskScore: submission.riskScore,
    flags: submission.flags,
  });

  if (typeof submission.save === 'function') {
    await submission.save();
  }

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
function getCommunityAiHealth() {
  return {
    config: {
      hasUrl: Boolean(COMMUNITY_AI_URL),
      hasKey: Boolean(COMMUNITY_AI_API_KEY || process.env.OPENAI_API_KEY),
      model: MODEL_NAME,
    },
    lastInvoke,
  };
}

module.exports = { runCommunityAiChecks, getCommunityAiHealth };