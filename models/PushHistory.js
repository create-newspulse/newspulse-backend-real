const mongoose = require('mongoose');

const PUSH_ACTIONS = [
  'publish',
  'unpublish',
  'schedule',
  'archive',
  'delete',
  'edit',
  'reject',
  'approve',
];

const PUSH_TYPES = [
  'workflow',
  'publish',
];

const pushHistorySchema = new mongoose.Schema({
  articleId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', index: true, required: true },
  type: { type: String, enum: PUSH_TYPES, default: 'publish', index: true },
  // Action is used by the admin panel for audit/history views.
  action: { type: String, enum: PUSH_ACTIONS, default: 'edit', index: true },
  // New workflow-admin push history fields
  titleSnapshot: { type: String, default: null },
  slugSnapshot: { type: String, default: null, index: true },
  language: { type: String, default: null, index: true },
  category: { type: String, default: null, index: true },
  pushedTo: { type: String, enum: ['PUBLIC_SITE'], default: 'PUBLIC_SITE', index: true },
  status: { type: String, enum: ['SUCCESS', 'FAILED'], default: 'SUCCESS', index: true },
  error: { type: String, default: null },
  at: { type: Date, default: Date.now, index: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  // Backward-compat fields used by other code paths
  slug: { type: String, default: null, index: true },
  title: { type: String, default: null },
  channel: { type: String, enum: ['SITE'], default: 'SITE', index: true },
  byUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // meta is intentionally flexible; admin workflow uses these keys when present:
  // { oldStatus, newStatus, oldStage, newStage }
  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

pushHistorySchema.index({ articleId: 1, at: -1 });

module.exports = mongoose.models.PushHistory || mongoose.model('PushHistory', pushHistorySchema);
