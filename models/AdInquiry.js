const mongoose = require('mongoose');

const STATUS_VALUES = ['new', 'read', 'deleted'];

const adInquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: STATUS_VALUES, default: 'new', index: true },
    readAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    meta: {
      ip: { type: String, default: null },
      userAgent: { type: String, default: null },
      // Store as "referrer" (double-r) in DB; accept/keep "referer" for backward compatibility.
      referrer: { type: String, default: null },
      referer: { type: String, default: null },
      site: { type: String, default: null },
    },
  },
  {
    timestamps: true,
  }
);

adInquirySchema.index({ status: 1, createdAt: -1 });
adInquirySchema.index({ createdAt: -1 });
adInquirySchema.index({ email: 1 });

module.exports = mongoose.models.AdInquiry || mongoose.model('AdInquiry', adInquirySchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
