const mongoose = require('mongoose');

const STAGES = [
  'DRAFT',
  'COPY_EDIT',
  'LEGAL_REVIEW',
  'EDITOR_APPROVAL',
  'FOUNDER_APPROVAL',
  'SCHEDULED',
  'PUBLISHED',
];

const workflowEventSchema = new mongoose.Schema({
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', required: true, index: true },
  fromStage: { type: String, enum: STAGES, required: true },
  toStage: { type: String, enum: STAGES, required: true },
  action: { type: String, default: 'MOVE_STAGE', index: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  at: { type: Date, default: Date.now, index: true },
  meta: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

workflowEventSchema.index({ articleId: 1, at: -1 });

module.exports = mongoose.models.WorkflowEvent || mongoose.model('WorkflowEvent', workflowEventSchema);
