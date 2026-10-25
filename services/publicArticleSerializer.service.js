const { Types } = require('mongoose');
const { publicAuthorByline } = require('./authorByline.service');

const LANGUAGES = ['en', 'hi', 'gu'];
const PUBLIC_SCALARS = [
  '_id', 'id', 'articleId', 'status',
  'title', 'description', 'summary', 'excerpt', 'content', 'body',
  'slug', 'canonicalSlug', 'localizedSlug', 'canonicalDetailUrl', 'detailApiUrl',
  'localizedTitle', 'localizedContent', 'readMinutes', 'views',
  'category', 'editorialType', 'track', 'topic',
  'state', 'district', 'city', 'stateSlug',
  'lang', 'language', 'originalLang', 'sourceLanguage',
  'translationKey', 'translationGroupId', 'sourceArticleId', 'sourceNewsId',
  'requestedLang', 'resolvedLang', 'requestedLanguage', 'resolvedLanguage', 'locale', 'activeLang',
  'isTranslated', 'isFallback', 'translationPending',
  'provider', 'generatedAt', 'translationProvider', 'translationGeneratedAt',
  'imageUrl', 'imageURL', 'coverImageUrl', 'imageAlt', 'imageCaption',
  'publishedAt', 'publishAt', 'date', 'createdAt', 'updatedAt',
  'isBreaking', 'spotlightEnabled', 'spotlightPinned', 'spotlightPriority', 'spotlightExpiresAt',
  'source', 'sourceUrl', 'sourceName',
  'isSponsored', 'isSponsoredArticle', 'sponsorName', 'sponsorLabel', 'sponsorDisclosure',
  'sponsorCtaText', 'sponsorCtaUrl', 'sponsorDestinationUrl',
  'sponsorFeatureEligible', 'sponsorFeatureLinkedId',
  'resolvedSponsorCtaText', 'resolvedSponsorDestinationUrl', 'resolvedSponsorCtaSource',
];
const IMAGE_FIELDS = ['url', 'src', 'imageUrl', 'assetUrl', 'secureUrl', 'publicId', 'alt', 'altText', 'caption', 'width', 'height'];
const TRANSLATION_FIELDS = ['title', 'summary', 'content', 'provider', 'generatedAt'];
const AVAILABILITY_FIELDS = [
  'requestedLang', 'requestedLanguage', 'resolvedLang', 'resolvedLanguage',
  'isFallback', 'isTranslated', 'requestedLocalePublished', 'fallbackEnabled',
];

function scalar(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Types.ObjectId) return value.toHexString();
  return undefined;
}

function pickScalars(value, fields) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const field of fields) {
    const selected = scalar(value[field]);
    if (selected !== undefined) out[field] = selected;
  }
  return out;
}

function strings(value) {
  if (value === null) return null;
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : undefined;
}

function image(value) {
  return typeof value === 'string' ? value : pickScalars(value, IMAGE_FIELDS);
}

function translations(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out = {};
  for (const lang of LANGUAGES) {
    const bucket = value[lang];
    // Canonical news details use availability booleans; compatibility routes use content buckets.
    const selected = typeof bucket === 'boolean' ? bucket : pickScalars(bucket, TRANSLATION_FIELDS);
    if (selected !== undefined) out[lang] = selected;
  }
  return out;
}

function assign(out, key, value) {
  if (value !== undefined) out[key] = value;
}

function publicPulseDialogue(value) {
  const out = pickScalars(value, [
    'contributorId', 'dialogueFormat', 'series', 'seriesSlug', 'bylineDesignationOverride',
    'contributorDisclosure', 'editorNote', 'contributorDisclaimer', 'showAboutContributor',
    'contributorSlug', 'profileAvailable',
  ]);
  if (!out) return out;
  assign(out, 'bylineSnapshot', pickScalars(value.bylineSnapshot, ['name', 'designation', 'affiliation']));
  if (out.bylineSnapshot) {
    assign(out.bylineSnapshot, 'photo', image(value.bylineSnapshot.photo));
  }
  assign(out, 'contributor', pickScalars(value.contributor, [
    'id', 'name', 'canonicalName', 'publicDesignation', 'affiliation', 'shortBio', 'slug', 'website',
  ]));
  if (out.contributor) {
    assign(out.contributor, 'photo', image(value.contributor.photo));
    const links = value.contributor.socialLinks;
    if (links === null) out.contributor.socialLinks = null;
    if (links && typeof links === 'object' && !Array.isArray(links)) {
      out.contributor.socialLinks = Object.fromEntries(
        (links instanceof Map ? [...links] : Object.entries(links)).filter(([, url]) => typeof url === 'string')
      );
    }
  }
  return out;
}

// Response-only allowlist: never mutate the CMS document or use this before visibility/localization.
function serializePublicArticle(doc) {
  if (!doc) return doc;
  const source = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : doc;
  const out = pickScalars(source, PUBLIC_SCALARS);

  assign(out, 'slugs', pickScalars(source.slugs, LANGUAGES));
  assign(out, 'translations', translations(source.translations));
  assign(out, 'translationStatus', pickScalars(source.translationStatus, LANGUAGES));
  if (source.i18n === null) out.i18n = null;
  if (source.i18n && typeof source.i18n === 'object' && !Array.isArray(source.i18n)) {
    out.i18n = {};
    for (const field of ['title', 'summary', 'content']) {
      assign(out.i18n, field, pickScalars(source.i18n[field], LANGUAGES));
    }
  }
  for (const field of ['tags', 'stateTags', 'stateNames', 'externalUrls', 'embeds', 'availableLocales', 'publishedLocales']) {
    assign(out, field, strings(source[field]));
  }
  for (const field of ['coverImage', 'image', 'thumbnail']) assign(out, field, image(source[field]));
  for (const field of ['images', 'gallery']) {
    if (source[field] === null) out[field] = null;
    if (Array.isArray(source[field])) out[field] = source[field].map(image).filter(item => item !== undefined);
  }
  assign(out, 'geo', pickScalars(source.geo, ['state', 'district', 'city']));
  assign(out, 'location', typeof source.location === 'string' ? source.location : pickScalars(source.location, [
    'state', 'stateSlug', 'district', 'districtSlug', 'city', 'citySlug', 'country', 'isUT',
  ]));
  assign(out, 'seo', pickScalars(source.seo, ['metaTitle', 'metaDescription', 'canonicalUrl', 'socialDescription']));
  assign(out, 'translationAvailability', pickScalars(source.translationAvailability, AVAILABILITY_FIELDS));
  if (out.translationAvailability) {
    assign(out.translationAvailability, 'translations', translations(source.translationAvailability.translations));
    assign(out.translationAvailability, 'availableLocales', strings(source.translationAvailability.availableLocales));
    assign(out.translationAvailability, 'publishedLocales', strings(source.translationAvailability.publishedLocales));
  }
  assign(out, 'linkedSponsoredFeature', pickScalars(source.linkedSponsoredFeature, [
    'id', 'sponsorName', 'headline', 'ctaText', 'destinationUrl', 'isActive', 'comboCampaignIsActive',
    'linkedArticleId', 'linkedArticleSlug', 'linkedArticlePath',
  ]));
  assign(out, 'pulseDialogue', publicPulseDialogue(source.pulseDialogue));
  if (String(source.category || '').toLowerCase() !== 'pulse-dialogue') {
    assign(out, 'authorByline', publicAuthorByline(source.authorByline));
  }
  return out;
}

module.exports = { serializePublicArticle };
