const mongoose = require('mongoose');

const roleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  description: { type: String, default: '', trim: true },
  sortOrder: { type: Number, default: 100, index: true },
  isSystemRole: { type: Boolean, default: false, index: true },
  isProtected: { type: Boolean, default: false, index: true },
  moduleAccess: { type: [String], default: [] },
  specialRights: { type: [String], default: [] },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

roleSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  if (String(this.slug || '').toLowerCase() === 'founder') {
    this.isSystemRole = true;
    this.isProtected = true;
  }
  next();
});

module.exports = mongoose.models.Role || mongoose.model('Role', roleSchema);