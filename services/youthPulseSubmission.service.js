const sanitizeHtml = require('sanitize-html');
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const News = require('../models/News');
const { YOUTH_PULSE_TRACK_DEFINITIONS, normalizeTrackValue } = require('./communitySubmissionWorkflow');
const { syncPublicArticleFromNews } = require('./syncPublicArticleFromNews.service');

const YOUTH_PULSE_DESK = 'youth-pulse';
const YOUTH_PULSE_ORIGIN = 'youth_submission';
const YOUTH_PULSE_PUBLIC_LABEL = 'Youth Pulse';
const YOUTH_PULSE_STATUSES = Object.freeze(['new', 'under_review', 'approved', 'rejected', 'published']);
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
  const list = Array.isArray(value) ? value : (value ? [value] : []);
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
  return doc.fullName || doc.reporterDisplayName || doc.reporterName || doc.name || null;
}

function isYouthPulseSubmission(doc = {}) {
  const originType = String(doc.originType || '').trim().toLowerCase();
  const desk = String(doc.desk || '').trim().toLowerCase();
  const intakeSource = String(doc.intakeSource || '').trim().toLowerCase();
  const submissionType = String(doc.submissionType || '').trim().toLowerCase();
  return originType === YOUTH_PULSE_ORIGIN
    || desk === YOUTH_PULSE_DESK
    || intakeSource === YOUTH_PULSE_DESK
    || !!normalizeTrackValue(doc.selectedPublicTrack || doc.track)
    || submissionType === YOUTH_PULSE_DESK;
}

function validateYouthPulsePublicPayload(body = {}) {
  const fullName = sanitizeText(body.fullName || body.name || body.reporterName, { maxLength: 120, allowNewlines: false });
  const email = sanitizeEmail(body.email || body.reporterEmail);
  const mobile = sanitizePhone(body.mobile || body.phone || body.contactNumber || body.phoneNumber);
  const college = sanitizeText(body.college, { maxLength: 160, allowNewlines: false }) || null;
  const city = sanitizeText(body.city || body.location?.city, { maxLength: 80, allowNewlines: false });
  const state = sanitizeText(body.state || body.location?.state, { maxLength: 80, allowNewlines: false });

  const track = normalizeTrackValue(body.track || body.selectedPublicTrack);
  const submissionType = sanitizeText(body.submissionType, { maxLength: 80, allowNewlines: false });
  const headline = sanitizeText(body.headline, { maxLength: 200, allowNewlines: false });
  const storyBody = sanitizeText(body.storyBody || body.body || body.story || body.content, { maxLength: 50000, allowNewlines: true });
  const originalLanguage = sanitizeText(body.originalLanguage || body.language || body.lang || 'en', { maxLength: 8, allowNewlines: false }).toLowerCase();
  const firstHandClaim = sanitizeBoolean(body.firstHandClaim);
  const optionalSourceLinks = sanitizeUrlArray(body.optionalSourceLinks || body.sourceLinks, 12);
  const optionalAttachmentUrls = sanitizeUrlArray(body.optionalAttachmentUrls || body.attachmentUrls || body.mediaUrls, 12);

  const confirmTruthful = sanitizeBoolean(body.confirmTruthful);
  const confirmRightsToShare = sanitizeBoolean(body.confirmRightsToShare);
  const confirmEditorialReviewAllowed = sanitizeBoolean(body.confirmEditorialReviewAllowed);
  const confirmNoUnsafeFalseAbusiveContent = sanitizeBoolean(body.confirmNoUnsafeFalseAbusiveContent);

  const errors = [];
  if (!fullName) errors.push('fullName is required');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email must be valid');
  if (!mobile || mobile.replace(/\D/g, '').length < 7) errors.push('mobile is required');
  if (!city) errors.push('city is required');
  if (!state) errors.push('state is required');
  if (!track) errors.push('track must be one of the supported Youth Pulse tracks');
  if (!submissionType) errors.push('submissionType is required');
  if (!headline) errors.push('headline is required');
  if (!storyBody) errors.push('storyBody is required');
  if (!YOUTH_PULSE_LANGUAGE_VALUES.includes(originalLanguage)) errors.push('originalLanguage must be one of en, hi, gu');
  if (!confirmTruthful || !confirmRightsToShare || !confirmEditorialReviewAllowed || !confirmNoUnsafeFalseAbusiveContent) {
    errors.push('all consent fields must be accepted');
  }

  return {
    errors,
    value: {
      fullName,
      email,
      mobile,
      college,
      city,
      state,
      track,
      submissionType,
      headline,
      storyBody,
      originalLanguage,
      firstHandClaim,
      optionalSourceLinks,
      optionalAttachmentUrls,
      confirmTruthful,
      confirmRightsToShare,
      confirmEditorialReviewAllowed,
      confirmNoUnsafeFalseAbusiveContent,
    },
  };
}

function buildYouthPulseSubmissionCreate(payload, req) {
  const ipAddress = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || req.connection?.remoteAddress || '';
  const userAgent = req.get('user-agent') || '';
  return {
    fullName: payload.fullName,
    reporterName: payload.fullName,
    name: payload.fullName,
    reporterEmail: payload.email,
    email: payload.email,
    mobile: payload.mobile,
    college: payload.college,
    city: payload.city,
    state: payload.state,
    track: payload.track,
    submissionType: payload.submissionType,
    headline: payload.headline,
    storyBody: payload.storyBody,
    body: payload.storyBody,
    originalLanguage: payload.originalLanguage,
    firstHandClaim: payload.firstHandClaim,
    optionalSourceLinks: payload.optionalSourceLinks,
    optionalAttachmentUrls: payload.optionalAttachmentUrls,
    confirmTruthful: payload.confirmTruthful,
    confirmRightsToShare: payload.confirmRightsToShare,
    confirmEditorialReviewAllowed: payload.confirmEditorialReviewAllowed,
    confirmNoUnsafeFalseAbusiveContent: payload.confirmNoUnsafeFalseAbusiveContent,
    attachments: payload.optionalAttachmentUrls.map((url) => ({ url })),
    mediaUrl: payload.optionalAttachmentUrls[0] || null,
    mediaLink: payload.optionalAttachmentUrls[0] || null,
    location: { city: payload.city, state: payload.state, country: null },
    locationDetail: { city: payload.city, state: payload.state },
    reporterLocation: payload.city,
    desk: YOUTH_PULSE_DESK,
    intakeSource: YOUTH_PULSE_DESK,
    status: 'new',
    moderationFlags: [],
    riskLevel: 'low',
    selectedPublicTrack: payload.track,
    originType: YOUTH_PULSE_ORIGIN,
    publicLabel: YOUTH_PULSE_PUBLIC_LABEL,
    sourceType: 'community',
    reporterVerificationLevel: 'unverified',
    ipAddress,
    userAgent,
    contact: {
      name: payload.fullName,
      email: payload.email,
      phone: payload.mobile,
      preferredContact: 'no_preference',
      canContactForThisStory: true,
      canContactForFutureStories: false,
    },
  };
}

function buildYouthPulseBaseFilter() {
  return {
    $or: [
      { originType: YOUTH_PULSE_ORIGIN },
      { desk: YOUTH_PULSE_DESK },
      { intakeSource: YOUTH_PULSE_DESK },
      { track: { $in: YOUTH_PULSE_TRACK_DEFINITIONS.map((entry) => entry.slug) } },
      { selectedPublicTrack: { $in: YOUTH_PULSE_TRACK_DEFINITIONS.map((entry) => entry.slug) } },
    ],
  };
}

function buildYouthPulseAdminFilter(query = {}) {
  const and = [buildYouthPulseBaseFilter()];
  const status = query.status ? normalizeYouthPulseStatus(query.status, null) : null;
  const track = normalizeTrackValue(query.track);
  const reviewedBy = sanitizeText(query.reviewedBy, { maxLength: 120, allowNewlines: false });
  const riskLevel = sanitizeText(query.riskLevel, { maxLength: 24, allowNewlines: false }).toLowerCase();
  const articleLinked = String(query.articleLinked || '').trim().toLowerCase();
  const search = sanitizeText(query.q || query.search, { maxLength: 120, allowNewlines: false });

  if (status) and.push({ status });
  if (track) and.push({ $or: [{ track }, { selectedPublicTrack: track }] });
  if (reviewedBy) and.push({ reviewedBy });
  if (riskLevel) and.push({ riskLevel });
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
  const activeTrack = doc.selectedPublicTrack || doc.track || null;
  const linkedArticleId = doc.linkedArticleId ? String(doc.linkedArticleId) : null;
  return {
    id: doc._id ? String(doc._id) : null,
    fullName: doc.fullName || doc.reporterName || doc.name || null,
    email: doc.email || doc.reporterEmail || null,
    mobile: doc.mobile || doc.phone || doc.phoneNumber || null,
    college: doc.college || null,
    city: doc.city || doc.location?.city || null,
    state: doc.state || doc.location?.state || null,
    track: doc.track || null,
    submissionType: doc.submissionType || null,
    headline: doc.headline || null,
    storyBody: doc.storyBody || doc.body || null,
    originalLanguage: doc.originalLanguage || doc.language || doc.lang || 'en',
    firstHandClaim: Boolean(doc.firstHandClaim),
    optionalSourceLinks: Array.isArray(doc.optionalSourceLinks) ? doc.optionalSourceLinks : [],
    optionalAttachmentUrls: Array.isArray(doc.optionalAttachmentUrls) ? doc.optionalAttachmentUrls : [],
    confirmTruthful: Boolean(doc.confirmTruthful),
    confirmRightsToShare: Boolean(doc.confirmRightsToShare),
    confirmEditorialReviewAllowed: Boolean(doc.confirmEditorialReviewAllowed),
    confirmNoUnsafeFalseAbusiveContent: Boolean(doc.confirmNoUnsafeFalseAbusiveContent),
    status: normalizeYouthPulseStatus(doc.status, 'new'),
    moderationFlags: Array.isArray(doc.moderationFlags) ? doc.moderationFlags : [],
    riskLevel: doc.riskLevel || 'low',
    verificationNotes: doc.verificationNotes || null,
    editorialNotes: doc.editorialNotes || null,
    rejectionReason: doc.rejectionReason || doc.rejectReason || null,
    cleanedHeadline: doc.cleanedHeadline || null,
    cleanedSummary: doc.cleanedSummary || null,
    cleanedBody: doc.cleanedBody || null,
    selectedPublicTrack: doc.selectedPublicTrack || null,
    reviewedBy: doc.reviewedBy || null,
    approvedBy: doc.approvedBy || null,
    linkedArticleId,
    linkedArticleSlug: doc.linkedArticleSlug || doc.articleSlug || null,
    publishedAt: doc.publishedAt || null,
    originType: doc.originType || YOUTH_PULSE_ORIGIN,
    publicLabel: doc.publicLabel || YOUTH_PULSE_PUBLIC_LABEL,
    displayTrack: getTrackLabel(activeTrack) || doc.publicLabel || YOUTH_PULSE_PUBLIC_LABEL,
    displayStatus: formatDisplayStatus(doc.status),
    contributorDisplayName: contributorDisplayName(doc),
    articleLinked: Boolean(linkedArticleId),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function deriveSummary(text) {
  const summary = sanitizeText(text, { maxLength: 260, allowNewlines: false });
  return summary || null;
}

function buildPublishPayload(submission) {
  const title = submission.cleanedHeadline || submission.headline || 'Youth Pulse Story';
  const content = submission.cleanedBody || submission.storyBody || submission.body || '';
  const description = submission.cleanedSummary || deriveSummary(content || title) || title;
  const track = normalizeTrackValue(submission.selectedPublicTrack || submission.track) || 'youth-pulse';
  const tags = [
    'youth-pulse',
    `track:${track}`,
    `origin:${YOUTH_PULSE_ORIGIN}`,
  ];
  for (const link of Array.isArray(submission.optionalSourceLinks) ? submission.optionalSourceLinks : []) {
    if (tags.length >= 16) break;
    if (!tags.includes(link)) tags.push(link);
  }
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
    status: 'published',
    publishAt: new Date(),
    publishedAt: new Date(),
    source: 'community',
    communityReportId: submission._id,
    location: {
      city: submission.city || null,
      state: submission.state || null,
      country: submission.location?.country || null,
    },
  };
}

async function publishYouthPulseSubmission(submission, { admin } = {}) {
  if (!submission) {
    const error = new Error('Submission not found');
    error.statusCode = 404;
    throw error;
  }

  const payload = buildPublishPayload(submission);
  let article = null;
  if (submission.linkedArticleId && mongoose.isValidObjectId(String(submission.linkedArticleId))) {
    article = await News.findById(submission.linkedArticleId);
  }
  if (!article) {
    article = await News.findOne({ communityReportId: submission._id });
  }

  if (article) {
    Object.assign(article, payload);
  } else {
    article = new News(payload);
  }

  await article.save();
  await syncPublicArticleFromNews(article, { logger: console }).catch(() => null);

  submission.linkedArticleId = article._id;
  submission.linkedArticleSlug = article.slug || null;
  submission.articleSlug = article.slug || null;
  submission.publishedAt = payload.publishedAt;
  submission.status = 'published';
  submission.approvedBy = submission.approvedBy || admin || null;
  submission.reviewedBy = admin || submission.reviewedBy || null;
  submission.selectedPublicTrack = payload.track;
  submission.originType = submission.originType || YOUTH_PULSE_ORIGIN;
  submission.publicLabel = submission.publicLabel || YOUTH_PULSE_PUBLIC_LABEL;
  await submission.save();

  return { submission, article };
}

async function getYouthPulseSubmissionById(id) {
  if (!id || !mongoose.isValidObjectId(String(id))) return null;
  const submission = await CommunitySubmission.findById(id);
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
  formatDisplayStatus,
  getTrackLabel,
  getYouthPulseSubmissionById,
  isYouthPulseSubmission,
  normalizeYouthPulseStatus,
  publishYouthPulseSubmission,
  sanitizeText,
  toYouthPulseAdminDto,
  validateYouthPulsePublicPayload,
};