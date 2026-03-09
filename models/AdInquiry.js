const mongoose = require('mongoose');

const STATUS_VALUES = ['new', 'read', 'closed', 'spam'];

const adInquirySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, required: true, trim: true },
    status: { type: String, enum: STATUS_VALUES, default: 'new', index: true },
  },
  {
    timestamps: true,
  }
);

adInquirySchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.models.AdInquiry || mongoose.model('AdInquiry', adInquirySchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
