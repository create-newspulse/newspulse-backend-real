const mongoose = require('mongoose');

const YouthPulseContributorSchema = new mongoose.Schema(
  {
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, index: true, unique: true },
    mobile: { type: String, default: null, trim: true },
    college: { type: String, default: null, trim: true },
    city: { type: String, default: null, trim: true },
    state: { type: String, default: null, trim: true },
    totalSubmissions: { type: Number, default: 0 },
    totalApproved: { type: Number, default: 0 },
    totalPublished: { type: Number, default: 0 },
    lastSubmissionAt: { type: Date, default: null, index: true },
    notes: { type: String, default: null, trim: true },
    status: { type: String, enum: ['active', 'blocked', 'trusted'], default: 'active', index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.models.YouthPulseContributor || mongoose.model('YouthPulseContributor', YouthPulseContributorSchema);