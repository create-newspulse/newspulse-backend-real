const CommunitySubmission = require('../models/CommunitySubmission');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const {
  buildCommunitySubmissionAdminFilter,
  buildSubmissionAdminView,
} = require('./communitySubmissionWorkflow');
const { normalizeYouthPulseStatus } = require('./youthPulseSubmission.service');

const COMMUNITY_SOURCE = 'community_reporter';
const YOUTH_SOURCE = 'youth_pulse';

function normalizeSourceToken(value) {
  const token = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!token || token === 'all') return null;
  if (token === 'community' || token === 'community_reporter' || token === 'communityreporter') return COMMUNITY_SOURCE;
  if (token === 'youth' || token === 'youth_pulse' || token === 'youthpulse') return YOUTH_SOURCE;
  return null;
}

function normalizeTextQuery(value) {
  return String(value || '').trim();
}

function buildYouthQueueStatusFilter(value) {
  const token = String(value || 'pending').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!token || token === 'all') return null;
  if (token === 'pending' || token === 'under_review' || token === 'review') {
    return { $in: ['new', 'under_review'] };
  }
  if (token === 'approved') {
    return { $in: ['approved', 'draft_created'] };
  }
  if (token === 'rejected') {
    return 'rejected';
  }
  if (token === 'published') {
    return 'published';
  }
  const normalized = normalizeYouthPulseStatus(token, null);
  return normalized || null;
}

function buildYouthQueueFilter(query = {}) {
  const filter = { sourceType: 'youth_pulse' };
  const status = buildYouthQueueStatusFilter(query.status || 'pending');
  const track = normalizeTextQuery(query.track);
  const search = normalizeTextQuery(query.q || query.search);

  if (status) filter.status = status;
  if (track) filter.track = track;
  if (search) {
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(escaped, 'i');
    filter.$or = [
      { fullName: rx },
      { email: rx },
      { headline: rx },
      { storyBody: rx },
      { city: rx },
      { state: rx },
      { track: rx },
    ];
  }

  return filter;
}

function toCommunityQueueRow(doc = {}) {
  const base = buildSubmissionAdminView(doc);
  return {
    ...base,
    reporter: base.reporterName || 'Unknown reporter',
    priority: doc.priority || 'normal',
    aiRisk: typeof doc.riskScore === 'number' ? doc.riskScore : 0,
    sourceType: COMMUNITY_SOURCE,
    sourceLabel: 'Community Reporter',
    rawSourceType: doc.sourceType || 'community',
  };
}

function toYouthQueueRow(doc = {}) {
  return {
    id: doc._id && typeof doc._id.toString === 'function' ? doc._id.toString() : String(doc._id || ''),
    headline: doc.headline || '',
    story: doc.storyBody || '',
    category: 'youth-pulse',
    desk: 'youth-pulse',
    track: doc.track || null,
    submissionType: doc.submissionType || null,
    intakeSource: 'youth-pulse',
    attachments: Array.isArray(doc.optionalAttachmentUrls)
      ? doc.optionalAttachmentUrls.map((url) => ({ url }))
      : [],
    location: doc.city || null,
    locationObj: { city: doc.city || null, state: doc.state || null, country: null },
    status: doc.status || 'new',
    sourceType: YOUTH_SOURCE,
    sourceLabel: 'Youth Pulse',
    rawSourceType: 'youth_pulse',
    reporterId: doc.contributorId || null,
    reporterName: doc.fullName || null,
    reporterEmail: doc.email || null,
    reporterPhone: doc.mobile || null,
    reporter: doc.fullName || 'Unknown reporter',
    riskScore: 0,
    aiRisk: 0,
    flags: Array.isArray(doc.moderationFlags) ? doc.moderationFlags : [],
    priority: 'normal',
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function listSharedCommunityReporterQueue(query = {}, options = {}) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const limitRaw = Math.max(parseInt(query.limit || '20', 10), 1);
  const limit = Math.min(limitRaw, 100);
  const skip = (page - 1) * limit;
  const sourceFilter = normalizeSourceToken(query.sourceType || query.source);

  const promises = [];

  if (!sourceFilter || sourceFilter === COMMUNITY_SOURCE) {
    const communityFilter = buildCommunitySubmissionAdminFilter(
      sourceFilter === COMMUNITY_SOURCE
        ? { ...query, source: 'community' }
        : query,
      { defaultStatus: query.status || 'pending', forceDesk: options.forceDesk || null }
    );
    promises.push(
      Promise.all([
        CommunitySubmission.find(communityFilter).sort({ createdAt: -1 }).limit(500).lean(),
        CommunitySubmission.countDocuments(communityFilter),
      ]).then(([items, total]) => ({ source: COMMUNITY_SOURCE, items, total }))
    );
  }

  if (!sourceFilter || sourceFilter === YOUTH_SOURCE) {
    const youthFilter = buildYouthQueueFilter(query);
    promises.push(
      Promise.all([
        YouthPulseSubmission.find(youthFilter).sort({ createdAt: -1 }).limit(500).lean(),
        YouthPulseSubmission.countDocuments(youthFilter),
      ]).then(([items, total]) => ({ source: YOUTH_SOURCE, items, total }))
    );
  }

  const parts = await Promise.all(promises);
  const combined = [];
  let total = 0;
  for (const part of parts) {
    total += Number(part.total || 0);
    if (part.source === COMMUNITY_SOURCE) {
      combined.push(...part.items.map(toCommunityQueueRow));
    } else if (part.source === YOUTH_SOURCE) {
      combined.push(...part.items.map(toYouthQueueRow));
    }
  }

  combined.sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });

  return {
    items: combined.slice(skip, skip + limit),
    total,
    page,
    limit,
    statusFilter: String(query.status || 'pending'),
    sourceFilter: sourceFilter || 'all',
  };
}

module.exports = {
  COMMUNITY_SOURCE,
  YOUTH_SOURCE,
  listSharedCommunityReporterQueue,
  normalizeSourceToken,
};