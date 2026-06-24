const mongoose = require('mongoose');

const staffTaskCommentSchema = new mongoose.Schema(
  {
    staffId: { type: String, default: null, trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    message: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const staffTaskAttachmentSchema = new mongoose.Schema(
  {
    name: { type: String, default: null, trim: true },
    url: { type: String, default: null, trim: true },
    type: { type: String, default: null, trim: true },
  },
  { _id: false },
);

const staffTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: '', trim: true },
    accountGroup: { type: String, default: null, trim: true, index: true },
    taskCategory: { type: String, required: true, trim: true, index: true },
    taskLevel: { type: String, required: true, trim: true, index: true },
    assignedToStaffId: { type: String, default: null, trim: true, index: true },
    assignedByStaffId: { type: String, default: null, trim: true, index: true },
    department: { type: String, default: null, trim: true, index: true },
    coverageArea: { type: String, default: null, trim: true },
    priority: { type: String, enum: ['Low', 'Normal', 'High', 'Urgent'], default: 'Normal', index: true },
    status: { type: String, default: 'Assigned', index: true },
    dueDate: { type: Date, default: null, index: true },
    relatedModule: { type: String, default: null, trim: true, index: true },
    relatedNewsId: { type: mongoose.Schema.Types.ObjectId, ref: 'News', default: null, index: true },
    attachments: { type: [staffTaskAttachmentSchema], default: [] },
    comments: { type: [staffTaskCommentSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    completedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    auditId: { type: mongoose.Schema.Types.ObjectId, ref: 'AuditLog', default: null },
  },
  { timestamps: true, collection: 'staff_tasks' },
);

staffTaskSchema.index({ createdAt: -1 });
staffTaskSchema.index({ assignedToStaffId: 1, status: 1 });

module.exports = mongoose.models.StaffTask || mongoose.model('StaffTask', staffTaskSchema);