const mongoose = require('mongoose');

const WORKFLOW_STAGES = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
  'ARCHIVED',
  'REJECTED',
];

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
  category: String,
  date: { type: Date, default: Date.now },
  imageURL: String,
  coverImageUrl: String,
  status: { type: String, default: 'draft' },
  publishAt: { type: Date, default: null },
  publishedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },

  // Canonical workflow object used by Admin Panel workflow screen.
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

  workflowStage: { type: String, enum: WORKFLOW_STAGES, default: 'DRAFT', index: true },
  locked: { type: Boolean, default: false },
  embargoUntil: { type: Date, default: null },
  scheduledAt: { type: Date, default: null },
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
});

newsSchema.index({ workflowStage: 1, workflowUpdatedAt: -1 });
newsSchema.index({ status: 1, createdAt: -1 });
newsSchema.index({ scheduledAt: 1 });

// Avoid OverwriteModelError when model already exists
module.exports = mongoose.models.News || mongoose.model('News', newsSchema);
