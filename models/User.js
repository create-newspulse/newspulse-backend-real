const mongoose = require('mongoose');
const { normalizeOrganizationFields } = require('../lib/teamAccess');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  fullName: { type: String, default: null, trim: true },
  passwordHash: { type: String, required: true },
  staffId: { type: String, default: null, trim: true, sparse: true, index: true },
  roleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Role', default: null, index: true },
  roleName: { type: String, default: null, trim: true },
  role: {
    type: String,
    default: 'staff',
  },
  department: { type: String, default: null, trim: true },
  sections: { type: [String], default: [] },
  assignedSections: { type: [String], default: [] },
  coverageAreas: { type: [String], default: [] },

  // Team management fields (Settings Center > Team Management)
  designation: { type: String, default: null, trim: true },
  permissions: { type: [String], default: [] },
  moduleAccessOverride: { type: [String], default: [] },
  specialRightsOverride: { type: [String], default: [] },
  status: { type: String, enum: ['pending', 'active', 'suspended', 'expired', 'locked'], default: 'pending', index: true },
  accountStatus: { type: String, enum: ['active', 'suspended', 'locked', 'expired'], default: 'active', index: true },
  onlineStatus: { type: String, enum: ['online', 'idle', 'offline', 'on_break'], default: 'offline', index: true },
  // Legacy flag used by older admin/staff endpoints
  forceReset: { type: Boolean, default: false },

  // New auth / team management fields
  // Preferred flag name for admin panel UX
  mustResetPassword: { type: Boolean, default: false },
  mustChangePassword: { type: Boolean, default: false },
  tempPasswordExpiresAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 0 },
  lastLoginAt: { type: Date, default: null },
  lastLogoutAt: { type: Date, default: null },
  lastSeenAt: { type: Date, default: null },
  currentSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'SessionLog', default: null, index: true },
  currentAttendanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Attendance', default: null, index: true },
  currentBreakId: { type: mongoose.Schema.Types.ObjectId, ref: 'BreakLog', default: null, index: true },
  failedLoginCount: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  accessExpiresAt: { type: Date, default: null },
  isFounder: { type: Boolean, default: false, index: true },
  isProtected: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

userSchema.pre('save', function touchUpdatedAt(next) {
  this.updatedAt = new Date();
  if (!this.fullName && this.name) this.fullName = this.name;

  const organization = normalizeOrganizationFields({
    role: this.role,
    department: this.department,
    assignedSections: this.assignedSections,
    coverageAreas: this.coverageAreas,
    sections: this.sections,
  });
  this.department = organization.department;
  this.assignedSections = organization.assignedSections;
  this.coverageAreas = organization.coverageAreas;
  this.sections = organization.sections;

  if (String(this.role || '').toLowerCase() === 'founder') {
    this.isFounder = true;
    this.isProtected = true;
    this.status = 'active';
    this.accountStatus = 'active';
  }
  next();
});

function removeSensitiveUserFields(_doc, ret) {
  delete ret.passwordHash;
  return ret;
}

userSchema.set('toJSON', { transform: removeSensitiveUserFields });
userSchema.set('toObject', { transform: removeSensitiveUserFields });

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
