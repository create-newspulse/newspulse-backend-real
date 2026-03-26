const express = require('express');
const mongoose = require('mongoose');

// "Stories" in this backend map to the public Article model.
// If your frontend uses a different shape/model, tell me and I’ll swap it.
const Article = require('../models/Article');
const { getSlugCandidates } = require('../lib/slug');
const { ensureOnDemandArticleTranslation, normalizeLang, detectLangFromContent, hasFullTranslation } = require('../services/articleTranslation.service');
const { isGoogleTranslateConfigured } = require('../services/translationEnabled');
const {
  buildPubliclyVisiblePublicArticleFilter,
  getArticleBaseLocale,
  getAvailableArticleLocales,
} = require('../services/publicArticleVisibility.service');
const {
  normalizeLocale,
  getRequestedLocale,
  parseAllowFallback,
  getStoryGroupId,
  localizeDocStrict,
} = require('../services/publicStoryLocale.service');
const {
  buildLocaleEligibilityMatch,
  dedupeLocalizedByStoryGroup,
  removeInternalPublicFields,
} = require('../services/publicStoryGroupResolver.service');

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
      {
        $or: [
          { [`translationStatus.${desired}`]: 'ready' },
          { [`translationStatus.${desired}`]: null },
          { [`translationStatus.${desired}`]: { $exists: false } },
        ],
      },
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

// GET: /api/public/stories?category=&lang=&limit=20&page=1
router.get('/stories', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const { category, limit = 20, page = 1 } = req.query;

    const explicitLangRaw = (req.query.lang || req.query.language || '').toString().trim();
    if (explicitLangRaw && !normalizeLocale(explicitLangRaw)) {
      return res.status(400).json({ success: false, message: 'Invalid lang. Expected en|hi|gu' });
    }

    const requestedLocale = getRequestedLocale(req, { defaultLocale: 'en' });
    const fallbackTo = parseAllowFallback(req);

    if (!isDbConnected()) {
      return res.json({ success: true, data: [], message: 'Database unavailable' });
    }

    const q = buildPubliclyVisiblePublicArticleFilter();
    if (category) q.category = String(category);

    const eligibility = buildLocaleEligibilityMatch(requestedLocale) || (() => {
      const originalMatch = buildOriginalLangMatch(requestedLocale);
      const readyMatch = buildReadyTranslationMatch(requestedLocale);
      return { $or: [originalMatch, readyMatch].filter(Boolean) };
    })();

    q.$and = Array.isArray(q.$and) ? q.$and : [];
    if (eligibility) q.$and.push(eligibility);

    const lim = Math.min(parseInt(limit, 10) || 20, 50);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * lim;

    const storiesRaw = await Article.find(q)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean();

    let stories = (storiesRaw || [])
      .map(withNormalizedImageUrl)
      .map((s) => localizeDocStrict(s, requestedLocale, {
        mode: 'list',
        fallbackTo,
        logger: console,
        logContext: { endpoint: 'GET /api/public/stories' },
      }))
      .filter(Boolean);

    stories = dedupeLocalizedByStoryGroup(stories).map(removeInternalPublicFields);

    return res.json({ success: true, data: stories });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

// GET: /api/public/stories/:slug
router.get('/stories/:slug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');

    const debugEnabled = String(process.env.DEBUG_PUBLIC_STORIES_DETAIL || process.env.DEBUG_PUBLIC_STORY_DETAIL || '').trim();
    const shouldDebug = debugEnabled === '1' || debugEnabled.toLowerCase() === 'true' || debugEnabled.toLowerCase() === 'yes';
    const debug = (event, payload) => {
      if (!shouldDebug) return;
      try {
        console.log('[public-stories][detail]', event, payload || {});
      } catch (_) {}
    };

    if (!isDbConnected()) {
      return res.status(200).json({ success: false, message: 'Database unavailable' });
    }

    const candidates = getSlugCandidates(req.params.slug);
    if (!candidates.length) {
      return res.status(400).json({ success: false, message: 'Missing slug' });
    }

    const explicitLangRaw = (req.query.lang || req.query.language || '').toString().trim();
    if (explicitLangRaw && !normalizeLocale(explicitLangRaw)) {
      return res.status(400).json({ success: false, message: 'Invalid lang. Expected en|hi|gu' });
    }

    const requestedLocale = getRequestedLocale(req, { defaultLocale: 'en' });
    const fallbackTo = parseAllowFallback(req);

    const slugFilter = candidates.length === 1 ? candidates[0] : { $in: candidates };

    // Flexible slug lookup: any locale slug can resolve the canonical story group.
    // Locale selection is handled AFTER lookup via localizeDocStrict().
    const anySlugClause = {
      $or: [
        { slug: slugFilter },
        { 'slugs.en': slugFilter },
        { 'slugs.hi': slugFilter },
        { 'slugs.gu': slugFilter },
      ],
    };

    const storyFilter = buildPubliclyVisiblePublicArticleFilter();
    storyFilter.$and = Array.isArray(storyFilter.$and) ? storyFilter.$and : [];
    storyFilter.$and.push(anySlugClause);

    const story = await Article.findOne(storyFilter)
      .sort({ publishedAt: -1, createdAt: -1, updatedAt: -1 })
      .lean();

    if (!story) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }

    debug('resolved_story', {
      requestedSlug: candidates[0] || null,
      requestedLocale,
      storyGroupId: getStoryGroupId(story),
    });

    const storyWithImageUrl = withNormalizedImageUrl(story);
    const availableLocales = getAvailableArticleLocales(story);
    const baseLocale = getArticleBaseLocale(story);

    const localized = localizeDocStrict(storyWithImageUrl, requestedLocale, {
      mode: 'detail',
      fallbackTo,
      logger: console,
      logContext: { endpoint: 'GET /api/public/stories/:slug' },
    });

    if (!localized) {
      return res.status(404).json({
        success: false,
        code: 'LOCALE_NOT_AVAILABLE',
        message: 'Story not available in requested language',
        requestedLang: requestedLocale,
        resolvedLang: baseLocale,
        translationPending: false,
        availableLocales,
      });
    }

    debug('localized', {
      storyGroupId: localized.storyGroupId || null,
      requestedLocale: localized.requestedLocale || null,
      returnedLocale: localized.selectedLocale || null,
      selectedVariant: localized.selectedVariant || null,
    });

    localized.locale = localized.selectedLocale || localized.resolvedLang || null;

    return res.json({
      success: true,
      data: withNormalizedImageUrl(removeInternalPublicFields(localized)),
      requestedLang: requestedLocale,
      resolvedLang: localized.selectedLocale,
      isTranslated: localized.selectedVariant !== 'original',
      translationPending: false,
      availableLocales,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err?.message || String(err) });
  }
});

module.exports = router;
