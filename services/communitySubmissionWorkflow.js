const YOUTH_PULSE_DESK = 'youth-pulse';

const COMMUNITY_REPORTER_CATEGORIES = Object.freeze([
  'Regional',
  'National',
  'International',
  'Civic Issue',
  'Crime / Police',
  'Government / Public Services',
  'Politics / Local Leadership',
  'Education / School / College',
  'Health / Hospital',
  'Weather / Disaster',
  'Business / Market',
  'Sports',
  'Youth / Campus',
  'Lifestyle / Culture',
  'Entertainment / Events',
  'Environment',
  'Achievement / Inspiration',
  'General Tip',
]);

const YOUTH_PULSE_TRACKS = [
  'youth-pulse',
  'campus-buzz',
  'govt-exam-updates',
  'career-boosters',
  'young-achievers',
  'student-voices',
];

const YOUTH_PULSE_TRACK_DEFINITIONS = Object.freeze([
  Object.freeze({ slug: 'youth-pulse', label: 'Youth Pulse' }),
  Object.freeze({ slug: 'campus-buzz', label: 'Campus Buzz' }),
  Object.freeze({ slug: 'govt-exam-updates', label: 'Govt Exam Updates' }),
  Object.freeze({ slug: 'career-boosters', label: 'Career Boosters' }),
  Object.freeze({ slug: 'young-achievers', label: 'Young Achievers' }),
  Object.freeze({ slug: 'student-voices', label: 'Student Voices' }),
]);

const WORKFLOW_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'NEW',
  'AI_REVIEWED',
  'UNDER_REVIEW',
  'NEEDS_REVISION',
  'APPROVED',
  'REJECTED',
  'PUBLISHED',
];

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');
}

function normalizeCommunityReporterCategory(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  const match = COMMUNITY_REPORTER_CATEGORIES.find((entry) => entry.toLowerCase() === lowered);
  return match || null;
}

function isAllowedCommunityReporterCategory(value) {
  return !!normalizeCommunityReporterCategory(value);
}

function normalizeDeskValue(value) {
  const token = normalizeToken(value);
  if (!token) return null;
  if (token === 'youthpulse' || token === 'youth-pulse-desk') return YOUTH_PULSE_DESK;
  return token;
}

function normalizeTrackValue(value) {
  const token = normalizeToken(value);
  if (!token) return null;

  switch (token) {
    case 'youthpulse':
      return 'youth-pulse';
    case 'campusbuzz':
      return 'campus-buzz';
    case 'govt-exam':
    case 'government-exam-updates':
    case 'government-exam':
      return 'govt-exam-updates';
    case 'careerboosters':
      return 'career-boosters';
    case 'youngachievers':
      return 'young-achievers';
    case 'studentvoices':
    case 'student-voice':
      return 'student-voices';
    default:
      return YOUTH_PULSE_TRACKS.includes(token) ? token : null;
  }
}

function getYouthPulseTrackDefinition(value) {
  const slug = normalizeTrackValue(value);
  if (!slug) return null;
  return YOUTH_PULSE_TRACK_DEFINITIONS.find((entry) => entry.slug === slug) || null;
}

function ensureTrackTag(tags, trackValue) {
  const track = normalizeTrackValue(trackValue);
  const base = Array.isArray(tags) ? tags : [];
  const filtered = base.filter((tag) => !/^track:/i.test(String(tag || '').trim()));
  if (!track) return filtered;
  return filtered.concat([`track:${track}`]);
}

function buildYouthPulseTrackFilter(trackValue, { trackField = 'track', tagsField = 'tags', topicField = 'topic' } = {}) {
  const track = normalizeTrackValue(trackValue);
  if (!track) return null;

  const escaped = String(track).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tagRegex = new RegExp(`^(?:track:)?${escaped}$`, 'i');
  const clauses = [
    { [trackField]: track },
    { [tagsField]: tagRegex },
  ];

  if (topicField) {
    clauses.push({ [topicField]: new RegExp(`^${escaped}$`, 'i') });
  }

  return { $or: clauses };
}

function normalizeWorkflowStatus(value, fallback = null) {
  const token = normalizeToken(value);
  if (!token) return fallback;

  switch (token) {
    case 'draft':
      return 'DRAFT';
    case 'submitted':
    case 'submit':
      return 'SUBMITTED';
    case 'new':
      return 'NEW';
    case 'ai-reviewed':
    case 'aireviewed':
      return 'AI_REVIEWED';
    case 'needs-revision':
    case 'needsrevision':
    case 'needs_revision':
    case 'revision-requested':
    case 'revisionrequested':
    case 'revision_requested':
      return 'NEEDS_REVISION';
    case 'under-review':
    case 'underreview':
    case 'review':
    case 'pending':
    case 'pending-founder':
    case 'pending-founder-review':
      return 'UNDER_REVIEW';
    case 'approved':
    case 'approve':
      return 'APPROVED';
    case 'rejected':
    case 'reject':
    case 'denied':
    case 'trash':
    case 'deleted':
      return 'REJECTED';
    case 'published':
    case 'publish':
      return 'PUBLISHED';
    default:
      return fallback;
  }
}

function buildWorkflowStatusFilter(value) {
  const token = normalizeToken(value || 'pending');
  if (!token || token === 'all') return null;

  if (token === 'pending' || token === 'under-review' || token === 'review') {
    return {
      $in: [
        'DRAFT',
        'draft',
        'SUBMITTED',
        'submitted',
        'NEW',
        'AI_REVIEWED',
        'UNDER_REVIEW',
        'NEEDS_REVISION',
        'PENDING_FOUNDER',
        'needs_revision',
        'needs revision',
        'pending',
        'new',
        'ai_reviewed',
        'under_review',
        'pending_founder',
        'pending_founder_review',
      ],
    };
  }

  if (token === 'approved') {
    return { $in: ['APPROVED', 'approved'] };
  }

  if (token === 'draft') {
    return { $in: ['DRAFT', 'draft'] };
  }

  if (token === 'submitted') {
    return { $in: ['SUBMITTED', 'submitted'] };
  }

  if (token === 'needs-revision' || token === 'needsrevision' || token === 'revision-requested') {
    return { $in: ['NEEDS_REVISION', 'needs_revision', 'needs revision', 'revision_requested'] };
  }

  if (token === 'rejected') {
    return { $in: ['REJECTED', 'rejected'] };
  }

  if (token === 'published') {
    return { $in: ['PUBLISHED', 'published'] };
  }

  if (token === 'ai-reviewed' || token === 'aireviewed') {
    return { $in: ['AI_REVIEWED', 'ai_reviewed'] };
  }

  const canonical = normalizeWorkflowStatus(token, null);
  if (canonical) {
    return { $in: [canonical, canonical.toLowerCase()] };
  }

  return value;
}

function inferSubmissionDeskMetadata(payload = {}) {
  const story = payload.story && typeof payload.story === 'object' ? payload.story : {};
  const directTrack = normalizeTrackValue(
    payload.track || payload.subcategory || story.track || story.subcategory || null
  );
  const categoryTrack = normalizeTrackValue(payload.category || story.category || null);
  const desk = normalizeDeskValue(
    payload.desk || payload.submissionDesk || story.desk || payload.intakeDesk || null
  );
  const submissionType = normalizeDeskValue(payload.submissionType || story.submissionType || null);
  const intakeSource = normalizeDeskValue(payload.intakeSource || story.intakeSource || null);

  const track = directTrack || categoryTrack;
  const isYouthPulse = desk === YOUTH_PULSE_DESK || submissionType === YOUTH_PULSE_DESK || intakeSource === YOUTH_PULSE_DESK || !!track;

  return {
    desk: isYouthPulse ? YOUTH_PULSE_DESK : desk,
    submissionType: isYouthPulse ? YOUTH_PULSE_DESK : submissionType,
    intakeSource: isYouthPulse ? YOUTH_PULSE_DESK : intakeSource,
    track: isYouthPulse ? (track || YOUTH_PULSE_DESK) : track,
    isYouthPulse,
  };
}

function normalizeAttachmentEntry(entry) {
  if (!entry) return null;

  if (typeof entry === 'string') {
    const url = entry.trim();
    return url ? { url } : null;
  }

  if (typeof entry !== 'object') return null;

  const url = String(entry.url || entry.path || entry.href || '').trim();
  if (!url) return null;

  const out = { url };
  if (entry.name) out.name = String(entry.name).trim();
  if (entry.mimeType || entry.type || entry.contentType) {
    out.mimeType = String(entry.mimeType || entry.type || entry.contentType).trim();
  }
  if (entry.kind) out.kind = String(entry.kind).trim();
  if (entry.size !== undefined && entry.size !== null && Number.isFinite(Number(entry.size))) {
    out.size = Number(entry.size);
  }

  return out;
}

function extractSubmissionAttachments(payload = {}) {
  const attachments = [];
  const push = (entry) => {
    const normalized = normalizeAttachmentEntry(entry);
    if (normalized) attachments.push(normalized);
  };

  const lists = [
    payload.attachments,
    payload.files,
    payload.attachmentUrls,
    payload.attachmentLinks,
    payload.media,
    payload.mediaUrls,
    payload.mediaLinks,
  ];

  for (const list of lists) {
    if (Array.isArray(list)) {
      for (const entry of list) push(entry);
    }
  }

  push(payload.mediaUrl);
  push(payload.mediaLink);
  push(payload.attachmentUrl);

  return attachments.slice(0, 12);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildCommunitySourceFilter(source) {
  const token = normalizeToken(source);
  if (!token || token === 'all') return null;
  if (token === 'community') {
    return {
      $or: [
        { sourceType: 'community' },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };
  }
  if (token === 'journalist' || token === 'journalists' || token === 'verified-journalists') {
    return { sourceType: 'journalist' };
  }
  return null;
}

function buildDeskFilter(deskValue, trackValue = null) {
  const desk = normalizeDeskValue(deskValue);
  const track = normalizeTrackValue(trackValue);
  const and = [];

  if (desk === YOUTH_PULSE_DESK) {
    and.push({
      $or: [
        { desk: YOUTH_PULSE_DESK },
        { submissionType: YOUTH_PULSE_DESK },
        { intakeSource: YOUTH_PULSE_DESK },
        { track: { $in: YOUTH_PULSE_TRACKS } },
        { category: { $in: YOUTH_PULSE_TRACKS } },
        { category: YOUTH_PULSE_DESK },
      ],
    });
  } else if (desk) {
    and.push({ desk });
  }

  if (track) {
    and.push({
      $or: [
        { track },
        { category: track },
      ],
    });
  }

  if (!and.length) return null;
  return and.length === 1 ? and[0] : { $and: and };
}

function buildCommunitySubmissionAdminFilter(query = {}, options = {}) {
  const and = [{ isDeleted: { $ne: true } }];
  const sourceFilter = buildCommunitySourceFilter(query.source);
  const statusFilter = buildWorkflowStatusFilter(query.status || options.defaultStatus || 'pending');
  const deskFilter = buildDeskFilter(options.forceDesk || query.desk || query.submissionType || query.intakeSource, query.track || query.category);
  const q = String(query.q || '').trim();

  if (sourceFilter) and.push(sourceFilter);
  if (statusFilter !== null && statusFilter !== undefined) and.push({ status: statusFilter });
  if (deskFilter) and.push(deskFilter);

  if (q) {
    const regex = new RegExp(escapeRegExp(q), 'i');
    and.push({
      $or: [
        { headline: regex },
        { reporterLocation: regex },
        { 'location.city': regex },
        { 'locationDetail.city': regex },
        { city: regex },
        { reporterName: regex },
        { reporterEmail: regex },
        { category: regex },
        { desk: regex },
        { track: regex },
      ],
    });
  }

  return and.length === 1 ? and[0] : { $and: and };
}

function getSubmissionDeskMetadata(doc = {}) {
  return inferSubmissionDeskMetadata(doc || {});
}

function isYouthPulseSubmission(doc = {}) {
  return getSubmissionDeskMetadata(doc).isYouthPulse;
}

function buildSubmissionAdminView(doc = {}) {
  const meta = getSubmissionDeskMetadata(doc);
  const attachments = Array.isArray(doc.attachments) ? doc.attachments : [];
  return {
    id: doc._id && typeof doc._id.toString === 'function' ? doc._id.toString() : String(doc._id || ''),
    headline: doc.headline || doc.title || '',
    story: doc.body || doc.story || doc.content || '',
    category: doc.category || null,
    desk: meta.desk || null,
    track: meta.track || null,
    submissionType: doc.submissionType || meta.submissionType || null,
    intakeSource: doc.intakeSource || meta.intakeSource || null,
    attachments,
    location: doc.reporterLocation || (doc.location && doc.location.city) || doc.city || null,
    locationObj: doc.location || doc.locationDetail || null,
    status: doc.status || null,
    sourceType: doc.sourceType || 'community',
    reporterVerificationLevel: doc.reporterVerificationLevel || 'community_default',
    reporterId: doc.reporterId || null,
    reporterName: doc.reporterName || doc.name || (doc.contact && doc.contact.name) || null,
    reporterEmail: doc.reporterEmailNorm || doc.reporterEmail || doc.email || (doc.contact && doc.contact.email) || null,
    reporterPhone: (doc.contact && doc.contact.phone) || null,
    riskScore: typeof doc.riskScore === 'number' ? doc.riskScore : 0,
    flags: Array.isArray(doc.flags) ? doc.flags : [],
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function deriveArticleCategoryFromSubmission(submission) {
  if (isYouthPulseSubmission(submission)) return YOUTH_PULSE_DESK;
  return submission && submission.category ? submission.category : undefined;
}

function deriveArticleSourceFromSubmission(submission) {
  return isYouthPulseSubmission(submission) ? YOUTH_PULSE_DESK : 'community';
}

function deriveArticleTagsFromSubmission(submission) {
  const tags = new Set(ensureTrackTag(Array.isArray(submission && submission.aiSuggestedTags) ? submission.aiSuggestedTags : [], submission && submission.track));
  const meta = getSubmissionDeskMetadata(submission || {});
  if (meta.desk) tags.add(`desk:${meta.desk}`);
  if (meta.track) tags.add(`track:${meta.track}`);
  return Array.from(tags).filter(Boolean);
}

module.exports = {
  COMMUNITY_REPORTER_CATEGORIES,
  WORKFLOW_STATUSES,
  YOUTH_PULSE_DESK,
  YOUTH_PULSE_TRACK_DEFINITIONS,
  YOUTH_PULSE_TRACKS,
  buildYouthPulseTrackFilter,
  buildCommunitySubmissionAdminFilter,
  buildSubmissionAdminView,
  buildWorkflowStatusFilter,
  deriveArticleCategoryFromSubmission,
  deriveArticleSourceFromSubmission,
  deriveArticleTagsFromSubmission,
  ensureTrackTag,
  extractSubmissionAttachments,
  getYouthPulseTrackDefinition,
  isAllowedCommunityReporterCategory,
  getSubmissionDeskMetadata,
  inferSubmissionDeskMetadata,
  isYouthPulseSubmission,
  normalizeCommunityReporterCategory,
  normalizeDeskValue,
  normalizeTrackValue,
  normalizeWorkflowStatus,
};