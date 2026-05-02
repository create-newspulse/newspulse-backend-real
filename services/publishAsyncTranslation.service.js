const News = require('../models/News');
const { slugifyUnicode } = require('../lib/slug');
const googleTranslate = require('./googleTranslate.service');
const { syncPublicArticleFromNews } = require('./syncPublicArticleFromNews.service');
const { syncTranslationGroupFromMaster } = require('./translationGroupSync.service');
const { isGoogleTranslateConfigured } = require('./translationEnabled');
const TranslationJob = require('../models/TranslationJob');
const os = require('os');
const mongoose = require('mongoose');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];
const TRANSLATION_PROVIDER_VALUES = new Set(['google', 'openai', 'manual']);

function normalizeLang(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.includes(s) ? s : null;
}

function _safeText(v) {
  return String(v ?? '').trim();
}

function _ensureObjectField(doc, key) {
  if (!doc[key] || typeof doc[key] !== 'object' || Array.isArray(doc[key])) {
    doc[key] = {};
  }
  return doc[key];
}

function _ensureTranslationBuckets(doc) {
  if (!doc.translations || typeof doc.translations !== 'object' || Array.isArray(doc.translations)) {
    doc.translations = {};
  }
  for (const lang of SUPPORTED_LANGS) {
    if (!doc.translations[lang] || typeof doc.translations[lang] !== 'object' || Array.isArray(doc.translations[lang])) {
      doc.translations[lang] = { title: '', summary: '', content: '', provider: 'google', generatedAt: null };
    }
    if (!Object.prototype.hasOwnProperty.call(doc.translations[lang], 'provider')) doc.translations[lang].provider = 'google';
    if (!Object.prototype.hasOwnProperty.call(doc.translations[lang], 'generatedAt')) doc.translations[lang].generatedAt = null;
  }
}

function _normalizeProvider(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  return TRANSLATION_PROVIDER_VALUES.has(s) ? s : null;
}

function _sanitizeBucket(bucket, options = {}) {
  const fallbackProvider = _normalizeProvider(options.fallbackProvider) || 'google';
  const now = options.now instanceof Date ? options.now : new Date();
  const b = bucket && typeof bucket === 'object' && !Array.isArray(bucket) ? { ...bucket } : {};

  b.title = typeof b.title === 'string' ? b.title : String(b.title ?? '');
  b.summary = typeof b.summary === 'string' ? b.summary : String(b.summary ?? '');
  b.content = typeof b.content === 'string' ? b.content : String(b.content ?? '');

  const provider = _normalizeProvider(b.provider);
  b.provider = provider || fallbackProvider;

  if (b.generatedAt) {
    const dt = new Date(b.generatedAt);
    b.generatedAt = Number.isNaN(dt.getTime()) ? null : dt;
  } else {
    b.generatedAt = null;
  }

  // If a full translation exists but generatedAt is missing, backfill it.
  if (_hasFullBucket(b) && !b.generatedAt) b.generatedAt = now;

  return b;
}

function _ensureStatusBuckets(doc) {
  _ensureObjectField(doc, 'translationStatus');
  _ensureObjectField(doc, 'translationError');
  _ensureObjectField(doc, 'translationNextRetryAt');
  _ensureObjectField(doc, 'translationUpdatedAt');
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _hasFullBucket(bucket) {
  const b = bucket && typeof bucket === 'object' ? bucket : {};
  return _isNonEmptyString(b.title) && _isNonEmptyString(b.summary) && _isNonEmptyString(b.content);
}

function _isRateLimitErrorMessage(msg) {
  return /(rate\s*limit\s*exceeded|too\s*many\s*requests|resource\s*exhausted|http[_\s-]*429|\b429\b)/i.test(String(msg || ''));
}

function _addMinutes(d, minutes) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + (minutes * 60 * 1000));
}

function _addSeconds(d, seconds) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + (seconds * 1000));
}

function _retryDelayMinutesForErrorMessage(msg) {
  const m = String(msg || '');
  return _isRateLimitErrorMessage(m) ? 15 : 5;
}

async function _syncSourceAndGroup(docUpdated, logger, reason) {
  if (!docUpdated) return;
  await syncPublicArticleFromNews(docUpdated, { logger });
  await syncTranslationGroupFromMaster(docUpdated, {
    logger,
    reason: reason || 'publish_async_translation',
    invalidate: String(docUpdated.status || '').toLowerCase() === 'published',
  });
}

function buildPendingTranslationState({ baseLang, title, summary, content }) {
  const base = normalizeLang(baseLang) || 'en';
  const at = new Date();
  const translations = {};
  const translationStatus = {};
  const translationError = {};
  const translationNextRetryAt = {};
  const translationUpdatedAt = {};

  for (const lang of SUPPORTED_LANGS) {
    if (lang === base) {
      translations[lang] = {
        title: _safeText(title),
        summary: _safeText(summary),
        content: _safeText(content),
        provider: 'manual',
        generatedAt: at,
      };
      translationStatus[lang] = 'ready';
      translationError[lang] = null;
      translationNextRetryAt[lang] = null;
      translationUpdatedAt[lang] = at;
    } else {
      translations[lang] = { title: '', summary: '', content: '', provider: 'google', generatedAt: null };
      translationStatus[lang] = 'pending';
      translationError[lang] = null;
      translationNextRetryAt[lang] = null;
      translationUpdatedAt[lang] = at;
    }
  }

  return { baseLang: base, translations, translationStatus, translationError, translationNextRetryAt, translationUpdatedAt };
}

function buildPublishTranslationState({ baseLang, title, summary, content, existing, now, translationEnabled = true }) {
  const base = normalizeLang(baseLang) || 'en';
  const at = now instanceof Date ? now : new Date();

  const nextBaseTitle = _safeText(title);
  const nextBaseSummary = _safeText(summary);
  const nextBaseContent = _safeText(content);
  const prevBaseTitle = _safeText(existing?.title || existing?.translations?.[base]?.title);
  const prevBaseSummary = _safeText(existing?.description || existing?.summary || existing?.translations?.[base]?.summary);
  const prevBaseContent = _safeText(existing?.content || existing?.translations?.[base]?.content);
  const sourceChanged = (
    prevBaseTitle !== nextBaseTitle
    || prevBaseSummary !== nextBaseSummary
    || prevBaseContent !== nextBaseContent
  );

  const translations = { ...(existing?.translations && typeof existing.translations === 'object' ? existing.translations : {}) };
  const translationStatus = { ...(existing?.translationStatus && typeof existing.translationStatus === 'object' ? existing.translationStatus : {}) };
  const translationError = { ...(existing?.translationError && typeof existing.translationError === 'object' ? existing.translationError : {}) };
  const translationNextRetryAt = { ...(existing?.translationNextRetryAt && typeof existing.translationNextRetryAt === 'object' ? existing.translationNextRetryAt : {}) };
  const translationUpdatedAt = { ...(existing?.translationUpdatedAt && typeof existing.translationUpdatedAt === 'object' ? existing.translationUpdatedAt : {}) };

  for (const lang of SUPPORTED_LANGS) {
    const existingBucket = existing?.translations?.[lang];
    const existingStatus = existing?.translationStatus?.[lang] || null;
    const existingRetryAtRaw = existing?.translationNextRetryAt?.[lang] || null;
    const existingRetryAt = existingRetryAtRaw ? new Date(existingRetryAtRaw) : null;
    const existingUpdatedAtRaw = existing?.translationUpdatedAt?.[lang] || null;
    const existingUpdatedAt = existingUpdatedAtRaw ? new Date(existingUpdatedAtRaw) : null;

    if (lang === base) {
      translations[lang] = {
        title: nextBaseTitle,
        summary: nextBaseSummary,
        content: nextBaseContent,
        provider: 'manual',
        generatedAt: at,
      };
      translationStatus[lang] = 'ready';
      translationError[lang] = null;
      translationNextRetryAt[lang] = null;
      translationUpdatedAt[lang] = at;
      continue;
    }

    // If translation is disabled/misconfigured, still persist a non-null status.
    // Preserve any full cached bucket; otherwise keep pending (publish must never block).
    if (!translationEnabled) {
      if (_hasFullBucket(existingBucket)) {
        translations[lang] = _sanitizeBucket(existingBucket, { fallbackProvider: 'google', now: at });
        translationStatus[lang] = 'ready';
        translationError[lang] = null;
        translationNextRetryAt[lang] = null;
        translationUpdatedAt[lang] = existingUpdatedAt && !Number.isNaN(existingUpdatedAt.getTime()) ? existingUpdatedAt : at;
      } else {
        translations[lang] = _sanitizeBucket(
          (existingBucket && typeof existingBucket === 'object' && !Array.isArray(existingBucket))
            ? existingBucket
            : { title: '', summary: '', content: '', provider: 'google', generatedAt: null },
          { fallbackProvider: 'google', now: at }
        );
        translationStatus[lang] = 'pending';
        translationError[lang] = null;
        translationNextRetryAt[lang] = null;
        translationUpdatedAt[lang] = existingUpdatedAt && !Number.isNaN(existingUpdatedAt.getTime()) ? existingUpdatedAt : at;
      }
      continue;
    }

    if (sourceChanged) {
      translations[lang] = { title: '', summary: '', content: '', provider: 'google', generatedAt: null };
      translationStatus[lang] = 'pending';
      translationError[lang] = null;
      translationNextRetryAt[lang] = null;
      translationUpdatedAt[lang] = at;
      continue;
    }

    // Preserve any fully translated bucket as a cache hit.
    if (_hasFullBucket(existingBucket)) {
      translations[lang] = _sanitizeBucket(existingBucket, { fallbackProvider: 'google', now: at });
      translationStatus[lang] = 'ready';
      translationError[lang] = null;
      translationNextRetryAt[lang] = null;
      translationUpdatedAt[lang] = existingUpdatedAt && !Number.isNaN(existingUpdatedAt.getTime()) ? existingUpdatedAt : at;
      continue;
    }

    // If translation is already in-flight, preserve pending to avoid stampede.
    if (existingStatus === 'pending') {
      if (!translations[lang] || typeof translations[lang] !== 'object') translations[lang] = { title: '', summary: '', content: '', provider: 'google', generatedAt: null };
      translationUpdatedAt[lang] = existingUpdatedAt && !Number.isNaN(existingUpdatedAt.getTime()) ? existingUpdatedAt : at;
      continue;
    }

    // If in cooldown due to rate-limiting, preserve failed + nextRetryAt.
    if (existingStatus === 'failed' && existingRetryAt && at < existingRetryAt) {
      if (!translations[lang] || typeof translations[lang] !== 'object') translations[lang] = { title: '', summary: '', content: '', provider: 'google', generatedAt: null };
      translationStatus[lang] = 'failed';
      translationNextRetryAt[lang] = existingRetryAt;
      translationUpdatedAt[lang] = existingUpdatedAt && !Number.isNaN(existingUpdatedAt.getTime()) ? existingUpdatedAt : at;
      continue;
    }

    // Otherwise, mark pending and clear stale errors/cooldowns.
    translations[lang] = { title: '', summary: '', content: '', provider: 'google', generatedAt: null };
    translationStatus[lang] = 'pending';
    translationError[lang] = null;
    translationNextRetryAt[lang] = null;
    translationUpdatedAt[lang] = at;
  }

  return { baseLang: base, translations, translationStatus, translationError, translationNextRetryAt, translationUpdatedAt };
}

function markPublishTranslationPending(doc) {
  if (!doc) return;
  const baseLang = normalizeLang(doc.lang) || normalizeLang(doc.language) || 'en';

  // Persist originalLang once so public endpoints can reliably resolve source language.
  if (!normalizeLang(doc.originalLang)) {
    doc.originalLang = baseLang;
    try {
      if (typeof doc.markModified === 'function') doc.markModified('originalLang');
    } catch (_) {}
  }

  const translationEnabled = isGoogleTranslateConfigured();

  _ensureTranslationBuckets(doc);
  _ensureStatusBuckets(doc);

  const pending = buildPublishTranslationState({
    baseLang,
    title: doc.title,
    summary: doc.description,
    content: doc.content,
    existing: {
      translations: doc.translations,
      translationStatus: doc.translationStatus,
      translationError: doc.translationError,
      translationNextRetryAt: doc.translationNextRetryAt,
      translationUpdatedAt: doc.translationUpdatedAt,
    },
    now: new Date(),
    translationEnabled,
  });

  doc.translations = pending.translations;
  doc.translationStatus = pending.translationStatus;
  doc.translationError = pending.translationError;
  doc.translationNextRetryAt = pending.translationNextRetryAt;
  doc.translationUpdatedAt = pending.translationUpdatedAt;

  try {
    if (typeof doc.markModified === 'function') {
      doc.markModified('translations');
      doc.markModified('translationStatus');
      doc.markModified('translationError');
      doc.markModified('translationNextRetryAt');
      doc.markModified('translationUpdatedAt');
    }
  } catch (_) {}
}

function _chunkHtmlByClosingP(html, maxChunkChars) {
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

  const seq = parts.length ? parts : [raw];

  let buf = '';
  for (const seg of seq) {
    const s = String(seg || '');
    if (!s) continue;

    if (!buf) {
      if (s.length > maxChunkChars) {
        for (let i = 0; i < s.length; i += maxChunkChars) out.push(s.slice(i, i + maxChunkChars));
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
      for (let i = 0; i < s.length; i += maxChunkChars) out.push(s.slice(i, i + maxChunkChars));
      buf = '';
    } else {
      buf = s;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function _chunkTextByParagraphs(text, maxChunkChars) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n');
  const paras = raw
    .split(/\n\s*\n+/g)
    .map((p) => p.trim())
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

    if (p.length > maxChunkChars) {
      for (let i = 0; i < p.length; i += maxChunkChars) out.push(p.slice(i, i + maxChunkChars));
      buf = '';
    } else {
      buf = p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function chunkContentSafely(content, maxChunkChars = 4200) {
  const raw = String(content ?? '');
  if (!raw.trim()) return { chunks: [], joiner: '' };

  // Prefer HTML paragraph boundaries when present.
  if (/<\/p\s*>/i.test(raw) || /<p\b/i.test(raw)) {
    return { chunks: _chunkHtmlByClosingP(raw, maxChunkChars), joiner: '' };
  }

  // Otherwise treat as plain text with blank-line paragraph boundaries.
  return { chunks: _chunkTextByParagraphs(raw, maxChunkChars), joiner: '\n\n' };
}

function ensureNewsSlugsFromTranslations(doc) {
  if (!doc) return;
  const slugs = { ...(doc.slugs || {}) };
  const baseLang = normalizeLang(doc.lang) || normalizeLang(doc.language) || 'en';

  for (const lang of SUPPORTED_LANGS) {
    const title = _safeText(doc?.translations?.[lang]?.title);
    if (title) slugs[lang] = slugifyUnicode(title);
  }

  if (!slugs[baseLang] && doc.title) {
    slugs[baseLang] = slugifyUnicode(doc.title);
  }

  doc.slugs = slugs;
  if ((!doc.slug || !String(doc.slug).trim()) && slugs[baseLang]) {
    doc.slug = slugs[baseLang];
  }
}

async function translateAndSave(newsId, options = {}) {
  const logger = options.logger || console;

  if (!isGoogleTranslateConfigured()) {
    return { ok: true, skipped: true };
  }
  const id = String(newsId || '').trim();
  if (!id) return { ok: false, error: 'Missing newsId' };

  /** @type {any} */
  let doc0;
  try {
    doc0 = await News.findById(id)
      .select('title description content lang language originalLang slug slugs')
      .lean();
  } catch (e) {
    try { logger.error?.('[i18n][publish] load failed', { id, message: e?.message || String(e) }); } catch (_) {}
    return { ok: false, error: 'Load failed' };
  }
  if (!doc0) return { ok: false, error: 'Not found' };

  const baseLang = normalizeLang(doc0.originalLang) || normalizeLang(doc0.lang) || normalizeLang(doc0.language) || 'en';

  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) {
    // Mark all non-base languages failed and persist a clear error.
    const setFail = {};
    for (const lang of SUPPORTED_LANGS) {
      if (lang === baseLang) continue;
      setFail[`translationStatus.${lang}`] = 'failed';
      setFail[`translationError.${lang}`] = 'Missing GOOGLE_TRANSLATE_API_KEY';
      setFail[`translationNextRetryAt.${lang}`] = null;
    }

    try {
      const docUpdated = await News.findByIdAndUpdate(id, { $set: setFail }, { new: true, runValidators: false });
      if (docUpdated) await _syncSourceAndGroup(docUpdated, logger, 'publish_async_translation_config_error');
    } catch (_) {}

    try {
      logger.error?.('[i18n][publish] Missing GOOGLE_TRANSLATE_API_KEY; background translation skipped', {
        id: String(doc0?._id || ''),
        slug: String(doc0?.slug || ''),
      });
    } catch (_) {}

    return { ok: false, error: 'Missing GOOGLE_TRANSLATE_API_KEY' };
  }

  // Translate per language in the background; never throw.
  for (const dst of SUPPORTED_LANGS) {
    if (dst === baseLang) continue;

    const now = new Date();

    /** @type {any} */
    let current;
    try {
      current = await News.findById(id)
        .select([
          'title',
          'description',
          'content',
          'lang',
          'language',
          'originalLang',
          'slug',
          'slugs',
          `translations.${dst}`,
          `translationStatus.${dst}`,
          `translationError.${dst}`,
          `translationNextRetryAt.${dst}`,
          `translationUpdatedAt.${dst}`,
        ].join(' '))
        .lean();
    } catch (_) {
      current = null;
    }

    if (!current) continue;

    const status = current?.translationStatus?.[dst] || null;
    const retryAt = current?.translationNextRetryAt?.[dst] ? new Date(current.translationNextRetryAt[dst]) : null;
    const updatedAt = current?.translationUpdatedAt?.[dst] ? new Date(current.translationUpdatedAt[dst]) : null;
    const bucket = current?.translations?.[dst];
    const hasFull = _hasFullBucket(bucket);

    // Stuck pending protection: pending for too long without completing.
    if (status === 'pending') {
      const ts = updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.getTime() : null;
      if (ts && (now.getTime() - ts) > (10 * 60 * 1000)) {
        const nextRetryAt = _addMinutes(now, 5);
        try {
          const docUpdated = await News.findByIdAndUpdate(
            id,
            {
              $set: {
                [`translationStatus.${dst}`]: 'failed',
                [`translationError.${dst}`]: 'stuck_pending_timeout',
                [`translationNextRetryAt.${dst}`]: nextRetryAt,
                [`translationUpdatedAt.${dst}`]: now,
              },
            },
            { new: true, runValidators: false }
          );
          if (docUpdated) await _syncSourceAndGroup(docUpdated, logger, 'publish_async_translation_stuck_pending');
        } catch (_) {}

        try {
          logger.warn?.('[i18n][publish] stuck pending; marked failed', {
            id: String(doc0?._id || ''),
            slug: String(doc0?.slug || ''),
            from: baseLang,
            to: dst,
            ageMs: ts ? (now.getTime() - ts) : null,
          });
        } catch (_) {}

        continue;
      }
    }

    // Cache hit: translation already complete.
    if (hasFull) {
      // Repair legacy/partial metadata: full bucket must always have provider+generatedAt.
      const providerFixed = _normalizeProvider(bucket?.provider) || 'google';
      const generatedAtFixed = bucket?.generatedAt ? new Date(bucket.generatedAt) : null;
      const needsGeneratedAt = !generatedAtFixed || Number.isNaN(generatedAtFixed.getTime());

      if (status !== 'ready' || current?.translationError?.[dst] || retryAt || providerFixed !== bucket?.provider || needsGeneratedAt) {
        try {
          const docUpdated = await News.findByIdAndUpdate(
            id,
            {
              $set: {
                [`translationStatus.${dst}`]: 'ready',
                [`translationError.${dst}`]: null,
                [`translationNextRetryAt.${dst}`]: null,
                [`translations.${dst}.provider`]: providerFixed,
                [`translations.${dst}.generatedAt`]: needsGeneratedAt ? now : generatedAtFixed,
                [`translationUpdatedAt.${dst}`]: now,
              },
            },
            { new: true, runValidators: false }
          );
          if (docUpdated) await _syncSourceAndGroup(docUpdated, logger, 'publish_async_translation_cache_repair');
        } catch (_) {}
      }
      continue;
    }

    // Cooldown: do not retry until nextRetryAt.
    if (status === 'failed' && retryAt && now < retryAt) continue;

    // Ensure status is pending while we translate (queue job lock prevents stampede).
    try {
      const setPending = {
        [`translationStatus.${dst}`]: 'pending',
        [`translationError.${dst}`]: null,
        [`translationNextRetryAt.${dst}`]: null,
        [`translationUpdatedAt.${dst}`]: now,
      };
      // Keep originalLang pinned.
      if (!normalizeLang(current?.originalLang)) setPending.originalLang = baseLang;
      await News.updateOne({ _id: id }, { $set: setPending }).catch(() => null);
    } catch (_) {}

    try {
      // Prepare batch: title + summary + chunked content.
      const title = _safeText(current.title);
      const summary = _safeText(current.description);
      const { chunks, joiner } = chunkContentSafely(current.content, 4200);

      const q = [title, summary, ...chunks];
      const tr = await googleTranslate.translateMany(q, dst, { sourceLang: baseLang, apiKey, format: 'html' });
      if (!tr || tr.ok !== true || !Array.isArray(tr.items) || tr.items.length !== q.length) {
        const errMsg = tr && tr.ok === false && tr.error ? tr.error : 'Translate failed';
        throw new Error(errMsg);
      }

      const titleT = _safeText(tr.items[0]);
      const summaryT = _safeText(tr.items[1]);
      const contentParts = tr.items.slice(2).map((s) => String(s ?? ''));
      const contentT = joiner ? contentParts.join(joiner) : contentParts.join('');

      if (!titleT || !summaryT || !String(contentT || '').trim()) {
        throw new Error('Translate returned empty output');
      }

      const setOk = {
        [`translations.${dst}.title`]: titleT,
        [`translations.${dst}.summary`]: summaryT,
        [`translations.${dst}.content`]: contentT,
        [`translations.${dst}.provider`]: 'google',
        [`translations.${dst}.generatedAt`]: now,
        [`translationStatus.${dst}`]: 'ready',
        [`translationError.${dst}`]: null,
        [`translationNextRetryAt.${dst}`]: null,
        [`translationUpdatedAt.${dst}`]: now,
        [`slugs.${dst}`]: slugifyUnicode(titleT),
      };

      // Always keep base language status as ready.
      setOk[`translationStatus.${baseLang}`] = 'ready';
      setOk[`translationError.${baseLang}`] = null;
      setOk[`translationNextRetryAt.${baseLang}`] = null;
      setOk[`translationUpdatedAt.${baseLang}`] = now;
      setOk[`translations.${baseLang}.title`] = _safeText(doc0.title);
      setOk[`translations.${baseLang}.summary`] = _safeText(doc0.description);
      setOk[`translations.${baseLang}.content`] = _safeText(doc0.content);
      setOk[`translations.${baseLang}.provider`] = 'manual';
      setOk[`translations.${baseLang}.generatedAt`] = now;

      // Ensure source language is persisted.
      setOk.originalLang = baseLang;

      const docUpdated = await News.findByIdAndUpdate(id, { $set: setOk }, { new: true, runValidators: false });
      if (docUpdated) {
        try {
          logger.info?.('[i18n][publish] saved translation', {
            id: String(doc0?._id || ''),
            slug: String(doc0?.slug || ''),
            from: baseLang,
            to: dst,
          });
        } catch (_) {}

        try {
          await _syncSourceAndGroup(docUpdated, logger, 'publish_async_translation_ready');
        } catch (e) {
          try {
            logger.warn?.('[i18n][publish] sync after translation failed', {
              id: String(doc0?._id || ''),
              slug: String(doc0?.slug || ''),
              message: e?.message || String(e),
            });
          } catch (_) {}
        }
      }
    } catch (e) {
      const msg = e?.message || String(e);
      const isRateLimit = _isRateLimitErrorMessage(msg);
      const delayMin = _retryDelayMinutesForErrorMessage(msg);
      try {
        const docUpdated = await News.findByIdAndUpdate(
          id,
          {
            $set: {
              [`translationStatus.${dst}`]: 'failed',
              [`translationError.${dst}`]: msg,
              [`translationNextRetryAt.${dst}`]: _addMinutes(now, delayMin),
              [`translationUpdatedAt.${dst}`]: now,
            },
          },
          { new: true, runValidators: false }
        );
        if (docUpdated) await _syncSourceAndGroup(docUpdated, logger, 'publish_async_translation_failed');
      } catch (_) {}

      try {
        logger.warn?.('[i18n][publish] translation failed', {
          id: String(doc0?._id || ''),
          slug: String(doc0?.slug || ''),
          from: baseLang,
          to: dst,
          error: msg,
          retryAtMinutes: delayMin,
          isRateLimit,
        });
      } catch (_) {}
    }
  }
}

const JOB_TYPE = 'news-publish-translate';

async function enqueueTranslateAndSave(newsId, options = {}) {
  const logger = options.logger || console;
  const idRaw = String(newsId || '').trim();
  if (!idRaw) return;

  if (!mongoose.isValidObjectId(idRaw)) {
    // Be forgiving in tests; job creation is best-effort.
    try { logger.warn?.('[i18n][queue] invalid newsId; skipping enqueue', { id: idRaw }); } catch (_) {}
    return;
  }

  const newsIdObj = new mongoose.Types.ObjectId(idRaw);
  const now = new Date();

  try {
    await TranslationJob.findOneAndUpdate(
      { type: JOB_TYPE, newsId: newsIdObj },
      {
        $set: {
          status: 'queued',
          runAt: now,
          lockedAt: null,
          lockedBy: null,
          finishedAt: null,
          lastError: null,
        },
        $setOnInsert: {
          attempts: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
  } catch (e) {
    try { logger.warn?.('[i18n][queue] enqueue failed', { id: idRaw, message: e?.message || String(e) }); } catch (_) {}
  }
}

let _workerStarted = false;
let _workerTimer = null;

function startPublishTranslationWorker(options = {}) {
  const logger = options.logger || console;
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return;
  if (_workerStarted) return;
  _workerStarted = true;

  const concurrencyRaw = options.concurrency ?? process.env.TRANSLATION_QUEUE_CONCURRENCY;
  const concurrency = Math.max(2, Math.min(5, parseInt(String(concurrencyRaw || '3'), 10) || 3));
  const pollMsRaw = options.pollMs ?? process.env.TRANSLATION_QUEUE_POLL_MS;
  const pollMs = Math.max(500, Math.min(10000, parseInt(String(pollMsRaw || '1000'), 10) || 1000));

  const workerId = `${os.hostname()}:${process.pid}`;
  const staleMs = 20 * 60 * 1000;
  let active = 0;

  async function _processJob(job) {
    const jobId = job && job._id ? String(job._id) : '';
    const newsId = job && job.newsId ? String(job.newsId) : '';
    const startedAt = new Date();

    try {
      await translateAndSave(newsId, { logger });

      // Decide whether to requeue based on any nextRetryAt values.
      const doc = await News.findById(newsId)
        .select('lang language originalLang translationStatus translationNextRetryAt translationUpdatedAt translations')
        .lean()
        .catch(() => null);

      const now = new Date();
      let nextRunAt = null;
      const baseLang = normalizeLang(doc?.originalLang) || normalizeLang(doc?.lang) || normalizeLang(doc?.language) || 'en';

      for (const lang of SUPPORTED_LANGS) {
        if (lang === baseLang) continue;

        const status = doc?.translationStatus?.[lang] || null;
        const retryAtRaw = doc?.translationNextRetryAt?.[lang] || null;
        const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;
        const bucket = doc?.translations?.[lang];
        const hasFull = _hasFullBucket(bucket);

        if (hasFull && status === 'ready') continue;

        if (status === 'failed' && retryAt && retryAt > now) {
          if (!nextRunAt || retryAt < nextRunAt) nextRunAt = retryAt;
          continue;
        }

        // Still pending/missing; retry soon.
        // NOTE: translateAndSave will apply stuck-pending protection based on translationUpdatedAt.
        if (!nextRunAt) nextRunAt = _addSeconds(now, 30);
      }

      if (nextRunAt) {
        await TranslationJob.updateOne(
          { _id: jobId },
          {
            $set: {
              status: 'queued',
              runAt: nextRunAt,
              lockedAt: null,
              lockedBy: null,
              finishedAt: null,
            },
          }
        ).catch(() => null);
        return;
      }

      await TranslationJob.updateOne(
        { _id: jobId },
        {
          $set: {
            status: 'done',
            lockedAt: null,
            lockedBy: null,
            finishedAt: new Date(),
          },
        }
      ).catch(() => null);
    } catch (e) {
      const msg = e?.message || String(e);
      try {
        await TranslationJob.updateOne(
          { _id: jobId },
          {
            $set: {
              status: 'queued',
              runAt: new Date(Date.now() + 2 * 60 * 1000),
              lockedAt: null,
              lockedBy: null,
              lastError: msg,
            },
          }
        ).catch(() => null);
      } catch (_) {}

      try {
        logger.warn?.('[i18n][queue] job failed; requeued', {
          jobId,
          newsId,
          message: msg,
          durationMs: Date.now() - startedAt.getTime(),
        });
      } catch (_) {}
    }
  }

  async function _tick() {
    if (!_workerStarted) return;
    if (!isGoogleTranslateConfigured()) return;

    while (active < concurrency) {
      const now = new Date();
      const staleCutoff = new Date(now.getTime() - staleMs);
      const job = await TranslationJob.findOneAndUpdate(
        {
          type: JOB_TYPE,
          runAt: { $lte: now },
          $or: [
            { status: 'queued' },
            { status: 'running', lockedAt: { $lte: staleCutoff } },
          ],
        },
        {
          $set: {
            status: 'running',
            lockedAt: now,
            lockedBy: workerId,
          },
          $inc: { attempts: 1 },
        },
        { sort: { runAt: 1, updatedAt: 1 }, new: true }
      ).lean();

      if (!job) break;

      active++;
      _processJob(job)
        .catch(() => null)
        .finally(() => {
          active = Math.max(0, active - 1);
        });
    }
  }

  _workerTimer = setInterval(() => {
    _tick().catch((e) => {
      try { logger.warn?.('[i18n][queue] tick failed', { message: e?.message || String(e) }); } catch (_) {}
    });
  }, pollMs);

  try {
    logger.log?.('[i18n][queue] publish translation worker started', { concurrency, pollMs, workerId });
  } catch (_) {}
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  buildPendingTranslationState,
  buildPublishTranslationState,
  markPublishTranslationPending,
  enqueueTranslateAndSave,
  translateAndSave,
  startPublishTranslationWorker,
};
