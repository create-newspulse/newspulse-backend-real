const { localizeArticleForLang, normalizeLang } = require('./mapArticleForLang');

function _safeString(value) {
  return String(value || '').trim();
}

function _getSlugs(doc) {
  return doc && doc.slugs && typeof doc.slugs === 'object' && !Array.isArray(doc.slugs)
    ? doc.slugs
    : null;
}

function getPublicContentCanonicalSlug(doc) {
  const slugs = _getSlugs(doc);
  return _safeString(slugs?.en) || _safeString(doc?.slug) || _safeString(slugs?.hi) || _safeString(slugs?.gu) || '';
}

function getPublicContentGroupKey(doc) {
  const groupKey = _safeString(doc?.translationKey) || _safeString(doc?.translationGroupId);
  if (groupKey) return `group:${groupKey}`;

  const canonicalSlug = getPublicContentCanonicalSlug(doc);
  if (canonicalSlug) return `slug:${canonicalSlug}`;

  return `id:${_safeString(doc?._id)}`;
}

function getPublicContentLookup(doc) {
  return {
    groupKey: _safeString(doc?.translationKey) || _safeString(doc?.translationGroupId) || null,
    canonicalSlug: getPublicContentCanonicalSlug(doc) || null,
  };
}

function buildPublicContentSiblingOrClauses({ groupKeys, canonicalSlugs }) {
  const clauses = [];

  if (Array.isArray(groupKeys) && groupKeys.length) {
    clauses.push({ translationKey: { $in: groupKeys } });
    clauses.push({ translationGroupId: { $in: groupKeys } });
  }

  if (Array.isArray(canonicalSlugs) && canonicalSlugs.length) {
    clauses.push({ 'slugs.en': { $in: canonicalSlugs } });
    clauses.push({ slug: { $in: canonicalSlugs } });
  }

  return clauses;
}

function _toTimestamp(value) {
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function _baseLangForDoc(doc) {
  return normalizeLang(doc?.originalLang) || normalizeLang(doc?.lang || doc?.language) || 'en';
}

function _storedLangForDoc(doc) {
  return normalizeLang(doc?.language) || normalizeLang(doc?.lang) || normalizeLang(doc?.originalLang) || null;
}

function pickBestLocalizedGroupDoc(groupDocs, requestedLang, { fallbackToBase = false } = {}) {
  if (!Array.isArray(groupDocs) || !groupDocs.length) return null;

  const desired = normalizeLang(requestedLang);
  let best = null;

  for (const doc of groupDocs) {
    const targetLang = desired || _baseLangForDoc(doc);
    const mapped = localizeArticleForLang(doc, targetLang, {
      fallbackToBase,
      allowMissingStatus: true,
    });
    if (!mapped) continue;

    const storedLang = _storedLangForDoc(doc);
    let rank = 1;
    if (!desired) {
      rank = 2;
    } else if (storedLang === desired && mapped.resolvedLang === desired) {
      rank = 4;
    } else if (mapped.resolvedLang === desired) {
      rank = mapped.isTranslated ? 2 : 3;
    }

    const candidate = {
      doc,
      mapped,
      rank,
      publishedAt: _toTimestamp(doc?.publishedAt),
      createdAt: _toTimestamp(doc?.createdAt),
    };

    if (!best) {
      best = candidate;
      continue;
    }

    if (candidate.rank > best.rank) {
      best = candidate;
      continue;
    }

    if (candidate.rank === best.rank) {
      if (candidate.publishedAt > best.publishedAt) {
        best = candidate;
        continue;
      }
      if (candidate.publishedAt === best.publishedAt && candidate.createdAt > best.createdAt) {
        best = candidate;
      }
    }
  }

  return best;
}

module.exports = {
  getPublicContentGroupKey,
  getPublicContentLookup,
  buildPublicContentSiblingOrClauses,
  pickBestLocalizedGroupDoc,
};