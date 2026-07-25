const googleTranslate = require('./googleTranslate.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  const lettersOnly = s0.replace(/[^a-z]/g, '');
  if (SUPPORTED_LANGS.includes(s)) return s;
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj' || lettersOnly === 'gj') return 'gu';
  return null;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _safeText(v) {
  return String(v ?? '').trim();
}

function chunkTextByParagraphs(text, maxChunkChars = 3500) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const paras = raw
    .split(/\n\s*\n+/g)
    .map(p => p.trim())
    .filter(Boolean);

  if (!paras.length) return [];

  const out = [];
  let buf = '';
  for (const p of paras) {
    const candidate = buf ? `${buf}\n\n${p}` : p;
    if (candidate.length <= maxChunkChars) {
      buf = candidate;
      continue;
    }

    if (buf) out.push(buf);

    // If a single paragraph is too big, hard-split it.
    if (p.length > maxChunkChars) {
      for (let i = 0; i < p.length; i += maxChunkChars) {
        out.push(p.slice(i, i + maxChunkChars));
      }
      buf = '';
    } else {
      buf = p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function translateTextStrict({ text, sourceLang, targetLang }) {
  const src = normalizeLang(sourceLang);
  const dst = normalizeLang(targetLang);
  const raw = _safeText(text);

  if (!raw) return { ok: true, text: '' };
  if (!dst) return { ok: false, error: 'Missing targetLang' };
  if (src && src === dst) return { ok: true, text: raw };

  const res = await googleTranslate.translateMany([raw], dst, { sourceLang: src || undefined });
  if (!res || res.ok !== true || !Array.isArray(res.items)) {
    return { ok: false, error: res && res.error ? res.error : 'Translate failed' };
  }
  const out = res.items[0] ? String(res.items[0]).trim() : '';
  if (!out) return { ok: false, error: 'Translate returned empty output' };
  return { ok: true, text: out };
}

async function translateLongTextStrict({ text, sourceLang, targetLang }) {
  const src = normalizeLang(sourceLang);
  const dst = normalizeLang(targetLang);
  const raw = _safeText(text);

  if (!raw) return { ok: true, text: '' };
  if (!dst) return { ok: false, error: 'Missing targetLang' };
  if (src && src === dst) return { ok: true, text: raw };

  const chunks = chunkTextByParagraphs(raw);
  if (!chunks.length) return { ok: true, text: '' };

  const res = await googleTranslate.translateMany(chunks, dst, { sourceLang: src || undefined });
  if (!res || res.ok !== true || !Array.isArray(res.items) || res.items.length !== chunks.length) {
    return { ok: false, error: res && res.error ? res.error : 'Translate failed' };
  }

  const joined = res.items.map(s => String(s || '').trim()).filter(Boolean).join('\n\n').trim();
  if (!joined) return { ok: false, error: 'Translate returned empty output' };
  return { ok: true, text: joined };
}

function ensureBaseTranslationBucket(newsDoc) {
  const baseLang = normalizeLang(newsDoc?.lang) || normalizeLang(newsDoc?.language) || 'en';

  if (!newsDoc.translations || typeof newsDoc.translations !== 'object') {
    newsDoc.translations = {};
  }
  if (!newsDoc.translations[baseLang] || typeof newsDoc.translations[baseLang] !== 'object') {
    newsDoc.translations[baseLang] = { title: '', summary: '', content: '' };
  }

  newsDoc.translations[baseLang].title = _safeText(newsDoc.title);
  newsDoc.translations[baseLang].summary = _safeText(newsDoc.description);
  newsDoc.translations[baseLang].content = _safeText(newsDoc.content);

  return baseLang;
}

function getMissingTranslationFields(translations, lang) {
  const bucket = translations && translations[lang] ? translations[lang] : null;
  const missing = [];
  if (!_isNonEmptyString(bucket?.title)) missing.push('title');
  if (!_isNonEmptyString(bucket?.summary)) missing.push('summary');
  if (!_isNonEmptyString(bucket?.content)) missing.push('content');
  return missing;
}

async function ensureNewsHasFullTranslations(newsDoc, options = {}) {
  const logger = options.logger || console;
  const baseLang = ensureBaseTranslationBucket(newsDoc);

  const translations = newsDoc.translations || {};

  // Enforce: do not allow title-only translations; content must exist.
  for (const lang of SUPPORTED_LANGS) {
    if (!translations[lang] || typeof translations[lang] !== 'object') {
      translations[lang] = { title: '', summary: '', content: '' };
    }
  }

  // Fill missing translations.
  for (const dst of SUPPORTED_LANGS) {
    if (dst === baseLang) continue;

    const missing = getMissingTranslationFields(translations, dst);
    if (!missing.length) continue;

    try {
      logger.info?.('[i18n] translating for publish', {
        id: String(newsDoc._id || ''),
        slug: String(newsDoc.slug || ''),
        category: String(newsDoc.category || ''),
        from: baseLang,
        to: dst,
        missing,
      });
    } catch (_) {}

    if (missing.includes('title')) {
      const t = await translateTextStrict({ text: newsDoc.title, sourceLang: baseLang, targetLang: dst });
      if (!t.ok) return { ok: false, error: `Title translation failed (${baseLang}->${dst}): ${t.error || 'translate_failed'}` };
      translations[dst].title = t.text;
    }

    if (missing.includes('summary')) {
      const s = await translateTextStrict({ text: newsDoc.description, sourceLang: baseLang, targetLang: dst });
      if (!s.ok) return { ok: false, error: `Summary translation failed (${baseLang}->${dst}): ${s.error || 'translate_failed'}` };
      translations[dst].summary = s.text;
    }

    if (missing.includes('content')) {
      const c = await translateLongTextStrict({ text: newsDoc.content, sourceLang: baseLang, targetLang: dst });
      if (!c.ok) return { ok: false, error: `Content translation failed (${baseLang}->${dst}): ${c.error || 'translate_failed'}` };
      translations[dst].content = c.text;
    }
  }

  // Final strict validation: all languages must have content.
  const missingContentLangs = SUPPORTED_LANGS.filter((l) => !_isNonEmptyString(translations?.[l]?.content));
  if (missingContentLangs.length) {
    return { ok: false, error: `Publish blocked: missing content translations for ${missingContentLangs.join(', ')}` };
  }

  newsDoc.translations = translations;
  try {
    if (typeof newsDoc.markModified === 'function') newsDoc.markModified('translations');
  } catch (_) {}
  return { ok: true, baseLang };
}

function localizeFromNewsTranslations(docLike, requestedLang) {
  const desired = normalizeLang(requestedLang);
  const baseLang = normalizeLang(docLike?.lang) || normalizeLang(docLike?.language) || 'en';
  if (!desired) return { out: docLike, resolvedLang: baseLang, translationPending: false };

  const t = docLike?.translations?.[desired];
  const hasAll = _isNonEmptyString(t?.title) && _isNonEmptyString(t?.summary) && _isNonEmptyString(t?.content);

  if (hasAll) {
    const out = { ...docLike, title: t.title, description: t.summary, content: t.content };
    return { out, resolvedLang: desired, translationPending: false };
  }

  // Strict: if any field missing, do not mix; fall back to base language.
  return { out: docLike, resolvedLang: baseLang, translationPending: desired !== baseLang };
}

function localizeFromArticleI18n(docLike, requestedLang) {
  const desired = normalizeLang(requestedLang);
  const baseLang = normalizeLang(docLike?.language) || 'en';
  if (!desired) return { out: docLike, resolvedLang: baseLang, translationPending: false };

  const t = docLike?.i18n;
  const title = t?.title?.[desired];
  const summary = t?.summary?.[desired];
  const content = t?.content?.[desired];

  const hasAll = _isNonEmptyString(title) && _isNonEmptyString(summary) && _isNonEmptyString(content);
  if (hasAll) {
    const out = { ...docLike, title, summary, content };
    return { out, resolvedLang: desired, translationPending: false };
  }

  return { out: docLike, resolvedLang: baseLang, translationPending: desired !== baseLang };
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  chunkTextByParagraphs,
  ensureNewsHasFullTranslations,
  localizeFromNewsTranslations,
  localizeFromArticleI18n,
};
