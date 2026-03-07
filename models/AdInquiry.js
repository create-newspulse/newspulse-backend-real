const mongoose = require('mongoose');

const STATUS_VALUES = ['new', 'read'];

const adInquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: STATUS_VALUES, default: 'new', index: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

adInquirySchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.AdInquiry || mongoose.model('AdInquiry', adInquirySchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
