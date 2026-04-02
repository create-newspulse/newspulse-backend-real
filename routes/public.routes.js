const express = require('express');
const mongoose = require('mongoose');

// "Stories" in this backend map to the public Article model.
// If your frontend uses a different shape/model, tell me and I’ll swap it.
const Article = require('../models/Article');
const { buildPublicCategoryFilter, getCanonicalPublicCategoryKey } = require('../lib/categories');
const { getSlugCandidates } = require('../lib/slug');
const { ensureOnDemandArticleTranslation, normalizeLang, detectLangFromContent, hasFullTranslation } = require('../services/articleTranslation.service');
const { localizeArticleForLang } = require('../services/mapArticleForLang');
const { isGoogleTranslateConfigured } = require('../services/translationEnabled');
const {
  buildPubliclyVisiblePublicArticleFilter,
  getArticleBaseLocale,
  getAvailableArticleLocales,
} = require('../services/publicArticleVisibility.service');
const {
  getPublicContentGroupKey,
  getPublicContentLookup,
  buildPublicContentSiblingOrClauses,
  pickBestLocalizedGroupDoc,
} = require('../services/publicCategoryListing.service');

const router = express.Router();

function isAutoTranslateOnReadEnabled() {
  const s = String(process.env.ENABLE_AUTO_TRANSLATE_ON_READ ?? '').trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'y';
}

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
  const ok = (status === 'ready' || status === null) && hasFullTranslation(bucket);
  if (!ok) return story;

  return {
    ...story,
    title: bucket.title,
    summary: bucket.summary,
    content: bucket.content,
    language: desired,
  };
}

function applyBestAvailableCachedTranslationToStory(story, requestedLang) {
  const requested = normalizeLang(requestedLang);
  if (!story) return { story, resolvedLang: null, translated: false };

  const base = normalizeLang(story.originalLang) || normalizeLang(story.language) || detectLangFromContent(story.content) || 'en';
  const ordered = [requested, 'en', 'hi', 'gu', base].filter(Boolean);
  const seen = new Set();

  for (const l of ordered) {
    if (!l || seen.has(l)) continue;
    seen.add(l);
    if (l === base) {
      return { story: { ...story, language: base }, resolvedLang: base, translated: false };
    }
    const candidate = applyCachedTranslationToStory(story, l);
    if (candidate && candidate !== story && normalizeLang(candidate.language) === l) {
      return { story: candidate, resolvedLang: l, translated: true };
    }
  }

  return { story: { ...story, language: base }, resolvedLang: base, translated: false };
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

function logPublicStoriesCategoryDebug(payload) {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') return;
  try {
    console.log('[public.stories.category][debug]', payload);
  } catch (_) {}
}

// GET: /api/public/stories?category=&lang=&limit=20&page=1
router.get('/stories', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const { category, limit = 20, page = 1 } = req.query;

    // Prefer explicit query lang, otherwise use negotiated language (e.g. header x-lang).
    // Keep backward-compat behavior for non-standard explicit query values.
    const explicitLangRaw = (req.query.lang || req.query.language || '').toString().trim();
    const negotiatedLangRaw = explicitLangRaw || (req.lang || '');

    if (!isDbConnected()) {
      return res.json({ success: true, data: [], message: 'Database unavailable' });
    }

    const q = buildPubliclyVisiblePublicArticleFilter();
    const isGroupedCategoryListing = Boolean(category);
    if (category) q.category = buildPublicCategoryFilter(category);

    const desired = normalizeLang(negotiatedLangRaw);
    const normalizedCategoryKey = category ? getCanonicalPublicCategoryKey(category) : null;
    if (!isGroupedCategoryListing && desired === 'gu') {
      // Legacy behavior: Gujarati feed shows Gujarati originals immediately.
      q.language = 'gu';
    } else if (!isGroupedCategoryListing && (desired === 'hi' || desired === 'en')) {
      // Hindi/English feeds:
      // - include originals authored in that language, OR
      // - include stories with fully-ready cached translations for that language.
      const originalMatch = buildOriginalLangMatch(desired);
      const readyMatch = buildReadyTranslationMatch(desired);
      q.$or = [originalMatch, readyMatch].filter(Boolean);
    } else if (!isGroupedCategoryListing && explicitLangRaw) {
      // Backward compatible: if a non-standard lang was provided, keep old behavior.
      q.language = String(explicitLangRaw);
    }

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * lim;

    let stories = [];
    if (isGroupedCategoryListing) {
      const groupedRequestedLang = desired || 'en';
      const matchedStories = await Article.find(q)
        .sort({ publishedAt: -1, createdAt: -1 })
        .lean();

      const lookups = (matchedStories || []).map((story) => getPublicContentLookup(story));
      const groupKeys = Array.from(new Set(lookups.map((entry) => entry.groupKey).filter(Boolean)));
      const canonicalSlugs = Array.from(new Set(
        lookups
          .filter((entry) => !entry.groupKey && entry.canonicalSlug)
          .map((entry) => entry.canonicalSlug)
      ));

      let siblingStories = [];
      const siblingClauses = buildPublicContentSiblingOrClauses({ groupKeys, canonicalSlugs });
      if (siblingClauses.length) {
        const siblingBaseQuery = buildPubliclyVisiblePublicArticleFilter();
        const siblingQuery = {
          ...siblingBaseQuery,
          $and: [
            ...(Array.isArray(siblingBaseQuery.$and) ? siblingBaseQuery.$and : []),
            { $or: siblingClauses },
          ],
        };
        siblingStories = await Article.find(siblingQuery)
          .sort({ publishedAt: -1, createdAt: -1 })
          .lean();
      }

      const groupedStories = new Map();
      for (const story of [...(matchedStories || []), ...(siblingStories || [])]) {
        const key = getPublicContentGroupKey(story);
        if (!groupedStories.has(key)) groupedStories.set(key, []);
        groupedStories.get(key).push(story);
      }

      const includedKeys = Array.from(new Set((matchedStories || []).map((story) => getPublicContentGroupKey(story))));
      stories = includedKeys
        .map((key) => {
          const picked = pickBestLocalizedGroupDoc(groupedStories.get(key) || [], groupedRequestedLang, { fallbackToBase: true });
          if (!picked) return null;

          const baseStory = withNormalizedImageUrl(picked.doc);
          const mapped = picked.mapped;
          return {
            ...baseStory,
            title: mapped.title,
            summary: mapped.summary,
            content: mapped.content,
            slug: mapped.slug,
            canonicalSlug: mapped.canonicalSlug,
            language: mapped.lang,
            requestedLang: mapped.requestedLang,
            resolvedLang: mapped.resolvedLang,
            isTranslated: mapped.isTranslated,
            __sortPublishedAt: new Date(baseStory.publishedAt || 0).getTime() || 0,
            __sortCreatedAt: new Date(baseStory.createdAt || 0).getTime() || 0,
          };
        })
        .filter(Boolean)
        .sort((left, right) => {
          if (right.__sortPublishedAt !== left.__sortPublishedAt) return right.__sortPublishedAt - left.__sortPublishedAt;
          return right.__sortCreatedAt - left.__sortCreatedAt;
        })
        .slice(skip, skip + lim)
        .map((story) => {
          try {
            delete story.__sortPublishedAt;
            delete story.__sortCreatedAt;
          } catch (_) {}
          return story;
        });

      logPublicStoriesCategoryDebug({
        requestedLocale: groupedRequestedLang,
        requestedCategorySlug: category || null,
        normalizedCategoryKey: normalizedCategoryKey || category || null,
        matchedTranslationGroupIds: groupKeys,
        returnedArticles: stories.map((story) => ({
          id: String(story._id || ''),
          language: String(story.language || ''),
          translationGroupId: String(story.translationKey || story.translationGroupId || ''),
        })),
      });
    } else {
      stories = await Article.find(q)
        .sort({ publishedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .lean();

      if (desired === 'hi' || desired === 'en') {
        stories = (stories || []).map((s) => applyCachedTranslationToStory(s, desired));
      }

      stories = (stories || []).map(withNormalizedImageUrl);
    }

    return res.json({ success: true, data: stories });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// GET: /api/public/stories/:slug
router.get('/stories/:slug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    if (!isDbConnected()) {
      return res.status(200).json({ success: false, message: 'Database unavailable' });
    }

    const candidates = getSlugCandidates(req.params.slug);
    if (!candidates.length) {
      return res.status(400).json({ success: false, message: 'Missing slug' });
    }

    const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };
    const storyFilter = {
      ...buildPubliclyVisiblePublicArticleFilter(),
      $or: [
        { slug: slugFilter },
        { 'slugs.en': slugFilter },
        { 'slugs.hi': slugFilter },
        { 'slugs.gu': slugFilter },
      ],
    };
    const story = await Article.findOne(storyFilter).lean();
    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }

    const storyWithImageUrl = withNormalizedImageUrl(story);

    const langQueryRaw = (req.query.lang || req.query.language || req.lang || '').toString().trim();
    const desired = normalizeLang(langQueryRaw);

    const source = getArticleBaseLocale(story);
    const availableLocales = getAvailableArticleLocales(story);

    if (!langQueryRaw || !desired) {
      return res.json({
        success: true,
        data: storyWithImageUrl,
        resolvedLang: source,
        availableLocales,
      });
    }

    const existingBucket = story?.translations?.[desired];
    const hasAll = hasFullTranslation(existingBucket);
    const now = new Date();

    // Strict language contract:
    // - Never silently fall back to a different language when a lang is requested.
    // - Only return 200 when we can serve the requested language.
    if (desired === source) {
      const localized = await ensureOnDemandArticleTranslation({
        article: story,
        requestedLang: source,
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
        requestedLang: desired,
        resolvedLang: source,
        isTranslated: false,
        translationPending: false,
        availableLocales,
      });
    }

    // Cached translation available.
    if (hasAll) {
      const status = story?.translationStatus?.[desired] ?? null;
      if (status === 'ready' || status === null) {
        const localized = applyCachedTranslationToStory(storyWithImageUrl, desired);
        return res.json({
          success: true,
          data: withNormalizedImageUrl(localized),
          requestedLang: desired,
          resolvedLang: desired,
          isTranslated: true,
          translationPending: false,
          availableLocales,
        });
      }
    }

    const shouldAutoTranslate = isAutoTranslateOnReadEnabled();
    if (!shouldAutoTranslate || (!isGoogleTranslateConfigured() && !hasAll)) {
      return res.status(404).json({
        success: false,
        code: 'LOCALE_NOT_AVAILABLE',
        message: 'Story not available in requested language',
        requestedLang: desired,
        resolvedLang: source,
        translationPending: false,
        availableLocales,
      });
    }

    // If translation is needed and missing, acquire an atomic pending lock to avoid stampede.
    let lockOwner = false;
    if (desired !== source && !hasAll) {
      const status = story?.translationStatus?.[desired] || null;
      const retryAtRaw = story?.translationNextRetryAt?.[desired] || null;
      const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;

      if (status === 'pending' || (status === 'failed' && retryAt && now < retryAt)) {
        return res.status(404).json({
          success: false,
          code: 'LOCALE_NOT_AVAILABLE',
          message: 'Story not available in requested language',
          requestedLang: desired,
          resolvedLang: source,
          translationPending: true,
          availableLocales,
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
        return res.status(404).json({
          success: false,
          code: 'LOCALE_NOT_AVAILABLE',
          message: 'Story not available in requested language',
          requestedLang: desired,
          resolvedLang: source,
          translationPending: true,
          availableLocales,
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

    if (localized && localized.translationPending) {
      return res.status(404).json({
        success: false,
        code: 'LOCALE_NOT_AVAILABLE',
        message: 'Story not available in requested language',
        requestedLang: desired,
        resolvedLang: source,
        translationPending: true,
        availableLocales: getAvailableArticleLocales(localized && localized.out ? localized.out : story),
      });
    }

    const resolvedLang = localized && localized.resolvedLang ? localized.resolvedLang : source;
    if (resolvedLang !== desired) {
      return res.status(404).json({
        success: false,
        code: 'LOCALE_NOT_AVAILABLE',
        message: 'Story not available in requested language',
        requestedLang: desired,
        resolvedLang,
        translationPending: false,
        availableLocales: getAvailableArticleLocales(localized && localized.out ? localized.out : story),
      });
    }

    return res.json({
      success: true,
      data: localized && localized.out ? withNormalizedImageUrl(localized.out) : storyWithImageUrl,
      requestedLang: desired,
      resolvedLang: desired,
      isTranslated: true,
      translationPending: false,
      availableLocales: getAvailableArticleLocales(localized && localized.out ? localized.out : story),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

module.exports = router;
