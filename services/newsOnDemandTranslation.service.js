const googleTranslate = require('./googleTranslate.service');
const { chunkTextByParagraphs } = require('./newsI18n.service');
const { detectLangFromContent, translateHtmlStrict } = require('./articleTranslation.service');
const { isGoogleTranslateConfigured } = require('./translationEnabled');

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

function _isRateLimitErrorMessage(msg) {
  return /(rate\s*limit\s*exceeded|too\s*many\s*requests|resource\s*exhausted|http[_\s-]*429|\b429\b)/i.test(String(msg || ''));
}

function _addMinutes(d, minutes) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + (minutes * 60 * 1000));
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
async function ensureOnDemandNewsTranslation({ doc, requestedLang, logger, lockOwner = false, now = new Date() }) {
  const log = logger || console;
  // NOTE: Public news endpoints can be hit at high QPS.
  // Callers should pass lockOwner=true only after acquiring an atomic DB lock.
  const nowDt = now instanceof Date ? now : new Date(now);
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

  // Translation disabled/misconfigured: serve cached full translations if present; otherwise originals.
  if (!isGoogleTranslateConfigured()) {
    const cached = localizeNewsFromTranslations(doc, desired);
    if (cached && cached.resolvedLang === desired && cached.translationPending === false) return cached;
    return { out: doc, resolvedLang: source, translationPending: false };
  }

  // Without lock ownership, never attempt translation (prevents stampede).
  if (!lockOwner) {
    const status = doc?.translationStatus?.[desired] || null;
    const retryAtRaw = doc?.translationNextRetryAt?.[desired] || null;
    const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;

    if (status === 'pending') {
      return { out: doc, resolvedLang: source, translationPending: true };
    }

    if (status === 'failed' && retryAt && nowDt < retryAt) {
      return { out: doc, resolvedLang: source, translationPending: true };
    }

    // Default: treat as pending if missing (caller should lock).
    return { out: doc, resolvedLang: source, translationPending: true };
  }

  const dbSet = {};
  const bucketOut = {
    title: _safeText(existingBucket?.title),
    summary: _safeText(existingBucket?.summary),
    content: _safeText(existingBucket?.content),
  };

  let firstErrorMessage = null;
  let sawRateLimit = false;

  try {
    if (missing.includes('title')) {
      const t = await translateTextStrict({ text: doc?.title, sourceLang: source, targetLang: desired });
      if (t.ok && _isNonEmptyString(t.text)) {
        bucketOut.title = t.text;
        dbSet[`translations.${desired}.title`] = t.text;
      } else {
        const msg = t && t.ok === false ? t.error : 'empty_output';
        if (!firstErrorMessage) firstErrorMessage = msg;
        if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
        try {
          log.warn?.('[i18n][news] title translation failed', {
            id: String(doc?._id || ''),
            slug: String(doc?.slug || ''),
            from: source,
            to: desired,
            error: msg,
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
        const msg = s && s.ok === false ? s.error : 'empty_output';
        if (!firstErrorMessage) firstErrorMessage = msg;
        if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
        try {
          log.warn?.('[i18n][news] summary translation failed', {
            id: String(doc?._id || ''),
            slug: String(doc?.slug || ''),
            from: source,
            to: desired,
            error: msg,
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
          const msg = c && c.ok === false ? c.error : 'empty_output';
          if (!firstErrorMessage) firstErrorMessage = msg;
          if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
          try {
            log.warn?.('[i18n][news] content translation failed', {
              id: String(doc?._id || ''),
              slug: String(doc?.slug || ''),
              from: source,
              to: desired,
              error: msg,
            });
          } catch (_) {}
        }
      } else {
        const c = await translateLongTextStrict({ text: rawBody, sourceLang: source, targetLang: desired });
        if (c.ok && _isNonEmptyString(c.text)) {
          bucketOut.content = c.text;
          dbSet[`translations.${desired}.content`] = c.text;
        } else {
          const msg = c && c.ok === false ? c.error : 'empty_output';
          if (!firstErrorMessage) firstErrorMessage = msg;
          if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
          try {
            log.warn?.('[i18n][news] content translation failed', {
              id: String(doc?._id || ''),
              slug: String(doc?.slug || ''),
              from: source,
              to: desired,
              error: msg,
            });
          } catch (_) {}
        }
      }
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (!firstErrorMessage) firstErrorMessage = msg;
    if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
    try {
      log.warn?.('[i18n][news] on-demand translation threw', {
        id: String(doc?._id || ''),
        slug: String(doc?.slug || ''),
        from: source,
        to: desired,
        missing,
        message: msg,
      });
    } catch (_) {}
  }

  const hasAllTranslated = _isNonEmptyString(bucketOut.title) && _isNonEmptyString(bucketOut.summary) && _isNonEmptyString(bucketOut.content);

  if (hasAllTranslated) {
    dbSet[`translationStatus.${desired}`] = 'ready';
    dbSet[`translationError.${desired}`] = null;
    dbSet[`translationNextRetryAt.${desired}`] = null;
    const out = { ...doc, title: bucketOut.title, description: bucketOut.summary, content: bucketOut.content };
    return {
      out,
      resolvedLang: desired,
      translationPending: false,
      ...(Object.keys(dbSet).length ? { dbSet } : {}),
    };
  }

  // Mark failure + cooldown (rate-limit only) so we don't retry repeatedly.
  const errMsg = firstErrorMessage || 'incomplete_translation';
  dbSet[`translationStatus.${desired}`] = 'failed';
  dbSet[`translationError.${desired}`] = errMsg;
  dbSet[`translationNextRetryAt.${desired}`] = sawRateLimit ? _addMinutes(nowDt, 30) : null;

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
