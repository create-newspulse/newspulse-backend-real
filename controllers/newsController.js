const mongoose = require('mongoose');
const News = require('../models/News');
const { safeDecodeURIComponent, slugifyUnicode, getSlugCandidates } = require('../lib/slug');
const {
  getRequestedLocale,
  parseAllowFallback,
  localizeDocStrict,
  getStoryGroupId,
} = require('../services/publicStoryLocale.service');
const { absolutizeUploadsUrl } = require('../lib/publicBaseUrl');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { markPublishTranslationPending, enqueueTranslateAndSave } = require('../services/publishAsyncTranslation.service');

function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
  return null;
}

function _stripHtmlForLangDetect(v) {
  return String(v ?? '').replace(/<[^>]*>/g, ' ');
}

function _countUnicodeMatches(s, re) {
  const m = String(s || '').match(re);
  return m ? m.length : 0;
}

function inferLanguageFromDocText({ title, description, content } = {}) {
  const text = _stripHtmlForLangDetect(`${title || ''} ${description || ''} ${content || ''}`);
  if (!text.trim()) return null;

  const guCount = _countUnicodeMatches(text, /[\u0A80-\u0AFF]/g);
  const hiCount = _countUnicodeMatches(text, /[\u0900-\u097F]/g);
  const MIN = 12;

  if (guCount >= MIN && guCount > hiCount) return 'gu';
  if (hiCount >= MIN && hiCount > guCount) return 'hi';
  return null;
}

function getIncomingLang(body) {
  // Prefer `lang` but accept legacy `language` too.
  return normalizeLanguage(body?.lang) || normalizeLanguage(body?.language);
}

function normalizeTranslationGroupId(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function normalizeTranslationKey(v) {
  const s = String(v ?? '').trim();
  return s ? s : null;
}

function getTitleForLangFromDocLike(docLike, lang) {
  const desired = normalizeLanguage(lang);
  if (!desired) return '';

  const t = docLike && docLike.translations && docLike.translations[desired];
  const fromTranslations = t && typeof t.title === 'string' ? t.title : '';
  if (fromTranslations && fromTranslations.trim()) return fromTranslations;

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || null;
  if (baseLang === desired) return String(docLike?.title || '');

  return '';
}

function ensureNewsSlugs(docLike) {
  const out = { ...(docLike.slugs || {}) };
  for (const lang of ['en', 'hi', 'gu']) {
    const title = getTitleForLangFromDocLike(docLike, lang);
    if (title && title.trim()) {
      out[lang] = slugifyUnicode(title);
    }
  }
  docLike.slugs = out;

  const baseLang = normalizeLanguage(docLike?.lang) || normalizeLanguage(docLike?.language) || 'en';
  if ((!docLike.slug || !String(docLike.slug).trim()) && out[baseLang]) {
    docLike.slug = out[baseLang];
  }
}

exports.createNews = async (req, res) => {
  try {
    const body = { ...(req.body || {}) };
    if (body.coverImageUrl === undefined && body.imageURL !== undefined) {
      body.coverImageUrl = body.imageURL;
    }

    if (body.coverImageUrl !== undefined) {
      body.coverImageUrl = absolutizeUploadsUrl(body.coverImageUrl);
      // Keep legacy field aligned when it matches.
      if (body.imageURL !== undefined && body.imageURL === body.coverImageUrl) {
        body.imageURL = body.coverImageUrl;
      }
    }

    // Multilingual publishing (Option A+)
    // Backward compatible: if invalid/missing, fall back to defaults.
    const langFromPayload = getIncomingLang(body);
    const inferred = inferLanguageFromDocText({
      title: body.title,
      description: body.description,
      content: body.content,
    });

    // Safety net: if lang is missing or claims en but the content is clearly hi/gu,
    // persist the correct lang to prevent Gujarati leaking onto English routes.
    const effectiveLang = (langFromPayload && langFromPayload !== 'en')
      ? langFromPayload
      : (inferred && inferred !== 'en')
        ? inferred
        : (langFromPayload || null);

    if (effectiveLang) {
      body.lang = effectiveLang;
      body.language = effectiveLang;
      if (body.originalLang === undefined || body.originalLang === null || String(body.originalLang).trim() === '') {
        body.originalLang = effectiveLang;
      }
    } else {
      if (body.lang !== undefined) delete body.lang;
      if (body.language !== undefined) delete body.language;
    }

    const translationGroupId = normalizeTranslationGroupId(body.translationGroupId);
    body.translationGroupId = translationGroupId || new mongoose.Types.ObjectId().toString();

    const translationKey = normalizeTranslationKey(body.translationKey);
    body.translationKey = translationKey || body.translationGroupId;

    ensureNewsSlugs(body);

    const news = new News(body);

    const nextStatus = String(news.status || '').trim().toLowerCase();
    if (nextStatus === 'published') {
      if (!news.publishedAt) news.publishedAt = new Date();
      try {
        markPublishTranslationPending(news);
        ensureNewsSlugs(news);
      } catch (_) {}
    }

    await news.save();

    if (String(news.status || '').trim().toLowerCase() === 'published') {
      // Best-effort sync: keep public Article collection updated.
      syncPublicArticleFromNews(news, { logger: console }).catch(() => null);
      // Fire-and-forget: translation happens asynchronously.
      enqueueTranslateAndSave(news._id, { logger: console }).catch(() => null);
    }
    res.status(201).json({ message: "News created successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.getNews = async (req, res) => {
  try {
    const q = { status: { $regex: '^published$', $options: 'i' } };

    // Filters
    const lang = normalizeLanguage(req.query.lang) || normalizeLanguage(req.query.language);
    if (lang) {
      const lower = lang;
      const upper = lang.toUpperCase();
      q.$or = [{ lang: { $in: [lower, upper] } }, { language: { $in: [lower, upper] } }];
    }

    const topic = (req.query.topic !== undefined) ? String(req.query.topic || '').trim().toLowerCase() : '';
    if (topic) q.topic = new RegExp(`^${topic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    const state = String(req.query.state || req.query.locationState || '').trim();
    if (state) q['location.state'] = new RegExp(`^${state.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');

    const newsList = await News.find(q).sort({ publishedAt: -1, date: -1 });
    const items = (newsList || []).map(doc => {
      const obj = doc.toObject ? doc.toObject({ virtuals: true }) : doc;
      obj.coverImageUrl = obj.coverImageUrl || obj.imageURL || null;
      obj.lang = obj.lang || obj.language || 'gu';
      obj.language = obj.language || obj.lang || 'gu';
      return obj;
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateNews = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const body = { ...(req.body || {}) };
    if (body.coverImageUrl === undefined && body.imageURL !== undefined) {
      body.coverImageUrl = body.imageURL;
    }

    if (body.coverImageUrl !== undefined) {
      body.coverImageUrl = absolutizeUploadsUrl(body.coverImageUrl);
      if (body.imageURL !== undefined && body.imageURL === body.coverImageUrl) {
        body.imageURL = body.coverImageUrl;
      }
    }

    const langFromPayload = getIncomingLang(body);
    const inferred = inferLanguageFromDocText({
      title: body.title,
      description: body.description,
      content: body.content,
    });

    const effectiveLang = (langFromPayload && langFromPayload !== 'en')
      ? langFromPayload
      : (inferred && inferred !== 'en')
        ? inferred
        : (langFromPayload || null);

    if (effectiveLang) {
      body.lang = effectiveLang;
      body.language = effectiveLang;
      if (body.originalLang === undefined || body.originalLang === null || String(body.originalLang).trim() === '') {
        body.originalLang = effectiveLang;
      }
    } else {
      if (body.lang !== undefined) delete body.lang;
      if (body.language !== undefined) delete body.language;
    }

    const translationGroupId = normalizeTranslationGroupId(body.translationGroupId);
    if (translationGroupId) body.translationGroupId = translationGroupId;
    else if (body.translationGroupId !== undefined) delete body.translationGroupId;

    const translationKey = normalizeTranslationKey(body.translationKey);
    if (translationKey) body.translationKey = translationKey;
    else if (body.translationKey !== undefined) delete body.translationKey;

    const doc = await News.findById(id);
    if (!doc) return res.status(404).json({ error: 'Not found' });

    const beforeStatus = String(doc.status || '').trim().toLowerCase();

    doc.set(body);

    const nextStatus = String(doc.status || '').trim().toLowerCase();
    const publishingNow = beforeStatus !== 'published' && nextStatus === 'published';
    if (publishingNow && !doc.publishedAt) doc.publishedAt = new Date();

    // On publish (or edits to already-published docs), keep translation buckets aligned.
    if (nextStatus === 'published') {
      try {
        markPublishTranslationPending(doc);
      } catch (_) {}
    }

    ensureNewsSlugs(doc);
    await doc.save();

    if (String(doc.status || '').trim().toLowerCase() === 'published') {
      syncPublicArticleFromNews(doc, { logger: console }).catch(() => null);
      enqueueTranslateAndSave(doc._id, { logger: console }).catch(() => null);
    }

    return res.json({ message: 'News updated successfully' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/news/slug/:slug
// Public-ish compatibility endpoint used by some clients.
// Must tolerate percent-encoded and decoded Unicode slugs.
exports.getPublishedNewsBySlug = async (req, res) => {
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      return res.status(503).json({ success: false, message: 'Database unavailable' });
    }

    const raw = String(req.params.slug ?? '').trim();
    if (!raw) return res.status(400).json({ success: false, message: 'Missing slug' });

    const decoded = String(safeDecodeURIComponent(raw) ?? '').trim();

    const requestedLocale = getRequestedLocale(req, { defaultLocale: 'en' });
    const fallbackTo = parseAllowFallback(req);

    const debugEnabledRaw = String(process.env.DEBUG_PUBLIC_NEWS_DETAIL || process.env.PUBLIC_NEWS_DETAIL_DEBUG || '').trim().toLowerCase();
    const debugEnabled = debugEnabledRaw === '1' || debugEnabledRaw === 'true' || debugEnabledRaw === 'yes' || debugEnabledRaw === 'y';
    const debug = (event, payload) => {
      if (!debugEnabled) return;
      try {
        console.log('[news][compat-detail]', event, payload || {});
      } catch (_) {}
    };

    debug('request', {
      requestedSlug: raw,
      decodedSlug: decoded || null,
      requestedLocale,
    });

    const lookup = (slugValue) => ({
      status: 'published',
      $or: [
        { slug: slugValue },
        { 'slugs.en': slugValue },
        { 'slugs.hi': slugValue },
        { 'slugs.gu': slugValue },
      ],
    });

    const article =
      (await News.findOne(lookup(decoded)).lean()) ||
      (await News.findOne(lookup(raw)).lean());

    if (!article) return res.status(404).json({ success: false });

    const candidates = Array.from(new Set([
      ...getSlugCandidates(raw),
      ...(decoded ? getSlugCandidates(decoded) : []),
      raw,
      ...(decoded ? [decoded] : []),
    ].filter(Boolean)));

    const matchedLocale = (() => {
      const slugs = article.slugs && typeof article.slugs === 'object' && !Array.isArray(article.slugs) ? article.slugs : null;
      if (slugs) {
        for (const l of ['en', 'hi', 'gu']) {
          const v = typeof slugs[l] === 'string' ? slugs[l].trim() : '';
          if (v && candidates.includes(v)) return l;
        }
      }
      const legacy = typeof article.slug === 'string' ? article.slug.trim() : '';
      if (legacy && candidates.includes(legacy)) return 'legacy';
      return null;
    })();

    debug('matched', {
      matchedLocale,
      storyGroupId: getStoryGroupId(article),
      articleId: article?._id ? String(article._id) : null,
    });

    const localized = localizeDocStrict(article, requestedLocale, {
      mode: 'detail',
      fallbackTo,
      logger: console,
      logContext: { endpoint: 'GET /api/news/slug/:slug' },
    });

    if (!localized) {
      debug('excluded', {
        storyGroupId: getStoryGroupId(article),
        requestedLocale,
      });
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    debug('localized', {
      storyGroupId: localized.storyGroupId || null,
      requestedLocale: localized.requestedLocale || null,
      returnedLocale: localized.selectedLocale || null,
      selectedVariant: localized.selectedVariant || null,
    });

    localized.locale = localized.selectedLocale || localized.resolvedLang || null;
    return res.json({ success: true, data: localized });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || String(error) });
  }
};
