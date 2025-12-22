const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'admin' },

  // Team management fields (Settings Center > Team Management)
  designation: { type: String, default: null, trim: true },
  permissions: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
  forceReset: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
