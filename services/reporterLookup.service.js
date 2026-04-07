const mongoose = require('mongoose');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const { normalizeEmail: normalizeReporterEmail } = require('../lib/normalizeEmail');

function safeDecodeURIComponent(value) {
  const raw = value == null ? '' : String(value);
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function normalizeEmail(email) {
  const e = normalizeReporterEmail(email);
  return e || null;
}

function isValidObjectId(value) {
  const v = String(value || '').trim();
  return !!v && mongoose.Types.ObjectId.isValid(v);
}

async function findReporterContactByIdentifier(identifierRaw) {
  const decoded = safeDecodeURIComponent(identifierRaw);
  const identifier = String(decoded || '').trim();
  if (!identifier) return { identifier: '', kind: 'empty', contact: null };

  if (isValidObjectId(identifier)) {
    const contact = await ReporterContact.findById(identifier);
    return { identifier, kind: 'objectId', contact };
  }

  const email = normalizeEmail(identifier);
  if (email && email.includes('@')) {
    const contact = await ReporterContact.findOne({ $or: [{ emailLower: email }, { email }] });
    return { identifier: email, kind: 'email', contact };
  }

  return { identifier, kind: 'unknown', contact: null };
}

function buildSubmissionEmailMatch(emailNorm) {
  if (!emailNorm) return null;
  return {
    $or: [
      { reporterEmailNorm: emailNorm },
      { reporterEmail: emailNorm },
      { email: emailNorm },
      { submittedByEmail: emailNorm },
      { contactEmail: emailNorm },
      { authorEmail: emailNorm },
      { 'contact.email': emailNorm },
      { 'reporter.email': emailNorm },
      { 'reporterProfile.email': emailNorm },
      { 'contributor.email': emailNorm },
    ],
    isDeleted: { $ne: true },
  };
}

async function deriveReporterStatsFromSubmissionsByEmail(emailRaw) {
  const emailNorm = normalizeEmail(emailRaw);
  if (!emailNorm) return null;

  const match = buildSubmissionEmailMatch(emailNorm);
  if (!match) return null;

  const approvedStatuses = [
    'APPROVED', 'approved',
    'PUBLISHED', 'published', 'PUBLISH', 'publish',
  ];
  const publishedStatuses = ['PUBLISHED', 'published', 'PUBLISH', 'publish'];
  const pendingStatuses = [
    'NEW', 'new',
    'PENDING', 'pending',
    'UNDER_REVIEW', 'under_review', 'UNDERREVIEW', 'underreview',
    'PENDING_FOUNDER', 'pending_founder', 'PENDINGFOUNDER', 'pendingfounder',
    'AI_REVIEWED', 'ai_reviewed',
  ];
  const rejectedStatuses = [
    'REJECTED', 'rejected',
    'TRASH', 'trash',
    'DISCARDED', 'discarded',
    'ARCHIVED', 'archived',
    'DELETED', 'deleted',
  ];
  const withdrawnStatuses = ['WITHDRAWN', 'withdrawn'];

  const [totalStories, approvedStories, pendingStories, rejectedStories, withdrawnStories, publishedStories, latest] = await Promise.all([
    CommunitySubmission.countDocuments(match),
    CommunitySubmission.countDocuments({ ...match, status: { $in: approvedStatuses } }),
    CommunitySubmission.countDocuments({ ...match, status: { $in: pendingStatuses } }),
    CommunitySubmission.countDocuments({ ...match, status: { $in: rejectedStatuses } }),
    CommunitySubmission.countDocuments({ ...match, status: { $in: withdrawnStatuses } }),
    CommunitySubmission.countDocuments({ ...match, status: { $in: publishedStatuses } }),
    CommunitySubmission.findOne(match).sort({ createdAt: -1 }).lean(),
  ]);

  const reporterName =
    (latest?.reporterName && String(latest.reporterName).trim()) ||
    (latest?.name && String(latest.name).trim()) ||
    (latest?.contact?.name && String(latest.contact.name).trim()) ||
    null;

  return {
    email: emailNorm,
    name: reporterName,
    stats: {
      totalStories: Number(totalStories || 0),
      approvedStories: Number(approvedStories || 0),
      pendingStories: Number(pendingStories || 0),
      rejectedStories: Number(rejectedStories || 0),
      withdrawnStories: Number(withdrawnStories || 0),
      publishedStories: Number(publishedStories || 0),
      lastStoryAt: latest?.createdAt || null,
      lastStoryTitle: latest?.headline ? String(latest.headline).trim() : null,
    },
  };
}

module.exports = {
  safeDecodeURIComponent,
  normalizeEmail,
  isValidObjectId,
  findReporterContactByIdentifier,
  deriveReporterStatsFromSubmissionsByEmail,
};
