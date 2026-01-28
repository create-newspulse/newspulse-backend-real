const mongoose = require('mongoose');
const crypto = require('node:crypto');

const BroadcastItem = require('../models/BroadcastItem');
let TranslationMemory;
try {
  TranslationMemory = require('../models/TranslationMemory');
} catch (_) {
  TranslationMemory = null;
}

let GlossaryTerm;
try {
  GlossaryTerm = require('../models/GlossaryTerm');
} catch (_) {
  GlossaryTerm = null;
}

const googleProvider = require('./translation/providers/googleProvider');
const microsoftProvider = require('./translation/providers/microsoftProvider');
const awsProvider = require('./translation/providers/awsProvider');
const { extractEntities, lockEntities, restoreEntities } = require('./translation/entityLocking');
const { applyStylePack } = require('./translation/stylePacks');
const { classifyTopics, isStrictTopic } = require('./translation/topics');
const { qaCheckExpanded, scoreTranslationExpanded, jaccardSimilarity } = require('./translation/qa');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v, fallback = 'gu') {
  const s = String(v || '').trim().toLowerCase();
  if (SUPPORTED_LANGS.includes(s)) return s;
  return fallback;
}

function _normalizeForHash(s) {
  return String(s || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
}

function _sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function _parseProvidersEnv() {
  const explicit = String(process.env.TRANSLATE_PROVIDERS || '').trim();
  const single = String(process.env.TRANSLATE_PROVIDER || '').trim();
  const raw = explicit || single;

  const list = raw
    ? raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];

  // AUTO means: use all configured.
  if (list.includes('AUTO')) return ['AUTO'];
  // Repo goal: default GOOGLE-only when unset.
  if (list.length === 0) return ['GOOGLE'];
  return list;
}

function _configuredProviders() {
  const providers = [];
  if (googleProvider.isConfigured()) providers.push(googleProvider);
  if (microsoftProvider.isConfigured()) providers.push(microsoftProvider);
  if (awsProvider.isConfigured()) providers.push(awsProvider);
  return providers;
}

function _selectProviders() {
  const desired = _parseProvidersEnv();
  if (desired.includes('NONE')) return [];

  const configured = _configuredProviders();
  if (desired.includes('AUTO')) return configured;

  const wanted = new Set(desired);
  return configured.filter(p => wanted.has(String(p.name || '').toUpperCase()));
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function preprocess(text) {
  const locks = [];
  let out = String(text || '');

  const lockPattern = (re) => {
    out = out.replace(re, (m) => {
      const placeholder = `__LOCK_${locks.length}__`;
      locks.push({ placeholder, value: m });
      return placeholder;
    });
  };

  // Lock URLs
  lockPattern(/https?:\/\/\S+/gi);
  // Lock common date-like tokens
  lockPattern(/\b\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}\b/g);
  // Lock numbers (including decimals)
  lockPattern(/\b\d+(?:[\.,]\d+)?\b/g);
  // Lock @mentions / hashtags (common tokens)
  lockPattern(/[@#][A-Za-z0-9_]+/g);

  return { text: out, locks };
}

function restorePlaceholders(text, locks) {
  let out = String(text || '');
  for (const l of Array.isArray(locks) ? locks : []) {
    if (!l || !l.placeholder) continue;
    out = out.split(String(l.placeholder)).join(String(l.value));
  }
  return out;
}

async function loadGlossaryTerms() {
  if (!GlossaryTerm) return [];
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return [];
  try {
    // Phase 1 minimal: load a bounded set.
    return await GlossaryTerm.find({}).sort({ keyNorm: 1 }).limit(500).lean();
  } catch (_) {
    return [];
  }
}

function _collectGlossaryLockedTerms(terms) {
  const out = [];
  const list = Array.isArray(terms) ? terms : [];
  for (const t of list) {
    if (t && t.doNotTranslate && t.key) {
      out.push(String(t.key).trim());
    }
  }
  return out.filter(Boolean).sort((a, b) => b.length - a.length);
}

async function _lookupTranslationMemory({ sourceText, sourceLang, targetLang }) {
  if (!TranslationMemory) return null;
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return null;

  const normalized = _normalizeForHash(sourceText);
  const sourceHash = _sha256Hex(normalized);
  const doc = await TranslationMemory.findOne({ sourceHash, sourceLang, targetLang, approved: true }).lean();
  if (!doc) return null;
  return {
    ok: true,
    engineUsed: doc.engineUsed || 'TM',
    text: String(doc.translatedText || ''),
    qualityScore: typeof doc.qualityScore === 'number' ? doc.qualityScore : 100,
    sourceHash,
  };
}

async function _upsertTranslationMemory({ sourceText, sourceLang, targetLang, translatedText, qualityScore, approved, engineUsed }) {
  if (!TranslationMemory) return;
  if (!mongoose.connection || mongoose.connection.readyState !== 1) return;

  const normalized = _normalizeForHash(sourceText);
  const sourceHash = _sha256Hex(normalized);
  try {
    await TranslationMemory.updateOne(
      { sourceHash, sourceLang, targetLang },
      {
        $set: {
          sourceHash,
          sourceLang,
          targetLang,
          translatedText: String(translatedText || ''),
          qualityScore: typeof qualityScore === 'number' ? qualityScore : 0,
          approved: Boolean(approved),
          engineUsed: String(engineUsed || ''),
        },
      },
      { upsert: true },
    );
  } catch (_) {
    // ignore
  }
}

function applyGlossary(text, sourceLang, targetLang, terms) {
  let out = String(text || '');
  const src = normalizeLang(sourceLang, 'gu');
  const dst = normalizeLang(targetLang, 'gu');

  const list = Array.isArray(terms) ? terms : [];
  for (const term of list) {
    const key = String(term && term.key ? term.key : '').trim();
    if (!key) continue;

    // If doNotTranslate: keep the key exactly as-is.
    const replacementRaw = term && term.doNotTranslate
      ? key
      : (term && typeof term[dst] === 'string' && term[dst].trim()
        ? term[dst]
        : (term && typeof term[src] === 'string' && term[src].trim() ? term[src] : key));

    const replacement = String(replacementRaw || '').trim();
    if (!replacement) continue;

    const re = new RegExp(escapeRegex(key), 'gi');
    out = out.replace(re, replacement);
  }

  return out;
}

function _providerConfigStatus(provider) {
  const p = String(provider || 'NONE').trim().toUpperCase();
  if (p === 'NONE') return { ok: false, reason: 'NO_PROVIDER_CONFIG' };

  if (p === 'GOOGLE') {
    if (!process.env.GOOGLE_TRANSLATE_API_KEY) return { ok: false, reason: 'MISSING_GOOGLE_TRANSLATE_API_KEY' };
    return { ok: true };
  }

  if (p === 'MICROSOFT') {
    if (!process.env.MICROSOFT_TRANSLATOR_KEY) return { ok: false, reason: 'MISSING_MICROSOFT_TRANSLATOR_KEY' };
    if (!process.env.MICROSOFT_TRANSLATOR_REGION) return { ok: false, reason: 'MISSING_MICROSOFT_TRANSLATOR_REGION' };
    return { ok: true };
  }

  if (p === 'AWS') {
    if (!process.env.AWS_ACCESS_KEY_ID) return { ok: false, reason: 'MISSING_AWS_ACCESS_KEY_ID' };
    if (!process.env.AWS_SECRET_ACCESS_KEY) return { ok: false, reason: 'MISSING_AWS_SECRET_ACCESS_KEY' };
    if (!process.env.AWS_REGION) return { ok: false, reason: 'MISSING_AWS_REGION' };
    return { ok: true };
  }

  return { ok: false, reason: 'UNKNOWN_PROVIDER' };
}

async function translateWithProvider(text, sourceLang, targetLang) {
  // Backward-compat: keep the name, but Phase 2 runs best-of across configured providers.
  return translateBestOf(text, sourceLang, targetLang);
}

async function translateBestOf(text, sourceLang, targetLang, options = {}) {
  const src = normalizeLang(sourceLang, 'gu');
  const dst = normalizeLang(targetLang, 'gu');

  const sourceText = String(text || '').trim();
  if (!sourceText) return { status: 'BLOCKED', reasons: ['EMPTY_SOURCE'] };

  const strictMode = Boolean(options.strictMode);
  const topics = Array.isArray(options.topicTags) ? options.topicTags : classifyTopics(sourceText);
  const strictByTopic = (options && typeof options.strictByTopic === 'boolean')
    ? Boolean(options.strictByTopic)
    : isStrictTopic(topics);
  const effectiveStrict = strictMode || strictByTopic;

  // 1) TM reuse (only if approved)
  const tm = await _lookupTranslationMemory({ sourceText, sourceLang: src, targetLang: dst });
  if (tm && tm.ok && tm.text && tm.text.trim()) {
    return {
      status: 'APPROVED',
      text: tm.text,
      engineUsed: 'TM',
      qualityScore: tm.qualityScore ?? 100,
      reasons: [],
      qa: { from: 'TM' },
      topicTags: topics,
    };
  }

  const providers = _selectProviders();
  if (providers.length === 0) {
    return { status: 'BLOCKED', reasons: ['NO_PROVIDER_CONFIG'], topicTags: topics, qa: null };
  }

  const terms = await loadGlossaryTerms();
  const glossaryLocked = _collectGlossaryLockedTerms(terms);

  // 2) Preprocess + glossary + entity locking
  const sourcePre = preprocess(sourceText);
  const preGloss = applyGlossary(sourcePre.text, src, dst, terms);

  const entities = extractEntities(preGloss);
  const locked = lockEntities(preGloss, glossaryLocked.concat(entities));

  // Translate with all providers in parallel
  const results = await Promise.all(providers.map(async (p) => {
    const r = await p.translate({ text: locked.text, sourceLang: src, targetLang: dst });
    if (!r || !r.ok) {
      return {
        ok: false,
        engine: p.name,
        reasons: (r && r.reasons) || ['PROVIDER_ERROR'],
        details: r && r.details ? r.details : null,
      };
    }

    const translatedPre = String(r.text || '');
    const checks = qaCheckExpanded({
      sourcePre,
      translatedPre,
      entityMap: locked.entities,
      strictMode: effectiveStrict,
      glossaryLockedTerms: [],
    });
    const score = scoreTranslationExpanded(checks, dst);

    return {
      ok: true,
      engine: p.name,
      translatedPre,
      checks,
      score,
    };
  }));

  const okCandidates = results.filter(r => r && r.ok);
  if (okCandidates.length === 0) {
    const reasons = Array.from(new Set(results.flatMap(r => (r && Array.isArray(r.reasons) ? r.reasons : ['PROVIDER_ERROR']))));
    return { status: 'BLOCKED', reasons, topicTags: topics, qa: null };
  }

  // Phase goals: never require multi-provider agreement.
  // If multiple providers are configured, we still pick the best candidate by score.

  // Choose best score
  okCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = okCandidates[0];

  // Post-process: glossary + restore entities + restore locks + style pack
  const postGloss = applyGlossary(best.translatedPre, src, dst, terms);
  const restoredEnt = restoreEntities(postGloss, locked.entities);
  const restored = restorePlaceholders(restoredEnt, sourcePre.locks);
  const styled = applyStylePack(restored, dst);

  // Final approval threshold
  const thresholdDefault = Number(process.env.TRANSLATE_APPROVAL_THRESHOLD || 85);
  const thresholdStrict = Number(process.env.TRANSLATE_APPROVAL_THRESHOLD_STRICT || 92);
  const envThreshold = effectiveStrict
    ? (Number.isFinite(thresholdStrict) ? thresholdStrict : 92)
    : (Number.isFinite(thresholdDefault) ? thresholdDefault : 85);

  const thresholdOverride = (options && typeof options.minApprovalScore === 'number' && Number.isFinite(options.minApprovalScore))
    ? options.minApprovalScore
    : null;
  const threshold = thresholdOverride !== null ? thresholdOverride : envThreshold;

  const approved = typeof best.score === 'number' && best.score >= threshold;
  if (!approved) {
    await _upsertTranslationMemory({
      sourceText,
      sourceLang: src,
      targetLang: dst,
      translatedText: styled,
      qualityScore: best.score || 0,
      approved: false,
      engineUsed: best.engine,
    });
    return {
      status: 'BLOCKED',
      reasons: ['LOW_QUALITY_SCORE'],
      qualityScore: best.score || 0,
      engineUsed: best.engine,
      topicTags: topics,
      qa: best.checks || null,
    };
  }

  await _upsertTranslationMemory({
    sourceText,
    sourceLang: src,
    targetLang: dst,
    translatedText: styled,
    qualityScore: best.score || 0,
    approved: true,
    engineUsed: best.engine,
  });

  return {
    status: 'APPROVED',
    text: styled,
    engineUsed: best.engine,
    qualityScore: best.score || 0,
    reasons: [],
    topicTags: topics,
    qa: best.checks || null,
  };
}

function qaCheck(sourcePreprocessed, translatedPreprocessed) {
  const sourceText = String(sourcePreprocessed && sourcePreprocessed.text ? sourcePreprocessed.text : '');
  const translatedText = String(translatedPreprocessed || '');
  const locks = Array.isArray(sourcePreprocessed && sourcePreprocessed.locks ? sourcePreprocessed.locks : [])
    ? sourcePreprocessed.locks
    : [];

  const checks = {
    nonEmpty: translatedText.trim().length > 0,
    placeholdersPreserved: true,
    missingPlaceholders: [],
    sourceTextLength: sourceText.length,
    translatedTextLength: translatedText.length,
  };

  for (const l of locks) {
    if (!l || !l.placeholder) continue;
    if (!translatedText.includes(String(l.placeholder))) {
      checks.placeholdersPreserved = false;
      checks.missingPlaceholders.push(String(l.placeholder));
    }
  }

  return checks;
}

function scoreTranslation(checks) {
  let score = 100;
  if (!checks || typeof checks !== 'object') return 0;
  if (!checks.nonEmpty) score -= 60;
  if (!checks.placeholdersPreserved) score -= 40;
  if (Array.isArray(checks.missingPlaceholders) && checks.missingPlaceholders.length > 0) {
    score -= Math.min(30, checks.missingPlaceholders.length * 10);
  }
  return Math.max(0, Math.min(100, Math.round(score)));
}

function shouldApprove(score) {
  const n = typeof score === 'number' ? score : Number(score);
  return Number.isFinite(n) && n >= 85;
}

async function generateTranslationsForBroadcastItem(itemId, options = {}) {
  if (!mongoose.connection || mongoose.connection.readyState !== 1) {
    return { ok: false, status: 'BLOCKED', reason: 'DB_UNAVAILABLE' };
  }

  const id = String(itemId || '').trim();
  if (!mongoose.isValidObjectId(id)) {
    return { ok: false, status: 'BLOCKED', reason: 'INVALID_ID' };
  }

  const item = await BroadcastItem.findById(id);
  if (!item) return { ok: false, status: 'BLOCKED', reason: 'NOT_FOUND' };

  const sourceLang = normalizeLang(item.sourceLang, 'gu');
  const sourceText = String(
    (item.textByLang && item.textByLang[sourceLang]) || item.text || ''
  ).trim();

  item.sourceLang = sourceLang;
  item.textByLang = item.textByLang && typeof item.textByLang === 'object' ? item.textByLang : {};
  item.statusByLang = item.statusByLang && typeof item.statusByLang === 'object' ? item.statusByLang : {};
  item.qualityByLang = item.qualityByLang && typeof item.qualityByLang === 'object' ? item.qualityByLang : {};

  if (sourceText) {
    item.text = sourceText;
    item.textByLang[sourceLang] = sourceText;
  }
  item.statusByLang[sourceLang] = 'APPROVED';
  item.qualityByLang[sourceLang] = 100;

  const requestedTargets = Array.isArray(options.targetLangs) ? options.targetLangs : null;
  const requestedSet = requestedTargets
    ? new Set(requestedTargets.map(l => normalizeLang(l)).filter(Boolean))
    : null;

  const targets = SUPPORTED_LANGS.filter(l => l !== sourceLang && (!requestedSet || requestedSet.has(l)));

  const perLang = {};

  // Mark targets as processing first.
  for (const lang of targets) {
    if (item.statusByLang[lang] === 'APPROVED' && item.textByLang[lang]) continue;
    item.statusByLang[lang] = 'PROCESSING';
  }
  await item.save();

  const terms = await loadGlossaryTerms();
  const sourcePre = preprocess(sourceText);

  for (const lang of targets) {
    // Skip if already approved.
    if (item.statusByLang[lang] === 'APPROVED' && item.textByLang[lang]) continue;

    const preGloss = applyGlossary(sourcePre.text, sourceLang, lang, terms);
    const translated = await translateBestOf(preGloss, sourceLang, lang, options);

    if (!translated || translated.status !== 'APPROVED' || typeof translated.text !== 'string') {
      item.statusByLang[lang] = 'BLOCKED';
      item.qualityByLang[lang] = (translated && typeof translated.qualityScore === 'number') ? translated.qualityScore : 0;
      try { delete item.textByLang[lang]; } catch (_) {}
      perLang[lang] = {
        status: 'BLOCKED',
        qualityScore: item.qualityByLang[lang],
        engineUsed: translated && translated.engineUsed ? String(translated.engineUsed) : undefined,
        reasons: translated && Array.isArray(translated.reasons) ? translated.reasons : ['BLOCKED'],
        qa: translated && translated.qa ? translated.qa : null,
      };
      continue;
    }

    item.qualityByLang[lang] = typeof translated.qualityScore === 'number' ? translated.qualityScore : 0;
    item.textByLang[lang] = String(translated.text || '').trim().slice(0, 160);
    item.statusByLang[lang] = 'APPROVED';
    perLang[lang] = {
      status: 'APPROVED',
      qualityScore: item.qualityByLang[lang],
      engineUsed: translated.engineUsed ? String(translated.engineUsed) : undefined,
      reasons: [],
      qa: translated.qa ? translated.qa : null,
    };
  }

  await item.save();
  return { ok: true, status: 'OK', id: String(item._id), sourceLang, perLang };
}

module.exports = {
  preprocess,
  applyGlossary,
  translateWithProvider,
  translateBestOf,
  qaCheck,
  scoreTranslation,
  shouldApprove,
  generateTranslationsForBroadcastItem,
  normalizeLang,
};
