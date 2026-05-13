const mongoose = require('mongoose');

const ComplianceReportSchema = new mongoose.Schema({
  month: { type: String, required: true, trim: true },
  year: { type: Number, required: true },
  label: { type: String, required: true, trim: true },
  publishedDate: { type: String, trim: true, default: '' },
  complaintsReceived: { type: Number, default: 0, min: 0 },
  complaintsResolved: { type: Number, default: 0, min: 0 },
  averageResponseTime: { type: String, trim: true, default: '' },
  complaintsPending: { type: Number, default: 0, min: 0 },
  actionTakenOnOrders: { type: String, trim: true, default: '' },
  note: { type: String, trim: true, default: '' },
  status: { type: String, enum: ['Draft', 'Published'], default: 'Draft' },
  createdBy: { type: String, trim: true },
  updatedBy: { type: String, trim: true },
}, { timestamps: true });

ComplianceReportSchema.virtual('grievancesReceived')
  .get(function getGrievancesReceived() {
    return this.complaintsReceived;
  })
  .set(function setGrievancesReceived(value) {
    this.complaintsReceived = value;
  });

ComplianceReportSchema.virtual('grievancesResolved')
  .get(function getGrievancesResolved() {
    return this.complaintsResolved;
  })
  .set(function setGrievancesResolved(value) {
    this.complaintsResolved = value;
  });

ComplianceReportSchema.virtual('grievancesPending')
  .get(function getGrievancesPending() {
    return this.complaintsPending;
  })
  .set(function setGrievancesPending(value) {
    this.complaintsPending = value;
  });

ComplianceReportSchema.set('toJSON', { virtuals: true });
ComplianceReportSchema.set('toObject', { virtuals: true });

ComplianceReportSchema.index(
  { year: 1, month: 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 },
  },
);

module.exports = mongoose.models.ComplianceReport || mongoose.model('ComplianceReport', ComplianceReportSchema);