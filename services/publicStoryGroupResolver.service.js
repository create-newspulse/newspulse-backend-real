const {
  normalizeLocale,
  getStoryGroupId,
  localizeDocStrict,
  stripHtmlToText,
} = require('./publicStoryLocale.service');

function _normalizeLangForDb(v) {
  const desired = normalizeLocale(v);
  if (!desired) return null;
  return desired;
}

function buildOriginalLangMatch(locale) {
  const desired = _normalizeLangForDb(locale);
  if (!desired) return null;
  const lower = desired;
  const upper = desired.toUpperCase();

  return {
    $or: [
      { originalLang: { $in: [lower, upper] } },
      // Backward compatibility: older docs may only have language/lang.
      {
        $and: [
          { $or: [{ originalLang: null }, { originalLang: { $exists: false } }] },
          { $or: [{ language: { $in: [lower, upper] } }, { lang: { $in: [lower, upper] } }] },
        ],
      },
    ],
  };
}

function buildReadyTranslationMatch(locale) {
  const desired = _normalizeLangForDb(locale);
  if (!desired) return null;

  return {
    $and: [
      {
        $or: [
          { [`translationStatus.${desired}`]: 'ready' },
          // Backward compatibility: some older docs have full buckets but missing status.
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

function buildReadyI18nMatch(locale) {
  const desired = _normalizeLangForDb(locale);
  if (!desired) return null;

  // Newer Article docs can store localized text under i18n.* maps.
  return {
    $and: [
      { [`i18n.title.${desired}`]: { $exists: true, $nin: [null, ''] } },
      { [`i18n.summary.${desired}`]: { $exists: true, $nin: [null, ''] } },
      { [`i18n.content.${desired}`]: { $exists: true, $nin: [null, ''] } },
    ],
  };
}

function buildLocaleEligibilityMatch(locale) {
  const desired = _normalizeLangForDb(locale);
  if (!desired) return null;

  const clauses = [
    buildOriginalLangMatch(desired),
    buildReadyTranslationMatch(desired),
    buildReadyI18nMatch(desired),
  ].filter(Boolean);

  return clauses.length ? { $or: clauses } : null;
}

function dedupeLocalizedByStoryGroup(items) {
  const bestByGroup = new Map();

  for (const it of items || []) {
    if (!it) continue;
    const key = it.storyGroupId || it.slug || String(it._id || '');
    const prev = bestByGroup.get(key);
    if (!prev) {
      bestByGroup.set(key, it);
      continue;
    }

    const prevOrig = prev.selectedVariant === 'original';
    const itOrig = it.selectedVariant === 'original';
    if (itOrig && !prevOrig) {
      bestByGroup.set(key, it);
      continue;
    }

    const prevT = prev.publishedAt
      ? new Date(prev.publishedAt).getTime()
      : (prev.createdAt ? new Date(prev.createdAt).getTime() : 0);

    const itT = it.publishedAt
      ? new Date(it.publishedAt).getTime()
      : (it.createdAt ? new Date(it.createdAt).getTime() : 0);

    if (itT > prevT) bestByGroup.set(key, it);
  }

  return Array.from(bestByGroup.values());
}

function stripListCardFields(localized) {
  if (!localized || typeof localized !== 'object') return localized;

  const out = { ...localized };
  if (typeof out.title === 'string') out.title = stripHtmlToText(out.title);
  if (typeof out.summary === 'string') out.summary = stripHtmlToText(out.summary);
  if (typeof out.description === 'string') out.description = stripHtmlToText(out.description);
  return out;
}

function removeInternalPublicFields(obj, options = {}) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };

  const keepGroupKeys =
    options && typeof options === 'object'
      ? Boolean(options.keepGroupKeys || options.keepTranslationKeys || options.keepTranslationKey)
      : false;

  // Public endpoints must never expose draft/internal status labels.
  try { delete out.status; } catch (_) {}

  // Do not expose translation grouping internals; clients should use storyGroupId.
  // (Keep _id + slug + slugs, since those are public identifiers.)
  if (!keepGroupKeys) {
    try { delete out.translationKey; } catch (_) {}
    try { delete out.translationGroupId; } catch (_) {}
  }

  return out;
}

function shouldDebugPublicStorySelection() {
  const s = String(process.env.DEBUG_PUBLIC_STORY_SELECTION || process.env.DEBUG_PUBLIC_STORYGROUP_SELECTION || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function logSelection(logger, event, payload) {
  if (!shouldDebugPublicStorySelection()) return;
  const l = logger && typeof logger === 'object' ? logger : console;
  try {
    l.info?.('[public][story-selection]', event, payload || {});
  } catch (_) {
    try { console.log('[public][story-selection]', event, payload || {}); } catch (_) {}
  }
}

function localizeAndShapeListItem(docLike, requestedLocale, { fallbackTo = null, logger = null, logContext = {} } = {}) {
  const storyGroupId = getStoryGroupId(docLike);

  const localized = localizeDocStrict(docLike, requestedLocale, {
    mode: 'list',
    fallbackTo,
    logger: logger || console,
    logContext: { storyGroupId, ...logContext },
  });

  if (!localized) {
    logSelection(logger || console, 'skipped', {
      storyGroupId,
      requestedLocale,
      reason: 'no_locale_variant',
      ...logContext,
    });
    return null;
  }

  logSelection(logger || console, 'selected', {
    storyGroupId: localized.storyGroupId || storyGroupId || null,
    requestedLocale: localized.requestedLocale || requestedLocale || null,
    selectedLocale: localized.selectedLocale || null,
    selectedVariant: localized.selectedVariant || null,
    category: localized.category || null,
    ...logContext,
  });

  return removeInternalPublicFields(stripListCardFields(localized));
}

module.exports = {
  buildOriginalLangMatch,
  buildReadyTranslationMatch,
  buildReadyI18nMatch,
  buildLocaleEligibilityMatch,
  dedupeLocalizedByStoryGroup,
  localizeAndShapeListItem,
  removeInternalPublicFields,
  logSelection,
  shouldDebugPublicStorySelection,
};
