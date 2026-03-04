const express = require('express');
const mongoose = require('mongoose');

// "Stories" in this backend map to the public Article model.
// If your frontend uses a different shape/model, tell me and I’ll swap it.
const Article = require('../models/Article');
const { getSlugCandidates } = require('../lib/slug');
const { ensureOnDemandArticleTranslation } = require('../services/articleTranslation.service');

const router = express.Router();

function isDbConnected() {
  // 1 = connected
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// GET: /api/public/stories?category=&lang=&limit=20&page=1
router.get('/stories', async (req, res) => {
  try {
    const { category, lang, limit = 20, page = 1 } = req.query;

    if (!isDbConnected()) {
      return res.json({ success: true, data: [], message: 'Database unavailable' });
    }

    const q = { status: 'published' };
    if (category) q.category = String(category);
    if (lang) q.language = String(lang);

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * lim;

    const stories = await Article.find(q)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean();

    return res.json({ success: true, data: stories });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// GET: /api/public/stories/:slug
router.get('/stories/:slug', async (req, res) => {
  try {
    if (!isDbConnected()) {
      return res.status(200).json({ success: false, message: 'Database unavailable' });
    }

    const candidates = getSlugCandidates(req.params.slug);
    if (!candidates.length) {
      return res.status(400).json({ success: false, message: 'Missing slug' });
    }

    const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };
    const story = await Article.findOne({
      status: 'published',
      $or: [
        { slug: slugFilter },
        { 'slugs.en': slugFilter },
        { 'slugs.hi': slugFilter },
        { 'slugs.gu': slugFilter },
      ],
    }).lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }

    const langQueryRaw = (req.query.lang || req.query.language || '').toString().trim();
    if (!langQueryRaw) {
      return res.json({ success: true, data: story });
    }

    const localized = await ensureOnDemandArticleTranslation({ article: story, requestedLang: langQueryRaw, logger: console });

    // Persist on-demand translations (and/or originalLang backfill) without crashing the endpoint.
    if (localized && localized.dbSet && story && story._id) {
      try {
        await Article.updateOne({ _id: story._id }, { $set: localized.dbSet }).catch(() => null);
      } catch (e) {
        try {
          console.warn('[i18n-save-failed][public.stories.getBySlug]', {
            id: String(story._id || ''),
            slug: String(story?.slug || ''),
            requestedLang: String(langQueryRaw || ''),
            message: e?.message || String(e),
          });
        } catch (_) {}
      }
    }

    if (localized && localized.translationPending) {
      try {
        console.warn('[i18n-missing][public.stories.getBySlug]', {
          slug: String(story?.slug || ''),
          category: String(story?.category || ''),
          requestedLang: String(langQueryRaw || ''),
          resolvedLang: localized.resolvedLang,
        });
      } catch (_) {}
    }

    return res.json({
      success: true,
      data: localized && localized.out ? localized.out : story,
      resolvedLang: localized && localized.resolvedLang ? localized.resolvedLang : (story?.originalLang || story?.language || 'en'),
      translationPending: !!(localized && localized.translationPending),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

module.exports = router;
