const googleTranslate = require('./googleTranslate.service');
const { chunkTextByParagraphs } = require('./newsI18n.service');
const { detectLangFromContent, translateHtmlStrict } = require('./articleTranslation.service');
const { isGoogleTranslateConfigured } = require('./translationEnabled');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

function normalizeLang(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  // Native script hints
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (SUPPORTED_LANGS.includes(primary)) return primary;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj') return 'gu';

  return null;
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

function hasFullTranslation(bucket) {
  const b = bucket && typeof bucket === 'object' ? bucket : {};
  return _isNonEmptyString(b.title) && _isNonEmptyString(b.summary) && _isNonEmptyString(b.content);
}

function localizeNewsFromTranslations(docLike, requestedLang) {
  const desired = normalizeLang(requestedLang);
  const baseLang = normalizeLang(docLike?.lang || docLike?.language) || detectLangFromContent(docLike?.content) || 'en';
  if (!desired) return { out: docLike, resolvedLang: baseLang, translationPending: false };

  const t = docLike?.translations?.[desired];
  if (!hasFullTranslation(t)) return { out: docLike, resolvedLang: baseLang, translationPending: desired !== baseLang };

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
    const out = { ...doc, originalLang: doc?.originalLang || source };
    const dbSet = (!normalizeLang(doc?.originalLang) && normalizeLang(source)) ? { originalLang: source } : undefined;
    return { out, resolvedLang: desired, translationPending: false, ...(dbSet ? { dbSet } : {}) };
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

  // Translate as a unit and persist atomically only when all fields succeed.
  const dbSet = {};
  if (!normalizeLang(doc?.originalLang) && normalizeLang(source)) {
    dbSet.originalLang = source;
  }

  let firstErrorMessage = null;
  let sawRateLimit = false;

  async function _fail(msg, context) {
    const m = String(msg || 'translate_failed');
    if (!firstErrorMessage) firstErrorMessage = m;
    if (_isRateLimitErrorMessage(m)) sawRateLimit = true;
    try {
      log.warn?.('[i18n][news] on-demand translation failed', {
        id: String(doc?._id || ''),
        slug: String(doc?.slug || ''),
        from: source,
        to: desired,
        ...context,
        error: m,
      });
    } catch (_) {}
  }

  const title0 = _safeText(doc?.title);
  const summary0 = _safeText(doc?.description || doc?.summary);
  const rawBody = String(doc?.content || doc?.body || '');

  const bucketOut = { title: '', summary: '', content: '' };
  try {
    const t = await translateTextStrict({ text: title0, sourceLang: source, targetLang: desired });
    if (!t.ok || !_isNonEmptyString(t.text)) {
      const msg = t && t.ok === false ? t.error : 'empty_output';
      await _fail(msg, { field: 'title' });
      throw new Error(msg);
    }
    bucketOut.title = t.text;

    const s = await translateTextStrict({ text: summary0, sourceLang: source, targetLang: desired });
    if (!s.ok || !_isNonEmptyString(s.text)) {
      const msg = s && s.ok === false ? s.error : 'empty_output';
      await _fail(msg, { field: 'summary' });
      throw new Error(msg);
    }
    bucketOut.summary = s.text;

    if (isHtmlBody(rawBody)) {
      const c = await translateHtmlStrict({ html: rawBody, sourceLang: source, targetLang: desired });
      if (!c.ok || !_isNonEmptyString(c.html)) {
        const msg = c && c.ok === false ? c.error : 'empty_output';
        await _fail(msg, { field: 'content' });
        throw new Error(msg);
      }
      bucketOut.content = c.html;
    } else {
      const c = await translateLongTextStrict({ text: rawBody, sourceLang: source, targetLang: desired });
      if (!c.ok || !_isNonEmptyString(c.text)) {
        const msg = c && c.ok === false ? c.error : 'empty_output';
        await _fail(msg, { field: 'content' });
        throw new Error(msg);
      }
      bucketOut.content = c.text;
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (!firstErrorMessage) firstErrorMessage = msg;
    if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
  }

  const hasAllTranslated = _isNonEmptyString(bucketOut.title) && _isNonEmptyString(bucketOut.summary) && _isNonEmptyString(bucketOut.content);

  if (hasAllTranslated) {
    dbSet[`translations.${desired}.title`] = bucketOut.title;
    dbSet[`translations.${desired}.summary`] = bucketOut.summary;
    dbSet[`translations.${desired}.content`] = bucketOut.content;
    dbSet[`translations.${desired}.provider`] = 'google';
    dbSet[`translations.${desired}.generatedAt`] = nowDt;
    dbSet[`translationStatus.${desired}`] = 'ready';
    dbSet[`translationError.${desired}`] = null;
    dbSet[`translationNextRetryAt.${desired}`] = null;
    const out = { ...doc, title: bucketOut.title, description: bucketOut.summary, content: bucketOut.content, originalLang: doc?.originalLang || source };
    return { out, resolvedLang: desired, translationPending: false, ...(Object.keys(dbSet).length ? { dbSet } : {}) };
  }

  const errMsg = firstErrorMessage || 'translate_failed';
  dbSet[`translationStatus.${desired}`] = 'failed';
  dbSet[`translationError.${desired}`] = errMsg;
  dbSet[`translationNextRetryAt.${desired}`] = sawRateLimit ? _addMinutes(nowDt, 30) : null;
  const out = { ...doc, originalLang: doc?.originalLang || source };
  return { out, resolvedLang: source, translationPending: true, ...(Object.keys(dbSet).length ? { dbSet } : {}) };
}

module.exports = {
  normalizeLang,
  hasFullTranslation,
  localizeNewsFromTranslations,
  ensureOnDemandNewsTranslation,
};
