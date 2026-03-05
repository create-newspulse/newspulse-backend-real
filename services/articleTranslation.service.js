const googleTranslate = require('./googleTranslate.service');

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
  return /rate\s*limit\s*exceeded/i.test(String(msg || ''));
}

function _addMinutes(d, minutes) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + (minutes * 60 * 1000));
}

function detectLangFromContent(textOrHtml) {
  // Lightweight, offline detection. Do not infer from title.
  // - Gujarati block: U+0A80..U+0AFF
  // - Devanagari block: U+0900..U+097F
  const s = String(textOrHtml || '');
  if (!s.trim()) return null;

  if (/[\u0A80-\u0AFF]/.test(s)) return 'gu';
  if (/[\u0900-\u097F]/.test(s)) return 'hi';

  // Default heuristic.
  return 'en';
}

function chunkHtmlByClosingP(html, maxChunkChars = 3500) {
  const raw = String(html ?? '');
  if (!raw.trim()) return [];

  const out = [];
  const parts = [];

  const re = /<\/p\s*>/gi;
  let last = 0;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const end = m.index + m[0].length;
    const seg = raw.slice(last, end);
    if (seg) parts.push(seg);
    last = end;
  }
  const tail = raw.slice(last);
  if (tail) parts.push(tail);

  // If there were no </p> tags, treat as a single part.
  const seq = parts.length ? parts : [raw];

  let buf = '';
  for (const seg of seq) {
    const s = String(seg || '');
    if (!s) continue;

    if (!buf) {
      // If single segment exceeds max, hard-split.
      if (s.length > maxChunkChars) {
        for (let i = 0; i < s.length; i += maxChunkChars) {
          out.push(s.slice(i, i + maxChunkChars));
        }
        buf = '';
      } else {
        buf = s;
      }
      continue;
    }

    const candidate = buf + s;
    if (candidate.length <= maxChunkChars) {
      buf = candidate;
      continue;
    }

    out.push(buf);

    if (s.length > maxChunkChars) {
      for (let i = 0; i < s.length; i += maxChunkChars) {
        out.push(s.slice(i, i + maxChunkChars));
      }
      buf = '';
    } else {
      buf = s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function _decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

async function translateHtmlStrict({ html, sourceLang, targetLang, maxChunkChars = 3500, fetchImpl }) {
  const src = normalizeLang(sourceLang);
  const dst = normalizeLang(targetLang);
  const raw = String(html ?? '');

  if (!raw.trim()) return { ok: true, html: '' };
  if (!dst) return { ok: false, error: 'Missing targetLang' };
  if (src && src === dst) return { ok: true, html: raw };

  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: 'Missing GOOGLE_TRANSLATE_API_KEY' };

  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, error: 'fetch is not available' };

  const chunks = chunkHtmlByClosingP(raw, maxChunkChars);
  if (!chunks.length) return { ok: true, html: '' };

  const out = [];
  // Google Translate v2 accepts up to ~50 q items per request.
  const chunkSize = 50;
  for (let i = 0; i < chunks.length; i += chunkSize) {
    const part = chunks.slice(i, i + chunkSize);
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
    const res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // v2 uses `format: 'html'` (equivalent intent to mimeType 'text/html').
      body: JSON.stringify({ q: part, target: dst, ...(src ? { source: src } : {}), format: 'html' }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json && json.error && json.error.message ? json.error.message : `HTTP_${res.status}`;
      return { ok: false, error: `Translate failed: ${msg}` };
    }

    const translations = json && json.data && Array.isArray(json.data.translations) ? json.data.translations : null;
    if (!translations || translations.length !== part.length) {
      return { ok: false, error: 'Translate failed: unexpected response shape' };
    }

    for (const t of translations) out.push(_decodeBasicEntities(t && t.translatedText));
  }

  const joined = out.join('');
  if (!joined.trim()) return { ok: false, error: 'Translate returned empty output' };
  return { ok: true, html: joined };
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

function getMissingFields(bucket) {
  const b = bucket && typeof bucket === 'object' ? bucket : {};
  const missing = [];
  if (!_isNonEmptyString(b.title)) missing.push('title');
  if (!_isNonEmptyString(b.summary)) missing.push('summary');
  if (!_isNonEmptyString(b.content)) missing.push('content');
  return missing;
}

function localizeArticleFromTranslations(articleLike, requestedLang) {
  const desired = normalizeLang(requestedLang);
  const baseLang = normalizeLang(articleLike?.originalLang) || detectLangFromContent(articleLike?.content) || normalizeLang(articleLike?.language) || 'en';
  if (!desired) return { out: articleLike, resolvedLang: baseLang, translationPending: false };

  const t = articleLike && articleLike.translations && typeof articleLike.translations === 'object' ? articleLike.translations[desired] : null;
  const hasAll = _isNonEmptyString(t?.title) && _isNonEmptyString(t?.summary) && _isNonEmptyString(t?.content);
  if (!hasAll) {
    return { out: articleLike, resolvedLang: baseLang, translationPending: desired !== baseLang };
  }

  const out = { ...articleLike, title: t.title, summary: t.summary, content: t.content };
  return { out, resolvedLang: desired, translationPending: false };
}

/**
 * On-demand translation for public read paths.
 *
 * @param {{
 *  article: any,
 *  requestedLang: string,
 *  logger?: any,
 * }} params
 * @returns {Promise<{ out: any, resolvedLang: string, translationPending: boolean, dbSet?: Record<string, any> }>} 
 */
async function ensureOnDemandArticleTranslation({ article, requestedLang, logger, lockOwner = false, now = new Date() }) {
  const log = logger || console;
  const nowDt = now instanceof Date ? now : new Date(now);
  const desired = normalizeLang(requestedLang);
  // IMPORTANT: never trust a defaulted/stale `language` value as the source of truth.
  // Prefer originalLang, else detect from content (Gujarati/Devanagari heuristics), else fall back.
  const source = normalizeLang(article?.originalLang) || detectLangFromContent(article?.content) || normalizeLang(article?.language) || 'en';
  if (!desired) return { out: article, resolvedLang: source, translationPending: false };

  // No translation needed.
  if (desired === source) {
    const out = { ...article, originalLang: article?.originalLang || source };
    const dbSet = (!normalizeLang(article?.originalLang) && normalizeLang(source)) ? { originalLang: source } : undefined;
    return { out, resolvedLang: desired, translationPending: false, ...(dbSet ? { dbSet } : {}) };
  }

  const existingBucket = article?.translations?.[desired];
  const missing = getMissingFields(existingBucket);
  if (!missing.length) {
    return localizeArticleFromTranslations(article, desired);
  }

  // Status-based caching/locking/cooldown.
  // - If pending: do not re-run translation; return original.
  // - If failed and still in cooldown: skip; return original.
  if (!lockOwner) {
    const status = article?.translationStatus?.[desired] || null;
    const retryAtRaw = article?.translationNextRetryAt?.[desired] || null;
    const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;

    if (status === 'pending') {
      const out = { ...article, originalLang: article?.originalLang || source };
      return { out, resolvedLang: source, translationPending: true };
    }

    if (status === 'failed' && retryAt && nowDt < retryAt) {
      const out = { ...article, originalLang: article?.originalLang || source };
      return { out, resolvedLang: source, translationPending: true };
    }
  }

  // Translate missing fields.
  const dbSet = {};
  const provider = 'google';

  // Always persist originalLang when absent.
  if (!normalizeLang(article?.originalLang) && normalizeLang(source)) {
    dbSet.originalLang = source;
  }

  const bucketOut = {
    title: _safeText(existingBucket?.title),
    summary: _safeText(existingBucket?.summary),
    content: _safeText(existingBucket?.content),
  };

  let firstErrorMessage = null;
  let sawRateLimit = false;

  try {
    if (missing.includes('title')) {
      const t = await translateTextStrict({ text: article?.title, sourceLang: source, targetLang: desired });
      if (t.ok && _isNonEmptyString(t.text)) {
        bucketOut.title = t.text;
        dbSet[`translations.${desired}.title`] = t.text;
      } else {
        const msg = t && t.ok === false ? t.error : 'empty_output';
        if (!firstErrorMessage) firstErrorMessage = msg;
        if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
        try {
          log.warn?.('[i18n][article] title translation failed', {
            id: String(article?._id || ''),
            slug: String(article?.slug || ''),
            from: source,
            to: desired,
            error: msg,
          });
        } catch (_) {}
      }
    }

    if (missing.includes('summary')) {
      const s = await translateTextStrict({ text: article?.summary, sourceLang: source, targetLang: desired });
      if (s.ok && _isNonEmptyString(s.text)) {
        bucketOut.summary = s.text;
        dbSet[`translations.${desired}.summary`] = s.text;
      } else {
        const msg = s && s.ok === false ? s.error : 'empty_output';
        if (!firstErrorMessage) firstErrorMessage = msg;
        if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
        try {
          log.warn?.('[i18n][article] summary translation failed', {
            id: String(article?._id || ''),
            slug: String(article?.slug || ''),
            from: source,
            to: desired,
            error: msg,
          });
        } catch (_) {}
      }
    }

    if (missing.includes('content')) {
      const c = await translateHtmlStrict({ html: article?.content, sourceLang: source, targetLang: desired });
      if (c.ok && _isNonEmptyString(c.html)) {
        bucketOut.content = c.html;
        dbSet[`translations.${desired}.content`] = c.html;
      } else {
        const msg = c && c.ok === false ? c.error : 'empty_output';
        if (!firstErrorMessage) firstErrorMessage = msg;
        if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
        // Never silently skip body translation: emit a warning when it fails.
        try {
          log.warn?.('[i18n][article] content translation failed', {
            id: String(article?._id || ''),
            slug: String(article?.slug || ''),
            from: source,
            to: desired,
            error: msg,
          });
        } catch (_) {}
      }
    }

    // Only set metadata if we translated at least one field.
    const didTranslate = Object.keys(dbSet).some((k) => k.startsWith(`translations.${desired}.`) && !k.endsWith('.generatedAt') && !k.endsWith('.provider'));
    if (didTranslate) {
      dbSet[`translations.${desired}.generatedAt`] = nowDt;
      dbSet[`translations.${desired}.provider`] = provider;
    }
  } catch (e) {
    const msg = e?.message || String(e);
    if (!firstErrorMessage) firstErrorMessage = msg;
    if (_isRateLimitErrorMessage(msg)) sawRateLimit = true;
    try {
      log.warn?.('[i18n][article] on-demand translation failed', {
        id: String(article?._id || ''),
        slug: String(article?.slug || ''),
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
    const out = { ...article, title: bucketOut.title, summary: bucketOut.summary, content: bucketOut.content, originalLang: article?.originalLang || source };
    return { out, resolvedLang: desired, translationPending: false, ...(Object.keys(dbSet).length ? { dbSet } : {}) };
  }

  // Mark failure + cooldown (rate-limit only) so we don't retry repeatedly.
  const errMsg = firstErrorMessage || 'incomplete_translation';
  dbSet[`translationStatus.${desired}`] = 'failed';
  dbSet[`translationError.${desired}`] = errMsg;
  dbSet[`translationNextRetryAt.${desired}`] = sawRateLimit ? _addMinutes(nowDt, 30) : null;

  // Strict: never mix languages at field-level. Serve original fields if translation incomplete.
  const out = { ...article, originalLang: article?.originalLang || source };
  return { out, resolvedLang: source, translationPending: desired !== source, ...(Object.keys(dbSet).length ? { dbSet } : {}) };
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  detectLangFromContent,
  chunkHtmlByClosingP,
  translateHtmlStrict,
  localizeArticleFromTranslations,
  ensureOnDemandArticleTranslation,
};
