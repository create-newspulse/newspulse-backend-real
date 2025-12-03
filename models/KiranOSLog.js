const mongoose = require('mongoose');

// KiranOS Lite analytics log
// Logs user questions for monitoring and improvement.
const kiranOSLogSchema = new mongoose.Schema({
  question: { type: String, required: true },
  language: { type: String, enum: ['en','hi','gu'], default: 'en', index: true },
  articleId: { type: String },
  source: { type: String, enum: ['mobile','web'], default: 'mobile', index: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

module.exports = mongoose.model('KiranOSLog', kiranOSLogSchema);
