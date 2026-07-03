const mongoose = require('mongoose');

const REQUEST_TYPE_VALUES = [
  'access',
  'correction',
  'deletion',
  'withdraw_consent',
  'grievance',
  'other',
];

const STATUS_VALUES = [
  'Pending Email Verification',
  'Verified',
  'In Review',
  'Need More Details',
  'Completed',
  'Rejected',
  'Spam/Fake',
  'Closed',
];

const privacyRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true, index: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true },
    mobile: { type: String, default: null, trim: true },
    requestType: { type: String, required: true, enum: REQUEST_TYPE_VALUES, index: true },
    message: { type: String, required: true, trim: true },
    referenceId: { type: String, default: null, trim: true },
    source: { type: String, default: 'Frontend Form', trim: true },
    status: { type: String, enum: STATUS_VALUES, default: 'Pending Email Verification', index: true },
    verificationTokenHash: { type: String, default: null, index: true },
    verificationTokenExpiresAt: { type: Date, default: null, index: true },
    verificationResendHistory: { type: [Date], default: [] },
    verifiedAt: { type: Date, default: null },
    adminNote: { type: String, default: null, trim: true },
    handledBy: { type: String, default: null, trim: true },
    actionTakenSummary: { type: String, default: null, trim: true },
    replySentAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'privacy_requests' },
);

privacyRequestSchema.index({ status: 1, createdAt: -1 });
privacyRequestSchema.index({ requestType: 1, createdAt: -1 });

module.exports = mongoose.models.PrivacyRequest || mongoose.model('PrivacyRequest', privacyRequestSchema);
module.exports.REQUEST_TYPE_VALUES = REQUEST_TYPE_VALUES;
module.exports.STATUS_VALUES = STATUS_VALUES;
