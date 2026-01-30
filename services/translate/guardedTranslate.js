const { translate } = require('./googleTranslate');
const {
  applyProtectedTermsPre,
  applyProtectedTermsPost,
  enforceProtectedTermsPostFix,
  getAbbreviationsList,
} = require('./protectedTerms');
const { diceCoefficientWords } = require('./translationQa');

const SUPPORTED = new Set(['en', 'hi', 'gu']);

function _normalizeLang(v) {
  const s = String(v || '').trim().toLowerCase();
  return SUPPORTED.has(s) ? s : null;
}

function _decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function _normalizeDigitsToAscii(s) {
  const str = String(s || '');
  const map = {
    '०': '0', '१': '1', '२': '2', '३': '3', '४': '4', '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
    '૦': '0', '૧': '1', '૨': '2', '૩': '3', '૪': '4', '૫': '5', '૬': '6', '૭': '7', '૮': '8', '૯': '9',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };
  return str.replace(/[०-९૦-૯٠-٩۰-۹]/g, (ch) => map[ch] || ch);
}

function _protectByRegex(text, regex, prefix) {
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

function _restore(text, map) {
  let out = String(text || '');
  for (const [token, value] of (map || new Map()).entries()) {
    out = out.split(token).join(value);
  }
  return out;
}

function _restoreNumericTokensFuzzy(text, numMap) {
  let out = String(text || '');
  out = _restore(out, numMap);

  out = out.replace(/__NUM(?:_[A-Z]+)*_(\d+)__/g, (m, idx) => {
    const key = `__NUM_${idx}__`;
    const v = numMap && typeof numMap.get === 'function' ? numMap.get(key) : null;
    return (typeof v === 'string' && v.length) ? v : m;
  });

  out = out.replace(/\bNUM(?:_[A-Z]+)*_(\d+)__/g, (m, idx) => {
    const key = `__NUM_${idx}__`;
    const v = numMap && typeof numMap.get === 'function' ? numMap.get(key) : null;
    return (typeof v === 'string' && v.length) ? v : m;
  });

  out = out.replace(/__NUM(?:_[A-Z]+)*(?:_\d+)?__/g, '');
  out = out.replace(/\bNUM(?:_[A-Z]+)*(?:_\d+)?__/g, '');
  out = out.replace(/__NUM\s*(?=\d)/g, '');
  return out;
}

function _fixPunctuationSpacing(s) {
  let out = String(s || '');
  out = out.replace(/\s+([,.;:!?])/g, '$1');
  out = out.replace(/\s+([।])/g, '$1');
  out = out.replace(/([,.;:!?])(\S)/g, '$1 $2');
  out = out.replace(/([।])(\S)/g, '$1 $2');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function _cleanupHindi(s) {
  let out = String(s || '').normalize('NFC');
  // Remove duplicate halants and stray ZWJ/ZWNJ.
  out = out.replace(/्{2,}/g, '्');
  out = out.replace(/[\u200c\u200d]/g, '');
  // Common punctuation spacing
  out = _fixPunctuationSpacing(out);
  return out;
}

function _cleanupGujarati(s) {
  let out = String(s || '').normalize('NFC');
  out = out.replace(/[\u200c\u200d]/g, '');
  out = _fixPunctuationSpacing(out);
  return out;
}

function _splitSegments(s) {
  const t = String(s || '').trim();
  if (!t) return [];

  // Split on sentence-ish boundaries first, keep simple.
  const parts = t
    .split(/(?<=[.!?।])\s+|\n+/g)
    .map(x => x.trim())
    .filter(Boolean);

  // If still one huge chunk, split by commas.
  if (parts.length <= 1 && t.length > 120) {
    return t
      .split(/,\s+/g)
      .map(x => x.trim())
      .filter(Boolean);
  }

  return parts;
}

async function _translateSegments(segments, source, target) {
  // googleTranslate.translate currently supports only a single string.
  // We'll translate one-by-one to keep behavior deterministic.
  const out = [];
  for (const seg of segments) {
    const t = await translate(seg, source, target);
    out.push(typeof t === 'string' ? t : null);
  }
  if (out.some(x => x == null)) return null;
  return out.join(' ');
}

function _needsReviewThreshold() {
  const raw = Number(process.env.TRANSLATION_BACKCHECK_MIN || 0.62);
  return Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.62;
}

async function translateWithGuardrails(text, sourceLang, targetLang, options = {}) {
  const source = _normalizeLang(sourceLang);
  const target = _normalizeLang(targetLang);
  const raw = String(text || '').trim();

  if (!raw) return { ok: false, text: null, needsReview: false, score: 0 };
  if (!source || !target) return { ok: false, text: null, needsReview: false, score: 0 };
  if (source === target) return { ok: true, text: raw, needsReview: false, score: 1 };

  const hasKey = Boolean(String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim());
  if (!hasKey) {
    // No blocking: return source-only; caller can choose fallback.
    return { ok: false, text: null, needsReview: false, score: 0, reason: 'NO_GOOGLE_KEY' };
  }

  // Protected terms (pre)
  const { text: withPT, tokenMap } = applyProtectedTermsPre(raw);

  // Preserve URLs/emails/numbers + uppercase abbreviations + configured abbreviations list.
  const urlRx = /\b(?:https?:\/\/|www\.)[^\s]+/gi;
  const emailRx = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  const numericRx = /(?:₹|\$|€|£)?\d+(?:,\d{3})*(?:\.\d+)?%?|\b\d+(?:\.\d+)?%\b|\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b|\b\d{4}[\/-]\d{1,2}[\/-]\d{1,2}\b/g;
  const allCapsRx = /\b[A-Z]{2,}\b/g;

  let t0 = withPT;
  const { text: t1, map: urlMap } = _protectByRegex(t0, urlRx, 'URL');
  const { text: t2, map: emailMap } = _protectByRegex(t1, emailRx, 'EMAIL');
  const { text: t3, map: numMap } = _protectByRegex(t2, numericRx, 'NUM');
  const { text: t4, map: capsMap } = _protectByRegex(t3, allCapsRx, 'CAPS');

  // Protect configured abbreviations as exact tokens as well.
  let q = t4;
  const abbr = getAbbreviationsList();
  const abbrMap = new Map();
  if (abbr.length) {
    // Longest-first.
    const sorted = abbr.slice().sort((a, b) => b.length - a.length);
    let i = 0;
    for (const a of sorted) {
      const src = String(a || '').trim();
      if (!src) continue;
      const rx = new RegExp(`\\b${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      if (!rx.test(q)) continue;
      rx.lastIndex = 0;
      const token = `__ABBR_${i}__`;
      i++;
      q = q.replace(rx, token);
      abbrMap.set(token, src);
    }
  }

  const doPost = (translated) => {
    let out = _decodeBasicEntities(translated);
    out = _restoreNumericTokensFuzzy(out, numMap);
    out = _restore(_restore(_restore(out, emailMap), urlMap), capsMap);
    for (const [token, value] of abbrMap.entries()) {
      out = out.split(token).join(value);
    }
    out = applyProtectedTermsPost(out, tokenMap, target);
    out = enforceProtectedTermsPostFix(out, target);
    out = _fixPunctuationSpacing(out);

    out = _normalizeDigitsToAscii(out);

    if (target === 'hi') out = _cleanupHindi(out);
    if (target === 'gu') out = _cleanupGujarati(out);

    return out.trim();
  };

  const attempt1 = await translate(q, source, target);
  let best = typeof attempt1 === 'string' ? doPost(attempt1) : null;

  // Back-translation QA (hi->en / gu->en)
  const threshold = typeof options.minSimilarity === 'number' ? options.minSimilarity : _needsReviewThreshold();
  let score = 0;
  let needsReview = false;

  const runBackcheck = async (candidate) => {
    if (!candidate) return { score: 0, back: null };
    const back = await translate(candidate, target, 'en');
    if (typeof back !== 'string' || !back.trim()) return { score: 0, back: null };
    const s = diceCoefficientWords(raw, back);
    return { score: s, back };
  };

  if (best) {
    const r1 = await runBackcheck(best);
    score = r1.score;
    needsReview = score < threshold;
  }

  // Retry strategy: segment translation if score too low.
  if ((!best || needsReview) && (options.retry !== false)) {
    const segments = _splitSegments(q);
    if (segments.length > 1) {
      const attempt2Raw = await _translateSegments(segments, source, target);
      const attempt2 = typeof attempt2Raw === 'string' ? doPost(attempt2Raw) : null;
      if (attempt2) {
        const r2 = await runBackcheck(attempt2);
        if (r2.score >= score) {
          best = attempt2;
          score = r2.score;
          needsReview = score < threshold;
        }
      }
    }
  }

  if (!best) return { ok: false, text: null, needsReview: false, score: 0 };

  // Clip to broadcast item max length if requested.
  const maxLen = typeof options.maxLen === 'number' ? options.maxLen : null;
  const finalText = maxLen ? best.slice(0, maxLen) : best;

  return { ok: true, text: finalText, needsReview, score };
}

module.exports = {
  translateWithGuardrails,
};
