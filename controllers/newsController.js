const mongoose = require('mongoose');
const News = require('../models/News');
const { serializePublicArticle } = require('../services/publicArticleSerializer.service');
const { safeDecodeURIComponent, slugifyUnicode } = require('../lib/slug');
const { absolutizeUploadsUrl } = require('../lib/publicBaseUrl');
const { buildArticleCreatorFields, hasArticleCreatorInput } = require('../lib/articleCreator');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');
const { isFounderRole } = require('../lib/teamAccess');
const { inArticleTransaction } = require('../services/articleLifecycle.service');
const { authorizeArticleSave, authorizeArticleCreation, contentSaveBody, scopeChanged } = require('../services/articleSaveAccess.service');

function normalizeLanguage(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'en' || s === 'hi' || s === 'gu') return s;
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
    if (hasArticleCreatorInput(body)) {
      return res.status(400).json({ error: 'Article creator identity is server-controlled' });
    }
    if (Object.keys(body).some((key) => key === 'authorByline' || key.startsWith('authorByline.'))) {
      return res.status(400).json({ error: 'Author bylines must be saved through the authenticated articles API' });
    }
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
    const lang = getIncomingLang(body);
    if (lang) {
      body.lang = lang;
      body.language = lang;
    } else {
      if (body.lang !== undefined) delete body.lang;
      if (body.language !== undefined) delete body.language;
    }

    const translationGroupId = normalizeTranslationGroupId(body.translationGroupId);
    body.translationGroupId = translationGroupId || new mongoose.Types.ObjectId().toString();

    const translationKey = normalizeTranslationKey(body.translationKey);
    body.translationKey = translationKey || body.translationGroupId;

    ensureNewsSlugs(body);

    const news = new News({ ...body, ...buildArticleCreatorFields(req) });
    // Scheduled records can later be published by the system scheduler.
    if (['published', 'scheduled'].includes(news.status) && !isFounderRole(req.admin?.role)) {
      return res.status(403).json({
        error: 'Founder permission is required to publish or schedule news',
        code: 'FOUNDER_REQUIRED',
      });
    }
    await inArticleTransaction(async session => {
      await authorizeArticleCreation(req, news, session);
      await news.save({ session });
    });
    res.status(201).json({ message: "News created successfully" });
  } catch (error) {
    res.status(error.statusCode || error.status || 500).json({
      error: error.message, ...(error.code ? { code: error.code } : {}),
    });
  }
};

exports.getNews = async (req, res) => {
  try {
    const q = buildPubliclyVisibleNewsArticleFilter();

    // Filters
    const lang = normalizeLanguage(req.query.lang) || normalizeLanguage(req.query.language);
    if (lang) {
      const lower = lang;
      const upper = lang.toUpperCase();
      q.$and = (q.$and || []).concat([{ $or: [{ lang: { $in: [lower, upper] } }, { language: { $in: [lower, upper] } }] }]);
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
      return serializePublicArticle(obj);
    });
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

exports.updateNews = async (req, res) => {
  try {
    req.user = req.admin;
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const body = { ...(req.body || {}) };
    if (hasArticleCreatorInput(body)) {
      return res.status(400).json({ error: 'Article creator identity is server-controlled' });
    }
    if (Object.keys(body).some((key) => key === 'authorByline' || key.startsWith('authorByline.'))) {
      return res.status(400).json({ error: 'Author bylines must be saved through the authenticated articles API' });
    }
    if (body.coverImageUrl === undefined && body.imageURL !== undefined) {
      body.coverImageUrl = body.imageURL;
    }

    if (body.coverImageUrl !== undefined) {
      body.coverImageUrl = absolutizeUploadsUrl(body.coverImageUrl);
      if (body.imageURL !== undefined && body.imageURL === body.coverImageUrl) {
        body.imageURL = body.coverImageUrl;
      }
    }

    const lang = getIncomingLang(body);
    if (lang) {
      body.lang = lang;
      body.language = lang;
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

    const updated = await inArticleTransaction(async session => {
      const doc = await News.findById(id, null, { session });
      if (!doc) return null;
      const safeBody = contentSaveBody(body, doc, isFounderRole(req.admin?.role));
      const scope = await authorizeArticleSave(req, doc, safeBody, session, { publicSync: false });
      scope?.bindNewsDocument(doc);
      doc.$where = {
        ...(doc.$where || {}),
        status: doc.status,
        syncVersion: doc.syncVersion ?? null,
        updatedAt: doc.updatedAt ?? null,
        sourceArticleId: doc.sourceArticleId ?? null,
        translationGroupId: doc.translationGroupId ?? null,
        translationKey: doc.translationKey ?? null,
      };
      doc.set(safeBody);
      ensureNewsSlugs(doc);
      try {
        await doc.save({ session });
      } catch (error) {
        if (error.name === 'DocumentNotFoundError') throw scopeChanged();
        throw error;
      }
      return doc;
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });

    return res.json({ message: 'News updated successfully' });
  } catch (error) {
    const status = error.statusCode || error.status || 500;
    console.error('[news.update] failed', { code: error.code || null, status });
    return res.status(status).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
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

    const lookup = (slugValue) => {
      const base = buildPubliclyVisibleNewsArticleFilter();
      return {
        ...base,
        $and: [
          ...((base && Array.isArray(base.$and)) ? base.$and : []),
          { $or: [
            { slug: slugValue },
            { 'slugs.en': slugValue },
            { 'slugs.hi': slugValue },
            { 'slugs.gu': slugValue },
          ] },
        ],
      };
    };

    const article =
      (await News.findOne(lookup(decoded)).lean()) ||
      (await News.findOne(lookup(raw)).lean());

    if (!article) return res.status(404).json({ success: false });
    return res.json({ success: true, data: serializePublicArticle(article) });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || String(error) });
  }
};
