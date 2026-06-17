const mongoose = require('mongoose');

const STATUS_VALUES = ['new', 'read', 'deleted'];

const adInquirySchema = new mongoose.Schema(
  {
    inquiryId: { type: String, default: null, trim: true, index: true },
    // New canonical fields expected by the Admin Panel
    advertiserName: { type: String, default: null, trim: true },
    companyName: { type: String, default: null, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, default: null, trim: true },
    message: { type: String, required: true, trim: true },
    budget: { type: String, default: null, trim: true },
    campaignType: { type: String, default: null, trim: true },
    preferredAdSlot: { type: String, default: null, trim: true },
    campaignGoal: { type: String, default: null, trim: true },
    preferredDates: { type: String, default: null, trim: true },
    placement: { type: String, default: null, trim: true },
    target: { type: String, default: null, trim: true },
    startDate: { type: String, default: null, trim: true },
    pageUrl: { type: String, default: null, trim: true },
    source: { type: String, default: null, trim: true },

    // Backward-compat fields used by older public forms/controllers
    // (Keep them optional; controllers should populate advertiserName going forward.)
    name: { type: String, default: null, trim: true },

    status: { type: String, enum: STATUS_VALUES, default: 'new', index: true },
    // When moved to trash, store the prior status so restore can return it.
    previousStatus: { type: String, enum: STATUS_VALUES },
    isRead: { type: Boolean, default: false, index: true },
    hasReply: { type: Boolean, default: false, index: true },
    replyCount: { type: Number, default: 0 },
    lastRepliedAt: { type: Date, default: null },
    lastRepliedBy: { type: String, default: null, trim: true },
    lastReplySubject: { type: String, default: null, trim: true },
    replyHistory: {
      type: [
        {
          subject: { type: String, default: null, trim: true },
          repliedAt: { type: Date, default: null },
          repliedBy: { type: String, default: null, trim: true },
        },
      ],
      default: [],
    },
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

adInquirySchema.index({ inquiryId: 1 });
adInquirySchema.index({ status: 1, createdAt: -1 });
adInquirySchema.index({ createdAt: -1 });

module.exports = mongoose.models.AdInquiry || mongoose.model('AdInquiry', adInquirySchema);
module.exports.STATUS_VALUES = STATUS_VALUES;
