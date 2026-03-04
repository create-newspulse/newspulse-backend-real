const googleTranslate = require('./googleTranslate.service');
const { chunkTextByParagraphs } = require('./newsI18n.service');
const { detectLangFromContent, translateHtmlStrict } = require('./articleTranslation.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(s) ? s : null;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _safeText(v) {
  return String(v ?? '').trim();
}

function isHtmlBody(content) {
  const s = String(content || '');
  if (!s.trim()) return false;
  return /[<][^>]+[>]/.test(s);
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

async function translateLongTextStrict({ text, sourceLang, targetLang, maxChunkChars = 4000 }) {
  const src = normalizeLang(sourceLang);
  const dst = normalizeLang(targetLang);
  const raw = _safeText(text);

  if (!raw) return { ok: true, text: '' };
  if (!dst) return { ok: false, error: 'Missing targetLang' };
  if (src && src === dst) return { ok: true, text: raw };

  const chunks = chunkTextByParagraphs(raw, maxChunkChars);
  if (!chunks.length) return { ok: true, text: '' };

  const res = await googleTranslate.translateMany(chunks, dst, { sourceLang: src || undefined });
  if (!res || res.ok !== true || !Array.isArray(res.items) || res.items.length !== chunks.length) {
    return { ok: false, error: res && res.error ? res.error : 'Translate failed' };
  }

  const joined = res.items.map(s => String(s || '').trim()).filter(Boolean).join('\n\n').trim();
  if (!joined) return { ok: false, error: 'Translate returned empty output' };
  return { ok: true, text: joined };
}

function getMissingFields(bucket) {
  const b = bucket && typeof bucket === 'object' ? bucket : {};
  const missing = [];
  if (!_isNonEmptyString(b.title)) missing.push('title');
  if (!_isNonEmptyString(b.summary)) missing.push('summary');
  if (!_isNonEmptyString(b.content)) missing.push('content');
  return missing;
}

function localizeNewsFromTranslations(docLike, requestedLang) {
  const desired = normalizeLang(requestedLang);
  const baseLang = normalizeLang(docLike?.lang || docLike?.language) || detectLangFromContent(docLike?.content) || 'en';
  if (!desired) return { out: docLike, resolvedLang: baseLang, translationPending: false };

  const t = docLike?.translations?.[desired];
  const hasAll = _isNonEmptyString(t?.title) && _isNonEmptyString(t?.summary) && _isNonEmptyString(t?.content);
  if (!hasAll) return { out: docLike, resolvedLang: baseLang, translationPending: desired !== baseLang };

  const out = { ...docLike, title: t.title, description: t.summary, content: t.content };
  return { out, resolvedLang: desired, translationPending: false };
}

/**
 * On-demand translation for News docs (public read paths).
 *
 * Rules:
 * - If translation is incomplete, do not mix languages in the response.
 * - Persist any successfully generated fields via $set (best-effort).
 */
async function ensureOnDemandNewsTranslation({ doc, requestedLang, logger }) {
  const log = logger || console;
  const desired = normalizeLang(requestedLang);

  const source =
    normalizeLang(doc?.originalLang) ||
    detectLangFromContent(doc?.content) ||
    normalizeLang(doc?.lang || doc?.language) ||
    'en';

  if (!desired) return { out: doc, resolvedLang: source, translationPending: false };

  if (desired === source) {
    return { out: doc, resolvedLang: desired, translationPending: false };
  }

  const existingBucket = doc?.translations?.[desired];
  const missing = getMissingFields(existingBucket);
  if (!missing.length) {
    return localizeNewsFromTranslations(doc, desired);
  }

  const dbSet = {};
  const bucketOut = {
    title: _safeText(existingBucket?.title),
    summary: _safeText(existingBucket?.summary),
    content: _safeText(existingBucket?.content),
  };

  try {
    if (missing.includes('title')) {
      const t = await translateTextStrict({ text: doc?.title, sourceLang: source, targetLang: desired });
      if (t.ok && _isNonEmptyString(t.text)) {
        bucketOut.title = t.text;
        dbSet[`translations.${desired}.title`] = t.text;
      } else {
        try {
          log.warn?.('[i18n][news] title translation failed', {
            id: String(doc?._id || ''),
            slug: String(doc?.slug || ''),
            from: source,
            to: desired,
            error: t && t.ok === false ? t.error : 'empty_output',
          });
        } catch (_) {}
      }
    }

    if (missing.includes('summary')) {
      const s = await translateTextStrict({ text: doc?.description || doc?.summary, sourceLang: source, targetLang: desired });
      if (s.ok && _isNonEmptyString(s.text)) {
        bucketOut.summary = s.text;
        dbSet[`translations.${desired}.summary`] = s.text;
      } else {
        try {
          log.warn?.('[i18n][news] summary translation failed', {
            id: String(doc?._id || ''),
            slug: String(doc?.slug || ''),
            from: source,
            to: desired,
            error: s && s.ok === false ? s.error : 'empty_output',
          });
        } catch (_) {}
      }
    }

    if (missing.includes('content')) {
      const rawBody = String(doc?.content || doc?.body || '');
      if (isHtmlBody(rawBody)) {
        const c = await translateHtmlStrict({ html: rawBody, sourceLang: source, targetLang: desired });
        if (c.ok && _isNonEmptyString(c.html)) {
          bucketOut.content = c.html;
          dbSet[`translations.${desired}.content`] = c.html;
        } else {
          try {
            log.warn?.('[i18n][news] content translation failed', {
              id: String(doc?._id || ''),
              slug: String(doc?.slug || ''),
              from: source,
              to: desired,
              error: c && c.ok === false ? c.error : 'empty_output',
            });
          } catch (_) {}
        }
      } else {
        const c = await translateLongTextStrict({ text: rawBody, sourceLang: source, targetLang: desired });
        if (c.ok && _isNonEmptyString(c.text)) {
          bucketOut.content = c.text;
          dbSet[`translations.${desired}.content`] = c.text;
        } else {
          try {
            log.warn?.('[i18n][news] content translation failed', {
              id: String(doc?._id || ''),
              slug: String(doc?.slug || ''),
              from: source,
              to: desired,
              error: c && c.ok === false ? c.error : 'empty_output',
            });
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    try {
      log.warn?.('[i18n][news] on-demand translation threw', {
        id: String(doc?._id || ''),
        slug: String(doc?.slug || ''),
        from: source,
        to: desired,
        missing,
        message: e?.message || String(e),
      });
    } catch (_) {}
  }

  const hasAllTranslated = _isNonEmptyString(bucketOut.title) && _isNonEmptyString(bucketOut.summary) && _isNonEmptyString(bucketOut.content);

  if (hasAllTranslated) {
    const out = { ...doc, title: bucketOut.title, description: bucketOut.summary, content: bucketOut.content };
    return {
      out,
      resolvedLang: desired,
      translationPending: false,
      ...(Object.keys(dbSet).length ? { dbSet } : {}),
    };
  }

  // Strict: never mix languages at field-level.
  return {
    out: doc,
    resolvedLang: source,
    translationPending: desired !== source,
    ...(Object.keys(dbSet).length ? { dbSet } : {}),
  };
}

module.exports = {
  normalizeLang,
  localizeNewsFromTranslations,
  ensureOnDemandNewsTranslation,
};
