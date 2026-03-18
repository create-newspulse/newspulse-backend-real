const crypto = require('crypto');
const mongoose = require('mongoose');

const { translate: googleTranslate } = require('./googleTranslate');

let TranslationCache = null;
try { TranslationCache = require('../../models/TranslationCache'); } catch (_) {}

let TermLock = null;
try { TermLock = require('../../models/TermLock'); } catch (_) {}

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function normalizeLang(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  // Native script hints
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj') return 'gu';

  return null;
}

function boolFromEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function numberFromEnv(name, defaultValue) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : defaultValue;
}

function sha256(input) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function buildCacheKey({ sourceText, sourceLang, targetLang, context }) {
  const payload = `${sourceLang}|${targetLang}|${String(context || '')}|${sourceText}`;
  return sha256(payload);
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function looksLikeTargetLang(text, targetLang) {
  const s = String(text || '');
  if (!s.trim()) return 0;

  const totalLetters = (s.match(/[A-Za-z\u0900-\u097F\u0A80-\u0AFF]/g) || []).length;
  if (!totalLetters) return targetLang === 'en' ? 0 : 0;

  if (targetLang === 'hi') {
    const devanagari = (s.match(/[\u0900-\u097F]/g) || []).length;
    return devanagari / totalLetters;
  }
  if (targetLang === 'gu') {
    const gujarati = (s.match(/[\u0A80-\u0AFF]/g) || []).length;
    return gujarati / totalLetters;
  }
  // en
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  return latin / totalLetters;
}

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\u0A80-\u0AFF\s]+/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function jaccardSimilarity(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function protectWithPlaceholders(text, items, prefix) {
  let out = String(text || '');
  const map = new Map();
  let i = 0;

  for (const item of items) {
    const value = item && item.value ? String(item.value) : '';
    if (!value) continue;
    const token = `__${prefix}_${i}__`;
    i++;
    map.set(token, value);
    out = out.split(value).join(token);
  }

  return { text: out, map };
}

function protectByRegex(text, regex, prefix) {
  const s = String(text || '');
  const map = new Map();
  let i = 0;
  const out = s.replace(regex, (m) => {
    const token = `__${prefix}_${i}__`;
    i++;
    map.set(token, m);
    return token;
  });
  return { text: out, map };
}

function mergeMaps(...maps) {
  const merged = new Map();
  for (const m of maps) {
    if (!m) continue;
    for (const [k, v] of m.entries()) merged.set(k, v);
  }
  return merged;
}

function restorePlaceholders(text, map) {
  let out = String(text || '');
  for (const [token, value] of (map || new Map()).entries()) {
    out = out.split(token).join(value);
  }
  return out;
}

function normalizeDigitsToAscii(s) {
  const str = String(s || '');
  const map = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
    '૦': '0', '૧': '1', '૨': '2', '૩': '3', '૪': '4', '૫': '5', '૬': '6', '૭': '7', '૮': '8', '૯': '9',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };
  return str.replace(/[०-९૦-૯٠-٩۰-۹]/g, (ch) => map[ch] || ch);
}

function restoreNumericTokensFuzzy(text, placeholderMap) {
  // Fix common token-mangling cases for numeric placeholders.
  // NOTE: Numeric masking is intentionally avoided (prefer no masking).
  // This remains as a last-resort safety net for legacy/provider artifacts.
  let out = String(text || '');
  out = out.replace(/__NUM(?:_[A-Z]+)*_(\d+)__/g, (m, idx) => {
    const key = `__NUM_${idx}__`;
    const v = placeholderMap && typeof placeholderMap.get === 'function' ? placeholderMap.get(key) : null;
    return (typeof v === 'string' && v.length) ? v : m;
  });

  out = out.replace(/\bNUM(?:_[A-Z]+)*_(\d+)__/g, (m, idx) => {
    const key = `__NUM_${idx}__`;
    const v = placeholderMap && typeof placeholderMap.get === 'function' ? placeholderMap.get(key) : null;
    return (typeof v === 'string' && v.length) ? v : m;
  });

  // Final safety: strip any remaining NUM tokens.
  out = out.replace(/__NUM(?:_[A-Z]+)*(?:_\d+)?__/g, '');
  out = out.replace(/\bNUM(?:_[A-Z]+)*(?:_\d+)?__/g, '');
  out = out.replace(/__NUM\s*(?=\d)/g, '');
  return out;
}

function stripLeakedNumTokens(text) {
  return String(text || '')
    .replace(/__NUM(?:_[A-Z]+)*(?:_\d+)?__/gi, '')
    .replace(/\bNUM(?:_[A-Z]+)*(?:_\d+)?__/gi, '')
    .replace(/__NUM\s*(?=\d)/gi, '');
}

function normalizeSpaces(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

async function loadEnabledTermLocks() {
  if (!isDbReady() || !TermLock) return [];
  try {
    const docs = await TermLock.find({ enabled: true }).select('term keepAs mode').lean();
    return Array.isArray(docs) ? docs : [];
  } catch (_) {
    return [];
  }
}

async function readCache(key) {
  const cacheEnabled = boolFromEnv('TRANSLATION_CACHE_ENABLED', true);
  if (!cacheEnabled) return null;
  if (!isDbReady() || !TranslationCache) return null;

  try {
    const doc = await TranslationCache.findOne({ key }).lean();
    if (!doc) return null;

    // best-effort hit increment
    TranslationCache.updateOne({ key }, { $inc: { hits: 1 }, $set: { updatedAt: new Date() } }).catch(() => {});
    return doc;
  } catch (_) {
    return null;
  }
}

async function writeCache(payload) {
  const cacheEnabled = boolFromEnv('TRANSLATION_CACHE_ENABLED', true);
  if (!cacheEnabled) return;
  if (!isDbReady() || !TranslationCache) return;

  try {
    await TranslationCache.updateOne(
      { key: payload.key },
      {
        $set: {
          sourceText: payload.sourceText,
          sourceLang: payload.sourceLang,
          targetLang: payload.targetLang,
          translatedText: payload.translatedText,
          score: payload.score,
          warnings: payload.warnings || [],
          provider: 'GOOGLE',
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date(), hits: 0 },
      },
      { upsert: true }
    );
  } catch (_) {
    // ignore cache failures
  }
}

function computeLengthRatio(a, b) {
  const aLen = String(a || '').replace(/\s+/g, '').length;
  const bLen = String(b || '').replace(/\s+/g, '').length;
  if (!aLen && !bLen) return 1;
  if (!aLen || !bLen) return 0;
  const ratio = bLen / aLen;
  if (ratio >= 0.5 && ratio <= 2.2) return 1;
  if (ratio >= 0.35 && ratio <= 3.0) return 0.5;
  return 0;
}

function numbersIn(text) {
  return (String(text || '').match(/\d+(?:[.,]\d+)*/g) || []).join('|');
}

function computeScore({ sourceText, translatedText, targetLang, placeholderMap, backTranslatedText }) {
  const warnings = [];

  // Placeholder integrity: after restoration, the VALUES must be present.
  // (Tokens themselves should not appear in restored text.)
  const placeholderValues = [...(placeholderMap || new Map()).values()].filter(Boolean);
  const valuesMissing = placeholderValues.filter(v => !String(translatedText || '').includes(String(v)));
  const placeholderOk = valuesMissing.length === 0 ? 1 : 0;
  if (!placeholderOk) warnings.push('placeholders_missing');

  const scriptRatio = looksLikeTargetLang(translatedText, targetLang);
  const scriptOk = targetLang === 'en' ? (scriptRatio >= 0.4 ? 1 : 0.3) : (scriptRatio >= 0.15 ? 1 : 0);
  if (scriptOk < 1) warnings.push('script_mismatch');

  const srcNums = numbersIn(sourceText);
  const dstNums = numbersIn(translatedText);
  const numbersOk = srcNums === dstNums ? 1 : 0;
  if (!numbersOk) warnings.push('numbers_changed');

  const lenOk = computeLengthRatio(sourceText, translatedText);
  if (lenOk < 1) warnings.push('length_ratio');

  let backScore = null;
  if (typeof backTranslatedText === 'string') {
    const sim = jaccardSimilarity(tokenize(sourceText), tokenize(backTranslatedText));
    backScore = sim;
    if (sim < 0.35) warnings.push('backtranslation_low_similarity');
  }

  // Weighted average; if backScore is absent, redistribute weights.
  const weights = {
    placeholderOk: 0.2,
    scriptOk: 0.25,
    numbersOk: 0.2,
    lenOk: 0.15,
    backScore: 0.2,
  };

  const parts = [
    { v: placeholderOk, w: weights.placeholderOk },
    { v: scriptOk, w: weights.scriptOk },
    { v: numbersOk, w: weights.numbersOk },
    { v: lenOk, w: weights.lenOk },
  ];

  if (backScore !== null) parts.push({ v: backScore, w: weights.backScore });

  const totalW = parts.reduce((acc, p) => acc + p.w, 0) || 1;
  const score = parts.reduce((acc, p) => acc + (p.v * p.w), 0) / totalW;

  return { score: Math.max(0, Math.min(1, score)), warnings };
}

async function safeTranslateText({ text, sourceLang, targetLang, context, strict = false }) {
  const source = normalizeLang(sourceLang);
  const target = normalizeLang(targetLang);
  const original = String(text || '');

  if (!original.trim()) {
    return { text: original, usedFallback: true, score: 1, warnings: ['empty'], provider: null, fromCache: false };
  }
  if (!source || !target) {
    return { text: original, usedFallback: true, score: 0, warnings: ['invalid_lang'], provider: null, fromCache: false };
  }
  if (source === target) {
    return { text: original, usedFallback: true, score: 1, warnings: [], provider: null, fromCache: false };
  }

  const safeMode = boolFromEnv('TRANSLATION_SAFE_MODE', true);
  const minScore = numberFromEnv('TRANSLATION_MIN_SCORE', 0.85);
  const strictMinScore = numberFromEnv('TRANSLATION_STRICT_MIN_SCORE', 0.92);
  const threshold = strict ? strictMinScore : minScore;

  const cacheKey = buildCacheKey({ sourceText: original, sourceLang: source, targetLang: target, context });
  const cached = await readCache(cacheKey);
  if (cached && typeof cached.translatedText === 'string' && cached.translatedText.trim()) {
    return {
      text: cached.translatedText,
      usedFallback: false,
      score: typeof cached.score === 'number' ? cached.score : 1,
      warnings: cached.warnings || [],
      provider: cached.provider || 'GOOGLE',
      fromCache: true,
    };
  }

  const termLocks = await loadEnabledTermLocks();
  const locks = [];
  for (const doc of termLocks) {
    const term = String(doc.term || '').trim();
    if (!term) continue;
    const mode = doc.mode || 'LOCK';
    const keepAs = doc.keepAs || {};
    const replacement = (mode === 'REPLACE' && keepAs && keepAs[target]) ? String(keepAs[target] || '').trim() : '';

    locks.push({
      search: term,
      restore: replacement || term,
    });
  }

  // Protect URLs and emails (never translate)
  const urlRx = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
  const emailRx = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const { text: t0, map: urlMap } = protectByRegex(original, urlRx, 'URL');
  const { text: t1, map: emailMap } = protectByRegex(t0, emailRx, 'EMAIL');

  // Prefer no numeric masking. Digits are normalized after translation.
  const t2 = t1;

  // Protect locked terms (best-effort; avoid huge regexes)
  let t3 = t2;
  const lockMap = new Map();
  let lockIdx = 0;
  for (const l of locks) {
    const search = String(l.search || '').trim();
    const restoreValue = String(l.restore || '').trim();
    if (!search || !restoreValue) continue;
    const token = `__LOCK_${lockIdx}__`;
    lockIdx++;
    lockMap.set(token, restoreValue);

    // Word boundary only for latin-ish terms; otherwise simple replace.
    if (/^[A-Za-z0-9\-_.]{2,}$/.test(search)) {
      const rx = new RegExp(`\\b${escapeRegExp(search)}\\b`, 'g');
      t3 = t3.replace(rx, token);
    } else {
      t3 = t3.split(search).join(token);
    }
  }

  const placeholderMap = mergeMaps(urlMap, emailMap, lockMap);

  const rawTranslated = await googleTranslate(t3, source, target);
  if (!rawTranslated) {
    const warnings = ['provider_failed'];
    if (safeMode) {
      return { text: original, usedFallback: true, score: 0, warnings, provider: 'GOOGLE', fromCache: false };
    }
    return { text: original, usedFallback: true, score: 0, warnings, provider: 'GOOGLE', fromCache: false };
  }

  const restored = normalizeSpaces(restorePlaceholders(rawTranslated, placeholderMap));
  const restoredSafe = normalizeDigitsToAscii(stripLeakedNumTokens(restored));
  const placeholderTokens = [...placeholderMap.keys()];
  const placeholdersMissing = placeholderTokens.filter(t => restoredSafe.includes(t));
  if (placeholdersMissing.length) {
    const warnings = ['placeholder_restore_failed'];
    if (safeMode) {
      return { text: original, usedFallback: true, score: 0, warnings, provider: 'GOOGLE', fromCache: false };
    }
  }

  // Back-translation check (avoid doubling calls for very long bodies)
  let backTranslated = null;
  if (restoredSafe.length <= 400 || strict) {
    backTranslated = await googleTranslate(restoredSafe, target, source);
  }

  const { score, warnings } = computeScore({
    sourceText: original,
    translatedText: restoredSafe,
    targetLang: target,
    placeholderMap: placeholderMap,
    backTranslatedText: backTranslated,
  });

  const accepted = score >= threshold;
  const finalText = accepted ? restoredSafe : original;

  if (!accepted) warnings.push('below_threshold');

  if (!accepted && safeMode) {
    return { text: original, usedFallback: true, score, warnings, provider: 'GOOGLE', fromCache: false };
  }

  // Cache accepted translations only.
  if (accepted) {
    await writeCache({
      key: cacheKey,
      sourceText: original,
      sourceLang: source,
      targetLang: target,
      translatedText: restoredSafe,
      score,
      warnings,
    });
  }

  return { text: finalText, usedFallback: !accepted, score, warnings, provider: 'GOOGLE', fromCache: false };
}

module.exports = {
  safeTranslateText,
  normalizeLang,
};
