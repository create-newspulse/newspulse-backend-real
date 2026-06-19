const mongoose = require('mongoose');

const financeRecordSchema = new mongoose.Schema({
  type: { type: String, enum: ['invoice', 'expense', 'receipt', 'revenue', 'monthly_report'], required: true, index: true },
  title: { type: String, default: '', trim: true },
  amount: { type: Number, default: 0 },
  currency: { type: String, default: 'INR', trim: true, uppercase: true },
  status: { type: String, default: 'draft', trim: true, index: true },
  sponsorName: { type: String, default: '', trim: true },
  invoiceNumber: { type: String, default: '', trim: true, index: true },
  receiptUrl: { type: String, default: '', trim: true },
  period: { type: String, default: '', trim: true, index: true },
  dueDate: { type: Date, default: null },
  paidAt: { type: Date, default: null },
  notes: { type: String, default: '', trim: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

financeRecordSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  next();
});

financeRecordSchema.index({ type: 1, createdAt: -1 });
financeRecordSchema.index({ type: 1, period: 1 });

module.exports = mongoose.models.FinanceRecord || mongoose.model('FinanceRecord', financeRecordSchema);