const News = require('../models/News');
const { slugifyUnicode } = require('../lib/slug');
const googleTranslate = require('./googleTranslate.service');
const { syncPublicArticleFromNews } = require('./syncPublicArticleFromNews.service');

const SUPPORTED_LANGS = ['en', 'hi', 'gu'];

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
      doc.translations[lang] = { title: '', summary: '', content: '' };
    }
  }
}

function _ensureStatusBuckets(doc) {
  _ensureObjectField(doc, 'translationStatus');
  _ensureObjectField(doc, 'translationError');
}

function buildPendingTranslationState({ baseLang, title, summary, content }) {
  const base = normalizeLang(baseLang) || 'en';
  const translations = {};
  const translationStatus = {};
  const translationError = {};

  for (const lang of SUPPORTED_LANGS) {
    if (lang === base) {
      translations[lang] = {
        title: _safeText(title),
        summary: _safeText(summary),
        content: _safeText(content),
      };
      translationStatus[lang] = 'ready';
      translationError[lang] = null;
    } else {
      translations[lang] = { title: '', summary: '', content: '' };
      translationStatus[lang] = 'pending';
      translationError[lang] = null;
    }
  }

  return { baseLang: base, translations, translationStatus, translationError };
}

function markPublishTranslationPending(doc) {
  if (!doc) return;
  const baseLang = normalizeLang(doc.lang) || normalizeLang(doc.language) || 'en';

  _ensureTranslationBuckets(doc);
  _ensureStatusBuckets(doc);

  const pending = buildPendingTranslationState({
    baseLang,
    title: doc.title,
    summary: doc.description,
    content: doc.content,
  });

  doc.translations = pending.translations;
  doc.translationStatus = pending.translationStatus;
  doc.translationError = pending.translationError;

  try {
    if (typeof doc.markModified === 'function') {
      doc.markModified('translations');
      doc.markModified('translationStatus');
      doc.markModified('translationError');
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
  const id = String(newsId || '').trim();
  if (!id) return { ok: false, error: 'Missing newsId' };

  /** @type {any} */
  let doc0;
  try {
    doc0 = await News.findById(id).lean();
  } catch (e) {
    try { logger.error?.('[i18n][publish] load failed', { id, message: e?.message || String(e) }); } catch (_) {}
    return { ok: false, error: 'Load failed' };
  }
  if (!doc0) return { ok: false, error: 'Not found' };

  const baseLang = normalizeLang(doc0.lang) || normalizeLang(doc0.language) || 'en';

  const apiKey = String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  if (!apiKey) {
    // Mark all non-base languages failed and persist a clear error.
    const setFail = {};
    for (const lang of SUPPORTED_LANGS) {
      if (lang === baseLang) continue;
      setFail[`translationStatus.${lang}`] = 'failed';
      setFail[`translationError.${lang}`] = 'Missing GOOGLE_TRANSLATE_API_KEY';
    }

    try {
      const docUpdated = await News.findByIdAndUpdate(id, { $set: setFail }, { new: true, runValidators: false });
      if (docUpdated) await syncPublicArticleFromNews(docUpdated, { logger });
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

    try {
      // Prepare batch: title + summary + chunked content.
      const title = _safeText(doc0.title);
      const summary = _safeText(doc0.description);
      const { chunks, joiner } = chunkContentSafely(doc0.content, 4200);

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
        [`translationStatus.${dst}`]: 'ready',
        [`translationError.${dst}`]: null,
        [`slugs.${dst}`]: slugifyUnicode(titleT),
      };

      // Always keep base language status as ready.
      setOk[`translationStatus.${baseLang}`] = 'ready';
      setOk[`translationError.${baseLang}`] = null;
      setOk[`translations.${baseLang}.title`] = _safeText(doc0.title);
      setOk[`translations.${baseLang}.summary`] = _safeText(doc0.description);
      setOk[`translations.${baseLang}.content`] = _safeText(doc0.content);

      const docUpdated = await News.findByIdAndUpdate(id, { $set: setOk }, { new: true, runValidators: false });
      if (docUpdated) await syncPublicArticleFromNews(docUpdated, { logger });
    } catch (e) {
      const msg = e?.message || String(e);
      try {
        const docUpdated = await News.findByIdAndUpdate(
          id,
          {
            $set: {
              [`translationStatus.${dst}`]: 'failed',
              [`translationError.${dst}`]: msg,
            },
          },
          { new: true, runValidators: false }
        );
        if (docUpdated) await syncPublicArticleFromNews(docUpdated, { logger });
      } catch (_) {}

      try {
        logger.warn?.('[i18n][publish] translation failed', {
          id: String(doc0?._id || ''),
          slug: String(doc0?.slug || ''),
          from: baseLang,
          to: dst,
          error: msg,
        });
      } catch (_) {}
    }
  }

  return { ok: true };
}

function enqueueTranslateAndSave(newsId, options = {}) {
  const logger = options.logger || console;
  const id = String(newsId || '').trim();
  if (!id) return;

  setImmediate(() => {
    translateAndSave(id, { logger }).catch((e) => {
      try {
        logger.error?.('[i18n][publish] background job crashed', { id, message: e?.message || String(e) });
      } catch (_) {}
    });
  });
}

module.exports = {
  SUPPORTED_LANGS,
  normalizeLang,
  buildPendingTranslationState,
  markPublishTranslationPending,
  enqueueTranslateAndSave,
  translateAndSave,
};
