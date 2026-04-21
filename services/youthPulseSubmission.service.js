const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const News = require('../models/News');
const { YOUTH_PULSE_TRACK_DEFINITIONS, normalizeTrackValue } = require('./communitySubmissionWorkflow');
const { syncYouthPulseContributorStats } = require('./youthPulseContributor.service');

const YOUTH_PULSE_DESK = 'youth-pulse';
const YOUTH_PULSE_ORIGIN = 'youth_pulse_submission';
const YOUTH_PULSE_PUBLIC_LABEL = 'Youth Pulse Community';
const YOUTH_PULSE_DRAFT_LABEL = 'Youth Pulse';
const YOUTH_PULSE_STATUSES = Object.freeze(['new', 'under_review', 'approved', 'rejected', 'draft_created', 'published']);
const YOUTH_PULSE_LANGUAGE_VALUES = Object.freeze(['en', 'hi', 'gu']);

function sanitizeText(value, { maxLength = 0, allowNewlines = true } = {}) {
  let text = sanitizeHtml(String(value || ''), { allowedTags: [], allowedAttributes: {} });
  text = allowNewlines ? text.replace(/\r\n?/g, '\n') : text.replace(/\s+/g, ' ');
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = allowNewlines ? text.replace(/\n{3,}/g, '\n\n') : text;
  text = text.trim();
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function sanitizeEmail(value) {
  return sanitizeText(value, { maxLength: 254, allowNewlines: false }).toLowerCase();
}

function sanitizePhone(value) {
  return sanitizeText(value, { maxLength: 32, allowNewlines: false }).replace(/[^\d+\-()\s]/g, '').trim();
}

function sanitizeUrl(value) {
  const input = sanitizeText(value, { maxLength: 2048, allowNewlines: false });
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  if (/^\/uploads\//i.test(input)) return input;
  return null;
}

function sanitizeUrlArray(value, limit = 12) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const out = [];
  for (const entry of list) {
    const url = sanitizeUrl(entry);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

function sanitizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  const token = String(value || '').trim().toLowerCase();
  return token === 'true' || token === '1' || token === 'yes' || token === 'on';
}

function firstProvided(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    if (Array.isArray(value) && !value.length) continue;
    return value;
  }
  return undefined;
}

function getConsentValue(body = {}, ...keys) {
  const groups = [body, body.consents || {}, body.consent || {}, body.requiredConsents || {}];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(group, key)) {
        return sanitizeBoolean(group[key]);
      }
    }
  }
  return false;
}

function normalizeKnowledgeSource(value) {
  const token = sanitizeText(value, { maxLength: 80, allowNewlines: false })
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');

  if (!token) return null;
  if (['first-hand', 'firsthand', 'direct', 'direct-source', 'direct-witness', 'self', 'own-experience'].includes(token)) {
    return 'first_hand';
  }
  if (['second-hand', 'secondhand', 'indirect', 'third-party', 'reported', 'other'].includes(token)) {
    return 'reported';
  }
  return token;
}

function normalizeYouthPulseStatus(value, fallback = 'new') {
  const token = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!token) return fallback;
  switch (token) {
    case 'new':
      return 'new';
    case 'under_review':
    case 'review':
    case 'pending':
      return 'under_review';
    case 'approved':
    case 'approve':
      return 'approved';
    case 'draft_created':
    case 'draft':
    case 'sent_to_draft':
    case 'sent_to_draft_desk':
      return 'draft_created';
    case 'rejected':
    case 'reject':
      return 'rejected';
    case 'published':
    case 'publish':
      return 'published';
    default:
      return fallback;
  }
}

function getTrackDefinition(value) {
  const normalized = normalizeTrackValue(value);
  if (!normalized) return null;
  return YOUTH_PULSE_TRACK_DEFINITIONS.find((entry) => entry.slug === normalized) || null;
}

function getTrackLabel(value) {
  const definition = getTrackDefinition(value);
  return definition ? definition.label : null;
}

function formatDisplayStatus(value) {
  const status = normalizeYouthPulseStatus(value, 'new');
  switch (status) {
    case 'under_review':
      return 'Under Review';
    case 'approved':
      return 'Approved';
    case 'draft_created':
      return 'Draft Created';
    case 'rejected':
      return 'Rejected';
    case 'published':
      return 'Published';
    case 'new':
    default:
      return 'New';
  }
}

function contributorDisplayName(doc = {}) {
  return doc.fullName || null;
}

function isYouthPulseSubmission(doc = {}) {
  return String(doc.sourceType || '').trim().toLowerCase() === 'youth_pulse';
}

function validateYouthPulsePublicPayload(body = {}) {
  const fullName = sanitizeText(body.fullName || body.name || body.reporterName, { maxLength: 120, allowNewlines: false });
  const email = sanitizeEmail(body.email || body.reporterEmail);
  const mobile = sanitizePhone(body.mobile || body.phone || body.contactNumber || body.phoneNumber);
  const college = sanitizeText(body.college, { maxLength: 160, allowNewlines: false }) || null;
  const city = sanitizeText(body.city || body.location?.city, { maxLength: 80, allowNewlines: false });
  const state = sanitizeText(body.state || body.location?.state, { maxLength: 80, allowNewlines: false });
  const track = normalizeTrackValue(body.track || body.selectedPublicTrack);
  const submissionType = sanitizeText(firstProvided(body.submissionType, body.storyType, body.contentType), { maxLength: 80, allowNewlines: false });
  const knowledgeSource = normalizeKnowledgeSource(firstProvided(
    body.knowledgeSource,
    body.knowledgeSourceType,
    body.sourceKnowledge,
    body.firstHandClaim,
    body.firstHand,
    body.isFirstHand
  ));
  const headline = sanitizeText(body.headline, { maxLength: 200, allowNewlines: false });
  const storyBody = sanitizeText(body.storyBody || body.body || body.story || body.content, { maxLength: 50000, allowNewlines: true });
  const originalLanguage = sanitizeText(body.originalLanguage || body.language || body.lang || 'en', { maxLength: 8, allowNewlines: false }).toLowerCase();
  const optionalSourceLinks = sanitizeUrlArray(firstProvided(
    body.optionalSourceLinks,
    body.sourceLinks,
    body.referenceLinks,
    body.referenceLink,
    body.referenceUrl,
    body.referenceUrls
  ), 12);
  const optionalAttachmentUrls = sanitizeUrlArray(firstProvided(
    body.optionalAttachmentUrls,
    body.attachmentUrls,
    body.mediaUrls,
    body.proofFileLinks,
    body.proofFileLink,
    body.proofFileUrl,
    body.proofUrl
  ), 12);

  const confirmTruthful = getConsentValue(body, 'confirmTruthful', 'consentTruthful', 'truthful');
  const confirmRightsToShare = getConsentValue(body, 'confirmRightsToShare', 'consentRightsToShare', 'rightsToShare', 'rights');
  const confirmEditorialReviewAllowed = getConsentValue(body, 'confirmEditorialReviewAllowed', 'consentEditorialReviewAllowed', 'editorialReviewAllowed', 'editorialReview');
  const confirmNoUnsafeFalseAbusiveContent = getConsentValue(body, 'confirmNoUnsafeFalseAbusiveContent', 'consentNoUnsafeFalseAbusiveContent', 'noUnsafeFalseAbusiveContent', 'safeContent');

  const errors = [];
  const fieldErrors = {};
  const addFieldError = (field, message) => {
    errors.push(message);
    if (!fieldErrors[field]) fieldErrors[field] = message;
  };

  if (!fullName) addFieldError('fullName', 'fullName is required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) addFieldError('email', 'email must be valid');
  if (!mobile || mobile.replace(/\D/g, '').length < 7) addFieldError('mobile', 'mobile is required');
  if (!city) addFieldError('city', 'city is required');
  if (!state) addFieldError('state', 'state is required');
  if (!track) addFieldError('track', 'track must be one of the supported Youth Pulse tracks');
  if (!submissionType) addFieldError('submissionType', 'submissionType is required');
  if (!headline) addFieldError('headline', 'headline is required');
  if (!storyBody) addFieldError('storyBody', 'storyBody is required');
  if (!YOUTH_PULSE_LANGUAGE_VALUES.includes(originalLanguage)) addFieldError('originalLanguage', 'originalLanguage must be one of en, hi, gu');
  if (!confirmTruthful || !confirmRightsToShare || !confirmEditorialReviewAllowed || !confirmNoUnsafeFalseAbusiveContent) {
    addFieldError('consents', 'all consent fields must be accepted');
  }

  return {
    errors,
    fieldErrors,
    value: {
      fullName,
      email,
      mobile,
      college,
      city,
      state,
      track,
      submissionType,
      knowledgeSource,
      headline,
      storyBody,
      originalLanguage,
      optionalSourceLinks,
      optionalAttachmentUrls,
    },
  };
}

function buildYouthPulseSubmissionCreate(payload, req, contributorId = null) {
  const ipAddress = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';
  const userAgent = req.get('user-agent') || '';
  return {
    fullName: payload.fullName,
    email: payload.email,
    mobile: payload.mobile,
    college: payload.college,
    city: payload.city,
    state: payload.state,
    track: payload.track,
    submissionType: payload.submissionType,
    knowledgeSource: payload.knowledgeSource,
    headline: payload.headline,
    storyBody: payload.storyBody,
    originalLanguage: payload.originalLanguage,
    optionalSourceLinks: payload.optionalSourceLinks,
    optionalAttachmentUrls: payload.optionalAttachmentUrls,
    status: 'new',
    moderationFlags: [],
    riskLevel: 'low',
    contributorId,
    sourceType: 'youth_pulse',
    sourceLabel: YOUTH_PULSE_PUBLIC_LABEL,
    ipAddress,
    userAgent,
  };
}

function buildYouthPulseBaseFilter() {
  return { sourceType: 'youth_pulse' };
}

function buildYouthPulseAdminFilter(query = {}) {
  const and = [buildYouthPulseBaseFilter()];
  const status = query.status ? normalizeYouthPulseStatus(query.status, null) : null;
  const track = normalizeTrackValue(query.track);
  const reviewedBy = sanitizeText(query.reviewedBy, { maxLength: 120, allowNewlines: false });
  const riskLevel = sanitizeText(query.riskLevel, { maxLength: 24, allowNewlines: false }).toLowerCase();
  const draftLinked = String(query.draftLinked || '').trim().toLowerCase();
  const articleLinked = String(query.articleLinked || '').trim().toLowerCase();
  const search = sanitizeText(query.q || query.search, { maxLength: 120, allowNewlines: false });

  if (status) and.push({ status });
  if (track) and.push({ track });
  if (reviewedBy) and.push({ reviewedBy });
  if (riskLevel) and.push({ riskLevel });
  if (draftLinked === 'true') and.push({ linkedDraftId: { $exists: true, $ne: null } });
  if (draftLinked === 'false') and.push({ $or: [{ linkedDraftId: null }, { linkedDraftId: { $exists: false } }] });
  if (articleLinked === 'true') and.push({ linkedArticleId: { $exists: true, $ne: null } });
  if (articleLinked === 'false') and.push({ $or: [{ linkedArticleId: null }, { linkedArticleId: { $exists: false } }] });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({
      $or: [
        { fullName: rx },
        { email: rx },
        { headline: rx },
        { storyBody: rx },
        { city: rx },
        { state: rx },
      ],
    });
  }

  return and.length === 1 ? and[0] : { $and: and };
}

function toYouthPulseAdminDto(doc = {}) {
  const linkedDraftId = doc.linkedDraftId ? String(doc.linkedDraftId) : null;
  const linkedArticleId = doc.linkedArticleId ? String(doc.linkedArticleId) : null;
  return {
    id: doc._id ? String(doc._id) : null,
    fullName: doc.fullName || null,
    email: doc.email || null,
    mobile: doc.mobile || null,
    college: doc.college || null,
    city: doc.city || null,
    state: doc.state || null,
    track: doc.track || null,
    submissionType: doc.submissionType || null,
    knowledgeSource: doc.knowledgeSource || null,
    headline: doc.headline || null,
    storyBody: doc.storyBody || null,
    originalLanguage: doc.originalLanguage || 'en',
    optionalSourceLinks: Array.isArray(doc.optionalSourceLinks) ? doc.optionalSourceLinks : [],
    optionalAttachmentUrls: Array.isArray(doc.optionalAttachmentUrls) ? doc.optionalAttachmentUrls : [],
    status: normalizeYouthPulseStatus(doc.status, 'new'),
    moderationFlags: Array.isArray(doc.moderationFlags) ? doc.moderationFlags : [],
    riskLevel: doc.riskLevel || 'low',
    verificationNotes: doc.verificationNotes || null,
    editorialNotes: doc.editorialNotes || null,
    rejectionReason: doc.rejectionReason || null,
    reviewedBy: doc.reviewedBy || null,
    approvedBy: doc.approvedBy || null,
    linkedDraftId,
    linkedArticleId,
    contributorId: doc.contributorId ? String(doc.contributorId) : null,
    publishedAt: doc.publishedAt || null,
    sourceType: doc.sourceType || 'youth_pulse',
    sourceLabel: doc.sourceLabel || YOUTH_PULSE_PUBLIC_LABEL,
    displayTrack: getTrackLabel(doc.track) || doc.sourceLabel || YOUTH_PULSE_PUBLIC_LABEL,
    displayStatus: formatDisplayStatus(doc.status),
    contributorDisplayName: contributorDisplayName(doc),
    draftLinked: Boolean(linkedDraftId),
    articleLinked: Boolean(linkedArticleId),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function deriveSummary(text) {
  const summary = sanitizeText(text, { maxLength: 260, allowNewlines: false });
  return summary || null;
}

function normalizeReadableLocationPart(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    return sanitizeText(value, { maxLength: 120, allowNewlines: false }) || null;
  }
  if (typeof value === 'object') {
    const candidate = firstProvided(
      value.label,
      value.name,
      value.city,
      value.state,
      value.country,
      value.title,
      value.value
    );
    return candidate === undefined ? null : normalizeReadableLocationPart(candidate);
  }
  return sanitizeText(String(value), { maxLength: 120, allowNewlines: false }) || null;
}

function buildNormalizedDraftLocation(submission = {}) {
  const rawLocation = submission.location && typeof submission.location === 'object' ? submission.location : null;
  return {
    city: normalizeReadableLocationPart(firstProvided(submission.city, rawLocation && rawLocation.city)),
    state: normalizeReadableLocationPart(firstProvided(submission.state, rawLocation && rawLocation.state)),
    country: normalizeReadableLocationPart(firstProvided(submission.country, rawLocation && rawLocation.country)),
  };
}

function buildDraftPayload(submission, existingArticle = null) {
  const title = submission.headline || 'Youth Pulse Story';
  const content = submission.storyBody || '';
  const description = deriveSummary(content || title) || title;
  const track = normalizeTrackValue(submission.track) || 'youth-pulse';
  const location = buildNormalizedDraftLocation(submission);
  const tags = ['youth-pulse', 'source:youth_pulse', `track:${track}`, `origin:${YOUTH_PULSE_ORIGIN}`];
  for (const link of Array.isArray(submission.optionalSourceLinks) ? submission.optionalSourceLinks : []) {
    if (tags.length >= 16) break;
    if (!tags.includes(link)) tags.push(link);
  }
  const status = existingArticle && existingArticle.status === 'published' ? 'published' : 'draft';
  return {
    title,
    description,
    content,
    category: 'youth-pulse',
    track,
    tags,
    language: submission.originalLanguage || 'en',
    lang: submission.originalLanguage || 'en',
    originalLang: submission.originalLanguage || 'en',
    status,
    publishAt: status === 'published' ? existingArticle.publishAt || new Date() : null,
    publishedAt: status === 'published' ? existingArticle.publishedAt || new Date() : null,
    source: 'community',
    sourceType: 'youth_pulse',
    sourceLabel: YOUTH_PULSE_DRAFT_LABEL,
    submissionSource: 'youth_pulse',
    sourceTrack: track,
    originType: YOUTH_PULSE_ORIGIN,
    youthPulseSubmissionId: submission._id,
    youthPulseContributorId: submission.contributorId || null,
    location,
  };
}

async function createYouthPulseDraft(submission, { admin } = {}) {
  if (!submission) {
    const error = new Error('Submission not found');
    error.statusCode = 404;
    throw error;
  }

  const normalizedStatus = normalizeYouthPulseStatus(submission.status, 'new');
  if (!['approved', 'draft_created', 'published'].includes(normalizedStatus)) {
    const error = new Error('Submission must be approved before creating a draft');
    error.statusCode = 409;
    throw error;
  }

  let article = null;
  if (submission.linkedDraftId && mongoose.isValidObjectId(String(submission.linkedDraftId))) {
    article = await News.findById(submission.linkedDraftId);
  }
  if (!article && submission.linkedArticleId && mongoose.isValidObjectId(String(submission.linkedArticleId))) {
    article = await News.findById(submission.linkedArticleId);
  }
  if (!article) {
    article = await News.findOne({ youthPulseSubmissionId: submission._id });
  }

  const payload = buildDraftPayload(submission, article);
  if (article) {
    Object.assign(article, payload);
  } else {
    article = new News(payload);
  }

  await article.save();

  submission.linkedDraftId = article._id;
  if (article.status === 'published') {
    submission.linkedArticleId = article._id;
    submission.publishedAt = article.publishedAt || new Date();
    submission.status = 'published';
  } else {
    submission.status = 'draft_created';
  }
  submission.approvedBy = submission.approvedBy || admin || null;
  submission.reviewedBy = admin || submission.reviewedBy || null;
  await submission.save();

  if (submission.contributorId) {
    await syncYouthPulseContributorStats(submission.contributorId).catch(() => null);
  }

  return { submission, article };
}

async function getYouthPulseSubmissionById(id) {
  if (!id || !mongoose.isValidObjectId(String(id))) return null;
  const submission = await YouthPulseSubmission.findById(id);
  if (!submission || !isYouthPulseSubmission(submission)) return null;
  return submission;
}

module.exports = {
  YOUTH_PULSE_DESK,
  YOUTH_PULSE_ORIGIN,
  YOUTH_PULSE_PUBLIC_LABEL,
  YOUTH_PULSE_STATUSES,
  buildYouthPulseAdminFilter,
  buildYouthPulseSubmissionCreate,
  createYouthPulseDraft,
  formatDisplayStatus,
  getTrackLabel,
  getYouthPulseSubmissionById,
  isYouthPulseSubmission,
  normalizeYouthPulseStatus,
  sanitizeText,
  toYouthPulseAdminDto,
  validateYouthPulsePublicPayload,
};