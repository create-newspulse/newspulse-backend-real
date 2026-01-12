const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  passwordHash: { type: String, required: true },
  role: {
    type: String,
    default: 'staff',
  },

  // Team management fields (Settings Center > Team Management)
  designation: { type: String, default: null, trim: true },
  permissions: { type: [String], default: [] },
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
  // Legacy flag used by older admin/staff endpoints
  forceReset: { type: Boolean, default: false },

  // New auth / team management fields
  // Preferred flag name for admin panel UX
  mustResetPassword: { type: Boolean, default: false },
  mustChangePassword: { type: Boolean, default: false },
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
