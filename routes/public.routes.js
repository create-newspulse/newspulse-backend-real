const express = require('express');
const mongoose = require('mongoose');

// "Stories" in this backend map to the public Article model.
// If your frontend uses a different shape/model, tell me and I’ll swap it.
const Article = require('../models/Article');
const { getSlugCandidates } = require('../lib/slug');
const { ensureOnDemandArticleTranslation, normalizeLang, detectLangFromContent, hasFullTranslation } = require('../services/articleTranslation.service');
const { isGoogleTranslateConfigured } = require('../services/translationEnabled');

const router = express.Router();

function isDbConnected() {
  // 1 = connected
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function buildOriginalLangMatch(lang) {
  const desired = normalizeLang(lang);
  if (!desired) return null;
  const lower = desired;
  const upper = desired.toUpperCase();
  return {
    $or: [
      { originalLang: { $in: [lower, upper] } },
      // Backward compatibility: older docs may only have `language`.
      {
        $and: [
          { $or: [{ originalLang: null }, { originalLang: { $exists: false } }] },
          { language: { $in: [lower, upper] } },
        ],
      },
    ],
  };
}

function buildReadyTranslationMatch(lang) {
  const desired = normalizeLang(lang);
  if (!desired) return null;
  return {
    $and: [
      { [`translationStatus.${desired}`]: 'ready' },
      { [`translations.${desired}.title`]: { $exists: true, $nin: [null, ''] } },
      { [`translations.${desired}.summary`]: { $exists: true, $nin: [null, ''] } },
      { [`translations.${desired}.content`]: { $exists: true, $nin: [null, ''] } },
    ],
  };
}

function applyCachedTranslationToStory(story, desiredLang) {
  const desired = normalizeLang(desiredLang);
  if (!desired || !story) return story;

  const base = normalizeLang(story.originalLang) || normalizeLang(story.language) || detectLangFromContent(story.content) || 'en';
  if (base === desired) {
    return { ...story, language: desired };
  }

  const status = story?.translationStatus?.[desired] || null;
  const bucket = story?.translations?.[desired];
  const ok = status === 'ready' && hasFullTranslation(bucket);
  if (!ok) return story;

  return {
    ...story,
    title: bucket.title,
    summary: bucket.summary,
    content: bucket.content,
    language: desired,
  };
}

function _normalizeImageUrlCandidate(v) {
  if (v === null || v === undefined) return null;

  if (typeof v === 'string') {
    const s = v.trim();
    return s ? s : null;
  }

  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const url = v.url ?? v.src ?? null;
    if (typeof url === 'string') {
      const s = url.trim();
      return s ? s : null;
    }
  }

  return null;
}

function withNormalizedImageUrl(story) {
  if (!story || typeof story !== 'object') return story;

  const imageUrl =
    _normalizeImageUrlCandidate(story.imageUrl) ||
    _normalizeImageUrlCandidate(story.coverImageUrl) ||
    _normalizeImageUrlCandidate(story.coverImage) ||
    _normalizeImageUrlCandidate(story.image) ||
    _normalizeImageUrlCandidate(story.thumbnail) ||
    _normalizeImageUrlCandidate(Array.isArray(story.images) ? story.images[0] : null) ||
    null;

  return { ...story, imageUrl };
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

    const desired = normalizeLang(lang);
    if (desired === 'gu') {
      // Legacy behavior: Gujarati feed shows Gujarati originals immediately.
      q.language = 'gu';
    } else if (desired === 'hi' || desired === 'en') {
      // Hindi/English feeds:
      // - include originals authored in that language, OR
      // - include stories with fully-ready cached translations for that language.
      const originalMatch = buildOriginalLangMatch(desired);
      const readyMatch = buildReadyTranslationMatch(desired);
      q.$or = [originalMatch, readyMatch].filter(Boolean);
    } else if (lang) {
      // Backward compatible: if a non-standard lang was provided, keep old behavior.
      q.language = String(lang);
    }

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * lim;

    let stories = await Article.find(q)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean();

    if (desired === 'hi' || desired === 'en') {
      stories = (stories || []).map((s) => applyCachedTranslationToStory(s, desired));
    }

    stories = (stories || []).map(withNormalizedImageUrl);

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

    const storyWithImageUrl = withNormalizedImageUrl(story);

    const langQueryRaw = (req.query.lang || req.query.language || '').toString().trim();
    if (!langQueryRaw) {
      return res.json({ success: true, data: storyWithImageUrl });
    }

    const desired = normalizeLang(langQueryRaw);
    if (!desired) {
      return res.json({ success: true, data: storyWithImageUrl });
    }

    const source = normalizeLang(story?.originalLang) || detectLangFromContent(story?.content) || normalizeLang(story?.language) || 'en';
    const existingBucket = story?.translations?.[desired];
    const hasAll = hasFullTranslation(existingBucket);
    const now = new Date();

    // No translation needed (always serve original fields).
    if (desired === source) {
      const localized = await ensureOnDemandArticleTranslation({
        article: story,
        requestedLang: langQueryRaw,
        logger: console,
        lockOwner: false,
        now,
      });

      if (localized && localized.dbSet && story && story._id) {
        try {
          await Article.updateOne({ _id: story._id }, { $set: localized.dbSet }).catch(() => null);
        } catch (_) {}
      }

      return res.json({
        success: true,
        data: localized && localized.out ? withNormalizedImageUrl(localized.out) : storyWithImageUrl,
        resolvedLang: source,
        translationPending: false,
      });
    }

    // If translation is disabled or misconfigured, only serve cached full translations; never attempt a lock/translate.
    if (!isGoogleTranslateConfigured() && !hasAll) {
      const localized = await ensureOnDemandArticleTranslation({
        article: story,
        requestedLang: langQueryRaw,
        logger: console,
        lockOwner: false,
        now,
      });

      if (localized && localized.dbSet && story && story._id) {
        try {
          await Article.updateOne({ _id: story._id }, { $set: localized.dbSet }).catch(() => null);
        } catch (_) {}
      }

      return res.json({
        success: true,
        data: localized && localized.out ? withNormalizedImageUrl(localized.out) : storyWithImageUrl,
        resolvedLang: localized && localized.resolvedLang ? localized.resolvedLang : source,
        translationPending: false,
      });
    }

    // If translation is needed and missing, acquire an atomic pending lock to avoid stampede.
    let lockOwner = false;
    if (desired !== source && !hasAll) {
      const status = story?.translationStatus?.[desired] || null;
      const retryAtRaw = story?.translationNextRetryAt?.[desired] || null;
      const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;

      if (status === 'pending' || (status === 'failed' && retryAt && now < retryAt)) {
        return res.json({
          success: true,
          data: storyWithImageUrl,
          resolvedLang: source,
          translationPending: true,
        });
      }

      try {
        const lockRes = await Article.updateOne(
          {
            _id: story._id,
            $and: [
              { [`translationStatus.${desired}`]: { $ne: 'pending' } },
              {
                $or: [
                  { [`translationStatus.${desired}`]: { $ne: 'failed' } },
                  { [`translationNextRetryAt.${desired}`]: { $exists: false } },
                  { [`translationNextRetryAt.${desired}`]: null },
                  { [`translationNextRetryAt.${desired}`]: { $lte: now } },
                ],
              },
            ],
          },
          {
            $set: {
              [`translationStatus.${desired}`]: 'pending',
              [`translationError.${desired}`]: null,
              [`translationNextRetryAt.${desired}`]: null,
            },
          }
        );

        const modified = typeof lockRes?.modifiedCount === 'number'
          ? lockRes.modifiedCount
          : (typeof lockRes?.nModified === 'number' ? lockRes.nModified : 0);
        lockOwner = modified === 1;
      } catch (_) {
        lockOwner = false;
      }

      if (!lockOwner) {
        return res.json({
          success: true,
          data: storyWithImageUrl,
          resolvedLang: source,
          translationPending: true,
        });
      }
    }

    const localized = await ensureOnDemandArticleTranslation({
      article: story,
      requestedLang: langQueryRaw,
      logger: console,
      lockOwner,
      now,
    });

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
      data: localized && localized.out ? withNormalizedImageUrl(localized.out) : storyWithImageUrl,
      resolvedLang: localized && localized.resolvedLang ? localized.resolvedLang : (story?.originalLang || story?.language || 'en'),
      translationPending: !!(localized && localized.translationPending),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

module.exports = router;
