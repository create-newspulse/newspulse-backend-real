const mongoose = require('mongoose');
const { slugifyUnicode } = require('../lib/slug');

const PULSE_DIALOGUE_CATEGORY = 'pulse-dialogue';

const CONTRIBUTOR_STATUS_VALUES = ['draft', 'active', 'inactive'];
const CONTRIBUTOR_TYPE_VALUES = [
  'columnist',
  'guest_columnist',
  'guest_contributor',
  'author',
  'scholar_academic',
  'researcher',
  'subject_expert',
  'journalist',
  'writer',
  'poet_literary_writer',
  'public_intellectual',
  'industry_expert',
];
const DIALOGUE_FORMAT_VALUES = [
  'column',
  'guest_column',
  'essay',
  'viewpoint',
  'conversation',
  'interview',
  'literary_essay',
  'culture_ideas',
  'expert_perspective',
  'open_letter',
];

const PULSE_DIALOGUE_STANDARD_TEXT_BY_LANGUAGE = Object.freeze({
  en: Object.freeze({
    contributorDisclosure: 'This article is a contributor submission published after editorial review by News Pulse.',
    contributorDisclaimer: 'The views expressed in this contribution are those of the author and do not necessarily reflect the views of News Pulse.',
  }),
  hi: Object.freeze({
    contributorDisclosure: "यह लेख 'न्यूज़ पल्स' द्वारा संपादकीय समीक्षा के बाद प्रकाशित एक प्रस्तुति है।",
    contributorDisclaimer: "इसमें व्यक्त किए गए विचार लेखक के हैं और ज़रूरी नहीं कि वे 'न्यूज़ पल्स' के विचारों को दर्शाते हों।",
  }),
  gu: Object.freeze({
    contributorDisclosure: 'આ લેખ ન્યૂઝ પલ્સની સંપાદકીય સમીક્ષા બાદ વાચકો સમક્ષ પ્રસ્તુત કરવામાં આવ્યો છે',
    contributorDisclaimer: 'આ લેખમાં વ્યક્ત કરાયેલા વિચારો લેખકના વ્યક્તિગત અભિપ્રાયો છે અને ન્યૂઝ પલ્સ તેની સાથે સહમત હોય તે જરૂરી નથી.',
  }),
});

function normalizePulseDialogueLanguage(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';
  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (['en', 'hi', 'gu'].includes(primary)) return primary;
  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj' || lettersOnly === 'gj') return 'gu';
  return null;
}

function getPulseDialogueStandardText(language = 'en') {
  const lang = normalizePulseDialogueLanguage(language) || 'en';
  return { ...PULSE_DIALOGUE_STANDARD_TEXT_BY_LANGUAGE[lang] };
}

function applyPulseDialogueStandardText(pulseDialogue, language = 'en') {
  if (!isPlainObject(pulseDialogue)) return pulseDialogue;
  return {
    ...pulseDialogue,
    ...getPulseDialogueStandardText(language),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNullableString(value, { maxLength = 4000 } = {}) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return maxLength && text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeBoolean(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return Boolean(value);
}

function normalizeEnum(value, allowedValues) {
  if (value === undefined) return undefined;
  const text = normalizeNullableString(value, { maxLength: 80 });
  if (text === null) return null;
  return allowedValues.includes(text) ? text : undefined;
}

function normalizeObjectId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;
  return mongoose.Types.ObjectId.isValid(text) ? text : undefined;
}

function normalizePhoto(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'string') {
    const url = normalizeNullableString(value, { maxLength: 2048 });
    return url ? { url, publicId: null, alt: null } : null;
  }
  if (!isPlainObject(value)) return null;
  const url = normalizeNullableString(value.url || value.assetUrl || value.secureUrl, { maxLength: 2048 });
  const publicId = normalizeNullableString(value.publicId || value.storageId, { maxLength: 512 });
  const alt = normalizeNullableString(value.alt || value.altText, { maxLength: 300 });
  if (!url && !publicId && !alt) return null;
  return { url: url || null, publicId: publicId || null, alt: alt || null };
}

function normalizeSocialLinks(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return {};
  if (value instanceof Map) return normalizeSocialLinks(Object.fromEntries(value.entries()));
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!safeKey) continue;
    const safeValue = normalizeNullableString(raw, { maxLength: 2048 });
    if (safeValue) out[safeKey] = safeValue;
  }
  return out;
}

function normalizeRightsConsent(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return {};
  if (!isPlainObject(value)) return {};
  return {
    publicationRightsConfirmed: Boolean(value.publicationRightsConfirmed),
    profileConsentConfirmed: Boolean(value.profileConsentConfirmed),
    photoUsagePermissionConfirmed: Boolean(value.photoUsagePermissionConfirmed),
    disclosureReviewed: Boolean(value.disclosureReviewed),
    notes: normalizeNullableString(value.notes, { maxLength: 4000 }) || null,
  };
}

function normalizeContributorPayload(body, { partial = false } = {}) {
  const input = isPlainObject(body) ? body : {};
  const out = {};
  const fields = [
    ['canonicalName', 200],
    ['displayNameHi', 200],
    ['displayNameGu', 200],
    ['publicDesignation', 300],
    ['affiliation', 300],
    ['shortBio', 1000],
    ['location', 200],
    ['slug', 160],
    ['website', 2048],
    ['internalEmail', 320],
    ['internalNotes', 4000],
  ];

  for (const [field, maxLength] of fields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      out[field] = normalizeNullableString(input[field], { maxLength });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'photo')) out.photo = normalizePhoto(input.photo);
  if (Object.prototype.hasOwnProperty.call(input, 'socialLinks')) out.socialLinks = normalizeSocialLinks(input.socialLinks);
  if (Object.prototype.hasOwnProperty.call(input, 'rightsConsent')) out.rightsConsent = normalizeRightsConsent(input.rightsConsent);

  if (Object.prototype.hasOwnProperty.call(input, 'status')) {
    const status = normalizeEnum(input.status, CONTRIBUTOR_STATUS_VALUES);
    if (status === undefined) return { ok: false, status: 400, message: 'Invalid contributor status' };
    out.status = status || 'draft';
  } else if (!partial) {
    out.status = 'draft';
  }

  if (Object.prototype.hasOwnProperty.call(input, 'contributorType')) {
    const contributorType = normalizeEnum(input.contributorType, CONTRIBUTOR_TYPE_VALUES);
    if (contributorType === undefined) return { ok: false, status: 400, message: 'Invalid contributorType' };
    out.contributorType = contributorType;
  }

  if (!partial && !out.canonicalName) {
    return { ok: false, status: 400, message: 'canonicalName is required' };
  }

  if (!partial && !out.slug && out.canonicalName) {
    out.slug = slugifyUnicode(out.canonicalName, { maxLength: 120 });
  }

  return { ok: true, value: out };
}

function pickContributorDisplayName(contributor, language) {
  const lang = String(language || '').trim().toLowerCase();
  if (lang === 'hi' && contributor?.displayNameHi) return contributor.displayNameHi;
  if (lang === 'gu' && contributor?.displayNameGu) return contributor.displayNameGu;
  return contributor?.canonicalName || contributor?.name || '';
}

function buildPublicContributor(contributor, language) {
  if (!contributor) return null;
  const source = typeof contributor.toObject === 'function' ? contributor.toObject({ virtuals: true }) : contributor;
  const displayName = pickContributorDisplayName(source, language);
  return {
    id: source._id ? String(source._id) : (source.id ? String(source.id) : null),
    name: displayName || null,
    canonicalName: source.canonicalName || null,
    photo: normalizePhoto(source.photo) || null,
    publicDesignation: source.publicDesignation || null,
    affiliation: source.affiliation || null,
    shortBio: source.shortBio || null,
    slug: source.slug || null,
    website: source.website || null,
    socialLinks: normalizeSocialLinks(source.socialLinks) || {},
  };
}

function buildBylineSnapshot(contributor, language, overrideDesignation) {
  const publicContributor = buildPublicContributor(contributor, language);
  if (!publicContributor) return null;
  const designation = normalizeNullableString(overrideDesignation, { maxLength: 300 });
  return {
    name: publicContributor.name || publicContributor.canonicalName || null,
    designation: designation !== undefined && designation !== null ? designation : (publicContributor.publicDesignation || null),
    affiliation: publicContributor.affiliation || null,
    photo: publicContributor.photo || null,
  };
}

function normalizeBylineSnapshot(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (!isPlainObject(value)) return null;
  return {
    name: normalizeNullableString(value.name, { maxLength: 200 }) || null,
    designation: normalizeNullableString(value.designation, { maxLength: 300 }) || null,
    affiliation: normalizeNullableString(value.affiliation, { maxLength: 300 }) || null,
    photo: normalizePhoto(value.photo) || null,
  };
}

function normalizePulseDialoguePayload(body, { category, partial = false } = {}) {
  const categoryNorm = String(category || '').trim().toLowerCase();
  const hasPayload = isPlainObject(body) && Object.prototype.hasOwnProperty.call(body, 'pulseDialogue');
  if (categoryNorm !== PULSE_DIALOGUE_CATEGORY) {
    return { ok: true, value: undefined };
  }
  if (!hasPayload) return { ok: true, value: undefined };

  const input = isPlainObject(body.pulseDialogue) ? body.pulseDialogue : {};
  const out = {};
  const contributorId = normalizeObjectId(input.contributorId);
  if (contributorId === undefined) return { ok: false, status: 400, message: 'pulseDialogue.contributorId must be a valid id' };
  if (contributorId !== null) out.contributorId = contributorId;

  const dialogueFormat = normalizeEnum(input.dialogueFormat, DIALOGUE_FORMAT_VALUES);
  if (dialogueFormat === undefined && input.dialogueFormat !== undefined) {
    return { ok: false, status: 400, message: 'Invalid pulseDialogue.dialogueFormat' };
  }
  if (dialogueFormat !== undefined && dialogueFormat !== null) out.dialogueFormat = dialogueFormat;

  const textFields = [
    ['series', 200],
    ['bylineDesignationOverride', 300],
    ['contributorDisclosure', 1000],
    ['editorNote', 1000],
    ['contributorDisclaimer', 1000],
  ];
  for (const [field, maxLength] of textFields) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      out[field] = normalizeNullableString(input[field], { maxLength });
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, 'showAboutContributor')) {
    out.showAboutContributor = Boolean(normalizeBoolean(input.showAboutContributor));
  }
  if (Object.prototype.hasOwnProperty.call(input, 'bylineSnapshot')) {
    const snapshot = normalizeBylineSnapshot(input.bylineSnapshot);
    if (snapshot) out.bylineSnapshot = snapshot;
  }

  if (!partial && !Object.keys(out).length) return { ok: true, value: {} };
  return { ok: true, value: out };
}

function normalizePublicPulseDialogue(value) {
  if (!isPlainObject(value)) return undefined;
  const out = {};
  if (value.contributorId) out.contributorId = String(value.contributorId);
  if (value.dialogueFormat && DIALOGUE_FORMAT_VALUES.includes(String(value.dialogueFormat))) out.dialogueFormat = String(value.dialogueFormat);
  for (const field of ['series', 'bylineDesignationOverride', 'contributorDisclosure', 'editorNote', 'contributorDisclaimer']) {
    const normalized = normalizeNullableString(value[field], { maxLength: 1000 });
    if (normalized !== undefined) out[field] = normalized;
  }
  out.showAboutContributor = Boolean(value.showAboutContributor);
  const snapshot = normalizeBylineSnapshot(value.bylineSnapshot);
  if (snapshot) out.bylineSnapshot = snapshot;
  if (value.contributor) out.contributor = buildPublicContributor(value.contributor, null);
  return Object.keys(out).length ? out : undefined;
}

function isPulseDialogueArticle(docLike) {
  return String(docLike?.category || '').trim().toLowerCase() === PULSE_DIALOGUE_CATEGORY;
}

async function findContributorById(contributorId) {
  const id = normalizeObjectId(contributorId);
  if (!id) return null;
  const Contributor = require('../models/Contributor');
  const query = Contributor.findById(id);
  if (query && typeof query.lean === 'function') return query.lean();
  return query;
}

async function assertContributorExists(contributorId) {
  const contributor = await findContributorById(contributorId);
  if (!contributor) {
    const error = new Error('Pulse Dialogue contributor not found');
    error.statusCode = 400;
    error.details = { missingFields: ['pulseDialogue.contributorId'] };
    throw error;
  }
  return contributor;
}

function getArticleLanguage(docLike) {
  return normalizePulseDialogueLanguage(docLike?.language || docLike?.lang || docLike?.originalLang) || 'en';
}

async function preparePulseDialogueForPublication(docLike) {
  if (!isPulseDialogueArticle(docLike)) return { ok: true, changed: false };
  const pulse = isPlainObject(docLike?.pulseDialogue) ? docLike.pulseDialogue : {};
  const missingFields = [];
  if (!pulse.contributorId) missingFields.push('pulseDialogue.contributorId');
  if (!pulse.dialogueFormat) missingFields.push('pulseDialogue.dialogueFormat');

  let contributor = null;
  if (pulse.contributorId) {
    contributor = await findContributorById(pulse.contributorId);
    if (!contributor) missingFields.push('pulseDialogue.contributorId');
  }
  const publicName = contributor ? pickContributorDisplayName(contributor, getArticleLanguage(docLike)) : '';
  if (contributor && !publicName) missingFields.push('pulseDialogue.contributorName');
  if (contributor && String(contributor.status || '').trim().toLowerCase() !== 'active') {
    missingFields.push('pulseDialogue.activeContributor');
  }

  if (missingFields.length) {
    const error = new Error(`Missing required Pulse Dialogue fields: ${Array.from(new Set(missingFields)).join(', ')}`);
    error.statusCode = 400;
    error.details = { missingFields: Array.from(new Set(missingFields)) };
    throw error;
  }

  const language = getArticleLanguage(docLike);
  const snapshot = buildBylineSnapshot(contributor, language, pulse.bylineDesignationOverride);
  const nextPulse = applyPulseDialogueStandardText({
    ...pulse,
    contributorId: pulse.contributorId,
    bylineSnapshot: snapshot,
  }, language);

  docLike.pulseDialogue = nextPulse;
  return { ok: true, changed: true, contributor, bylineSnapshot: snapshot };
}

async function buildPublicPulseDialogueFromArticle(docLike) {
  if (!isPulseDialogueArticle(docLike)) return undefined;
  const pulse = isPlainObject(docLike?.pulseDialogue) ? docLike.pulseDialogue : null;
  if (!pulse) return undefined;
  const language = getArticleLanguage(docLike);
  const contributor = pulse.contributorId ? await findContributorById(pulse.contributorId) : null;
  const publicContributor = contributor ? buildPublicContributor(contributor, language) : null;
  const bylineSnapshot = normalizeBylineSnapshot(pulse.bylineSnapshot);
  const publicBylineSnapshot = bylineSnapshot && !bylineSnapshot.photo && publicContributor?.photo
    ? { ...bylineSnapshot, photo: publicContributor.photo }
    : bylineSnapshot;
  const out = normalizePublicPulseDialogue(applyPulseDialogueStandardText({
    ...pulse,
    contributorId: pulse.contributorId || null,
    ...(publicBylineSnapshot ? { bylineSnapshot: publicBylineSnapshot } : {}),
    contributor: publicContributor,
  }, language));
  return out;
}

async function attachPublicPulseDialogueContributor(docLike, language) {
  if (!docLike || !isPulseDialogueArticle(docLike)) return docLike;
  const pulse = isPlainObject(docLike.pulseDialogue) ? docLike.pulseDialogue : null;
  if (!pulse || !pulse.contributorId) return docLike;
  const contributor = await findContributorById(pulse.contributorId);
  if (!contributor) return docLike;
  const resolvedLanguage = language || getArticleLanguage(docLike);
  docLike.pulseDialogue = {
    ...applyPulseDialogueStandardText(pulse, resolvedLanguage),
    contributor: buildPublicContributor(contributor, resolvedLanguage),
  };
  return docLike;
}

module.exports = {
  PULSE_DIALOGUE_CATEGORY,
  CONTRIBUTOR_STATUS_VALUES,
  CONTRIBUTOR_TYPE_VALUES,
  DIALOGUE_FORMAT_VALUES,
  assertContributorExists,
  applyPulseDialogueStandardText,
  attachPublicPulseDialogueContributor,
  buildBylineSnapshot,
  buildPublicPulseDialogueFromArticle,
  buildPublicContributor,
  findContributorById,
  getArticleLanguage,
  getPulseDialogueStandardText,
  isPlainObject,
  isPulseDialogueArticle,
  normalizeContributorPayload,
  normalizePulseDialogueLanguage,
  normalizeNullableString,
  normalizePhoto,
  normalizePublicPulseDialogue,
  normalizePulseDialoguePayload,
  preparePulseDialogueForPublication,
};