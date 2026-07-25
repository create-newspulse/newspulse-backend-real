const mongoose = require('mongoose');
const { canonicalizeSlug, slugifyUnicode } = require('../lib/slug');
const { YOUTH_PULSE_TRACKS, normalizeTrackValue } = require('../services/communitySubmissionWorkflow');

// Workflow stages
// Admin panel (new) expects lowercase identifiers.
// Keep uppercase variants for backward compatibility with existing data.
const WORKFLOW_STAGES_LOWER = [
  'draft',
  'copy_edit',
  'legal_review',
  'editor_approval',
  'founder_approval',
  'scheduled',
  'published',
];

const WORKFLOW_STAGES_UPPER = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
  // legacy stages used by other routes
  'ARCHIVED',
  'REJECTED',
];

const WORKFLOW_STAGES = [...WORKFLOW_STAGES_LOWER, ...WORKFLOW_STAGES_UPPER];

const WORKFLOW_CHAIN_STAGES = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
];

const TRANSLATION_PROVIDER_VALUES = ['google', 'openai', 'manual'];
const EDITORIAL_TYPE_VALUES = ['editorial', 'special_story'];
const TRANSLATION_REVIEW_STATUS_VALUES = ['none', 'review_required', 'reviewed', 'approved', 'translation_outdated'];

function normalizeEditorialType(v) {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!s) return undefined;
  return EDITORIAL_TYPE_VALUES.includes(s) ? s : v;
}

function normalizeLanguageCode(v) {
  if (v === null || v === undefined) return v;
  const raw = String(v).trim();
  if (!raw) return 'en';
  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';
  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;
  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj' || lettersOnly === 'gj') return 'gu';
  return lower;
}

function normalizeTranslationProvider(v) {
  if (v === null || v === undefined) return 'google';
  const s = String(v).trim().toLowerCase();
  if (!s) return 'google';
  return TRANSLATION_PROVIDER_VALUES.includes(s) ? s : 'google';
}

function normalizeTranslationStatus(v) {
  if (v === null || v === undefined) return 'pending';
  const s = String(v).trim().toLowerCase();
  if (s === 'pending' || s === 'ready' || s === 'failed') return s;
  return 'pending';
}

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  content: String,
  slug: { type: String, index: true },
  // Per-language slugs used for language-specific URLs.
  // Keep legacy `slug` for backward compatibility.
  slugs: {
    en: { type: String, default: null, index: true },
    hi: { type: String, default: null, index: true },
    gu: { type: String, default: null, index: true },
  },
  tags: [String],

  // Canonical geo slugs for regional lookups.
  // Populated from tags like "state:gujarat", "district:gandhinagar", "city:gandhinagar".
  geo: {
    state: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? slugifyUnicode(s, { maxLength: 80 }) : null;
      },
    },
    district: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? slugifyUnicode(s, { maxLength: 80 }) : null;
      },
    },
    city: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? slugifyUnicode(s, { maxLength: 80 }) : null;
      },
    },
  },
  category: {
    type: String,
    index: true,
    set: (v) => {
      if (v === null || v === undefined) return v;
      return String(v).trim().toLowerCase();
    },
  },
  editorialType: {
    type: String,
    enum: EDITORIAL_TYPE_VALUES,
    default: undefined,
    index: true,
    set: normalizeEditorialType,
  },
  track: {
    type: String,
    enum: [...YOUTH_PULSE_TRACKS, null],
    default: null,
    index: true,
    set: (v) => {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      return normalizeTrackValue(v);
    },
  },
  // Canonical request/query param is `lang` for News.
  // Keep `language` too for backward compatibility with older clients/docs.
  lang: {
    type: String,
    enum: ['en', 'hi', 'gu'],
    default: 'en',
    index: true,
    set: normalizeLanguageCode,
  },
  language: {
    type: String,
    enum: ['en', 'hi', 'gu'],
    default: 'en',
    index: true,
    set: normalizeLanguageCode,
  },

  // Language of the original authored content (source for translations).
  // Keep nullable for legacy docs; public read path may detect from content.
  originalLang: { type: String, enum: ['en', 'hi', 'gu', null], default: null, index: true },
  // Cached translations to make language switching instant.
  // NOTE: Summary is stored as `description` in this model, but clients may treat it as summary.
  translations: {
    en: {
      title: { type: String, default: '' },
      summary: { type: String, default: '' },
      content: { type: String, default: '' },
      provider: {
        type: String,
        enum: TRANSLATION_PROVIDER_VALUES,
        default: 'google',
        required: false,
        set: normalizeTranslationProvider,
      },
      generatedAt: { type: Date, default: null },
    },
    hi: {
      title: { type: String, default: '' },
      summary: { type: String, default: '' },
      content: { type: String, default: '' },
      provider: {
        type: String,
        enum: TRANSLATION_PROVIDER_VALUES,
        default: 'google',
        required: false,
        set: normalizeTranslationProvider,
      },
      generatedAt: { type: Date, default: null },
    },
    gu: {
      title: { type: String, default: '' },
      summary: { type: String, default: '' },
      content: { type: String, default: '' },
      provider: {
        type: String,
        enum: TRANSLATION_PROVIDER_VALUES,
        default: 'google',
        required: false,
        set: normalizeTranslationProvider,
      },
      generatedAt: { type: Date, default: null },
    },
  },

  // Background translation status (publish should never block on translation).
  // NOTE: Stored on the CMS/admin News doc; public Article copy is synced separately.
  translationStatus: {
    en: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending', set: normalizeTranslationStatus },
    hi: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending', set: normalizeTranslationStatus },
    gu: { type: String, enum: ['pending', 'ready', 'failed'], default: 'pending', set: normalizeTranslationStatus },
  },
  translationError: {
    en: { type: String, default: null },
    hi: { type: String, default: null },
    gu: { type: String, default: null },
  },
  translationNextRetryAt: {
    en: { type: Date, default: null },
    hi: { type: Date, default: null },
    gu: { type: Date, default: null },
  },

  // Timestamp for last status transition per language (used to detect stuck pending states).
  translationUpdatedAt: {
    en: { type: Date, default: null },
    hi: { type: Date, default: null },
    gu: { type: Date, default: null },
  },
  // New canonical group key for translations. Keep translationGroupId for backward compatibility.
  translationKey: { type: String, index: true },
  translationGroupId: { type: String, index: true },
  syncMode: { type: String, enum: ['auto'], default: 'auto', index: true },
  sourceArticleId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  sourceLanguage: { type: String, enum: ['en', 'hi', 'gu', null], default: null, index: true },
  machineGenerated: { type: Boolean, default: false, index: true },
  humanEdited: { type: Boolean, default: false, index: true },
  translationReviewStatus: {
    type: String,
    enum: TRANSLATION_REVIEW_STATUS_VALUES,
    default: 'none',
    index: true,
  },
  translatedAt: { type: Date, default: null },
  translatedByProvider: { type: String, default: null, index: true },
  sourceHash: { type: String, default: null, index: true },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  translationJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'TranslationJob', default: null, index: true },
  translationMeta: {
    provider: { type: String, default: null },
    sourceArticleId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceLanguage: { type: String, enum: ['en', 'hi', 'gu', null], default: null },
    sourceHash: { type: String, default: null },
    targetLanguage: { type: String, enum: ['en', 'hi', 'gu', null], default: null },
    machineGenerated: { type: Boolean, default: false },
    humanEdited: { type: Boolean, default: false },
    translatedAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    sourceFields: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  lastSyncedAt: { type: Date, default: null, index: true },
  syncVersion: { type: Number, default: 0 },
  contentFingerprint: { type: String, default: null },
  topic: {
    type: String,
    index: true,
    set: (v) => {
      if (v === null || v === undefined) return v;
      const s = String(v).trim();
      return s ? s.toLowerCase() : s;
    },
  },
  location: {
    state: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? s : null;
      },
    },
    stateSlug: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? slugifyUnicode(s, { maxLength: 80 }) : null;
      },
    },
    city: {
      type: String,
      default: null,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? s : null;
      },
    },
    citySlug: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? slugifyUnicode(s, { maxLength: 80 }) : null;
      },
    },
    district: {
      type: String,
      default: null,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? s : null;
      },
    },
    districtSlug: {
      type: String,
      default: null,
      index: true,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? slugifyUnicode(s, { maxLength: 80 }) : null;
      },
    },
    isUT: { type: Boolean, default: null },
    country: {
      type: String,
      default: null,
      set: (v) => {
        if (v === null || v === undefined) return v;
        const s = String(v).trim();
        return s ? s : null;
      },
    },
  },

  // Auto-tags for National articles (used for state-wise national filtering)
  stateTags: { type: [String], default: [], index: true },
  stateNames: { type: [String], default: [] },
  date: { type: Date, default: Date.now },
  imageURL: String,
  coverImageUrl: String,
  coverImage: {
    url: { type: String, default: null },
    publicId: { type: String, default: null },
    alt: { type: String, default: null },
  },
  externalUrls: { type: [String], default: [] },
  embeds: { type: [String], default: [] },
  gallery: { type: [String], default: [] },
  seo: {
    metaTitle: { type: String, default: null },
    metaDescription: { type: String, default: null },
    canonicalUrl: { type: String, default: null },
  },

  // Canonical workflow object used by Admin Panel workflow screen.
  // Keep legacy top-level fields below for backward compatibility.
  workflow: {
    stage: { type: String, enum: WORKFLOW_CHAIN_STAGES, default: 'DRAFT', index: true },
    risk: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'], default: 'UNKNOWN', index: true },
    locked: { type: Boolean, default: false },
    embargoUntil: { type: Date, default: null },
    lastMovedAt: { type: Date, default: Date.now, index: true },
    lastMovedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: {
      type: [
        {
          at: { type: Date, default: Date.now },
          by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          text: { type: String, default: '' },
        },
      ],
      default: [],
    },
  },

  // Workflow
  // Lowercase is the canonical value for admin workflow APIs.
  // Uppercase values may still exist in older documents; they remain allowed.
  workflowStage: { type: String, enum: WORKFLOW_STAGES, default: 'draft', index: true },
  // Timestamp used by workflow queue for stage "entered" time.
  // If absent, APIs fall back to workflow.lastMovedAt/workflowUpdatedAt.
  workflowStageEnteredAt: { type: Date, default: Date.now, index: true },
  locked: { type: Boolean, default: false },
  // Optional admin workflow flag
  requiresFounderApproval: { type: Boolean, default: false },
  // Optional card label (UI-friendly). If absent, derive from workflow.risk.
  riskLabel: { type: String, enum: ['Low', 'Medium', 'High', 'Unknown'], default: 'Unknown', index: true },
  embargoUntil: { type: Date, default: null },
  workflowUpdatedAt: { type: Date, default: Date.now, index: true },
  workflowHistory: {
    type: [
      {
        at: { type: Date, default: Date.now },
        byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        byRole: { type: String, default: '' },
        action: { type: String, default: '' },
        fromStage: { type: String, default: null },
        toStage: { type: String, default: null },
        note: { type: String, default: null },
      },
    ],
    default: [],
  },
  internalComments: {
    type: [
      {
        at: { type: Date, default: Date.now },
        byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        byRole: { type: String, default: '' },
        message: { type: String, default: '' },
      },
    ],
    default: [],
  },

  views: { type: Number, default: 0 },
  // Admin workflow fields
  status: { type: String, default: 'draft', enum: ['draft', 'scheduled', 'published', 'archived', 'deleted'] },
  scheduledAt: { type: Date, default: null },
  publishAt: { type: Date, default: null },
  publishedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  spotlightEnabled: { type: Boolean, default: false },
  spotlightPinned: { type: Boolean, default: false },
  spotlightPriority: { type: Number, default: 0 },
  spotlightExpiresAt: { type: Date, default: null },
  isSponsored: { type: Boolean, default: false, index: true },
  isSponsoredArticle: { type: Boolean, default: false, index: true },
  sponsorName: { type: String, default: null },
  sponsorLabel: { type: String, default: 'Sponsored' },
  sponsorDisclosure: { type: String, default: null },
  sponsorCtaText: { type: String, default: null },
  sponsorCtaUrl: { type: String, default: null },
  sponsorFeatureEligible: { type: Boolean, default: false },
  sponsorFeatureLinkedId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  // Provenance (optional)
  source: { type: String, index: true }, // e.g. 'community', 'editor'
  sourceType: { type: String, default: null, index: true },
  sourceLabel: { type: String, default: null },
  submissionSource: { type: String, default: null, index: true },
  sourceTrack: {
    type: String,
    enum: [...YOUTH_PULSE_TRACKS, null],
    default: null,
    index: true,
    set: (v) => {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      return normalizeTrackValue(v);
    },
  },
  originType: { type: String, default: null, index: true },
  youthPulseSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'YouthPulseSubmission', default: null, index: true },
  youthPulseContributorId: { type: mongoose.Schema.Types.ObjectId, ref: 'YouthPulseContributor', default: null, index: true },
  communityReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunitySubmission', index: true },
}, { timestamps: true });

// Store slugs as plain Unicode (not percent-encoded) so lookups are stable across clients.
newsSchema.pre('validate', function preValidate(next) {
  try {
    if (this.isModified('slug')) {
      this.slug = canonicalizeSlug(this.slug);
    }

    if (this.slugs && typeof this.slugs === 'object') {
      for (const k of ['en', 'hi', 'gu']) {
        if (this.slugs[k] !== undefined && this.slugs[k] !== null) {
          this.slugs[k] = canonicalizeSlug(this.slugs[k]);
        }
      }
    }

    // If caller only set per-language slugs, keep legacy `slug` aligned for older lookups.
    const docLang = String(this.lang || this.language || 'en').trim().toLowerCase();
    if ((!this.slug || !String(this.slug).trim()) && this.slugs && this.slugs[docLang]) {
      this.slug = this.slugs[docLang];
    }

    const category = String(this.category || '').trim().toLowerCase();
    if (category === 'editorial') {
      if (!this.editorialType) this.editorialType = 'editorial';
    } else if (this.editorialType !== undefined) {
      this.editorialType = undefined;
    }

    // Normalize and store location slugs for stable regional filtering.
    // Keep slugs aligned with the human-readable location fields.
    if (!this.location || typeof this.location !== 'object') {
      this.location = {};
    }

    const state = this.location.state;
    const district = this.location.district;
    const city = this.location.city;

    if (state === null || state === undefined || String(state).trim() === '') {
      this.location.stateSlug = null;
    } else if (!this.location.stateSlug || this.isModified('location.state')) {
      this.location.stateSlug = slugifyUnicode(String(state), { maxLength: 80 }) || null;
    }

    if (district === null || district === undefined || String(district).trim() === '') {
      this.location.districtSlug = null;
    } else if (!this.location.districtSlug || this.isModified('location.district')) {
      this.location.districtSlug = slugifyUnicode(String(district), { maxLength: 80 }) || null;
    }

    if (city === null || city === undefined || String(city).trim() === '') {
      this.location.citySlug = null;
    } else if (!this.location.citySlug || this.isModified('location.city')) {
      this.location.citySlug = slugifyUnicode(String(city), { maxLength: 80 }) || null;
    }

    // Legacy repair: provider=null is not valid for enum provider.
    // Ensure any full translation bucket has provider + generatedAt.
    try {
      const translations = this.translations && typeof this.translations === 'object' ? this.translations : null;
      if (translations) {
        const hasFull = (b) => {
          const bucket = b && typeof b === 'object' ? b : {};
          return Boolean(String(bucket.title || '').trim() && String(bucket.summary || '').trim() && String(bucket.content || '').trim());
        };

        for (const lang of ['en', 'hi', 'gu']) {
          const b = translations[lang];
          if (!b || typeof b !== 'object') continue;
          if (b.provider === null || b.provider === undefined || String(b.provider).trim() === '') b.provider = 'google';
          if (hasFull(b) && !b.generatedAt) b.generatedAt = new Date();
        }
      }
    } catch (_) {}

    // Legacy repair: translationStatus may be null/invalid.
    try {
      if (!this.translationStatus || typeof this.translationStatus !== 'object' || Array.isArray(this.translationStatus)) {
        this.translationStatus = {};
      }
      for (const lang of ['en', 'hi', 'gu']) {
        const v = this.translationStatus[lang];
        this.translationStatus[lang] = normalizeTranslationStatus(v);
      }
    } catch (_) {}

    return next();
  } catch (e) {
    return next(e);
  }
});

// Virtual alias so UI can use `body` consistently
newsSchema.virtual('body')
  .get(function() { return this.content; })
  .set(function(v) { this.content = v; });

newsSchema.set('toJSON', { virtuals: true });
newsSchema.set('toObject', { virtuals: true });

newsSchema.post('save', async function syncYouthPulseSubmission(doc) {
  try {
    if (!doc || String(doc.sourceType || '').trim().toLowerCase() !== 'youth_pulse') return;
    if (!doc.youthPulseSubmissionId || !mongoose.isValidObjectId(String(doc.youthPulseSubmissionId))) return;

    const YouthPulseSubmission = require('./YouthPulseSubmission');
    const { syncYouthPulseContributorStats } = require('../services/youthPulseContributor.service');
    const submission = await YouthPulseSubmission.findById(doc.youthPulseSubmissionId);
    if (!submission) return;

    submission.linkedDraftId = doc._id;
    if (doc.status === 'published') {
      submission.linkedArticleId = doc._id;
      submission.publishedAt = doc.publishedAt || new Date();
      submission.status = 'published';
    } else if (submission.status !== 'published') {
      submission.status = 'draft_created';
    }

    await submission.save();

    if (submission.contributorId) {
      await syncYouthPulseContributorStats(submission.contributorId).catch(() => null);
    }
  } catch (_) {}
});

// Indexes for workflow board
newsSchema.index({ workflowStage: 1, workflowUpdatedAt: -1 });
newsSchema.index({ status: 1, createdAt: -1 });
newsSchema.index({ scheduledAt: 1 });
newsSchema.index({ category: 1, status: 1, stateTags: 1, publishedAt: -1 });
newsSchema.index({ status: 1, category: 1, 'geo.state': 1, 'geo.district': 1, 'geo.city': 1, publishedAt: -1 });
newsSchema.index({ translationKey: 1, lang: 1, status: 1, publishedAt: -1 });
newsSchema.index({ translationGroupId: 1, lang: 1, status: 1, publishedAt: -1 });
newsSchema.index({ topic: 1, status: 1, publishedAt: -1 });
newsSchema.index({ 'location.state': 1, status: 1, publishedAt: -1 });
newsSchema.index({ 'slugs.en': 1 });
newsSchema.index({ 'slugs.hi': 1 });
newsSchema.index({ 'slugs.gu': 1 });

// Avoid OverwriteModelError when multiple apps import this model.
module.exports = mongoose.models.News || mongoose.model('News', newsSchema);
