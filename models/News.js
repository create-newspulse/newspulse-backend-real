const mongoose = require('mongoose');

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

const newsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  content: String,
  slug: { type: String, index: true },
  tags: [String],
  category: { type: String, index: true },
  language: { type: String, enum: ['en', 'hi', 'gu'], default: 'en', index: true },
  translationGroupId: { type: String, index: true },
  date: { type: Date, default: Date.now },
  imageURL: String,
  coverImageUrl: String,

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
  // Provenance (optional)
  source: { type: String, index: true }, // e.g. 'community', 'editor'
  communityReportId: { type: mongoose.Schema.Types.ObjectId, ref: 'CommunitySubmission', index: true },
}, { timestamps: true });

// Virtual alias so UI can use `body` consistently
newsSchema.virtual('body')
  .get(function() { return this.content; })
  .set(function(v) { this.content = v; });

newsSchema.set('toJSON', { virtuals: true });
newsSchema.set('toObject', { virtuals: true });

// Indexes for workflow board
newsSchema.index({ workflowStage: 1, workflowUpdatedAt: -1 });
newsSchema.index({ status: 1, createdAt: -1 });
newsSchema.index({ scheduledAt: 1 });

// Avoid OverwriteModelError when multiple apps import this model.
module.exports = mongoose.models.News || mongoose.model('News', newsSchema);
