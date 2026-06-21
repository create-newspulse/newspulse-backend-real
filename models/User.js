const mongoose = require('mongoose');
const { normalizeOrganizationFields } = require('../lib/teamAccess');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  emailHistory: {
    type: [{
      oldEmail: { type: String, required: true, lowercase: true, trim: true },
      newEmail: { type: String, required: true, lowercase: true, trim: true },
      changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      changedAt: { type: Date, default: Date.now },
      reason: { type: String, default: '', trim: true },
    }],
    default: [],
  },
  emailVerified: { type: Boolean, default: false },
  pendingEmail: { type: String, default: null, lowercase: true, trim: true },
  lastEmailChangedAt: { type: Date, default: null },
  recoveryEmail: { type: String, default: null, lowercase: true, trim: true },
  name: { type: String, required: true },
  fullName: { type: String, default: null, trim: true },
  passwordHash: { type: String, required: true },
  staffId: { type: String, default: null, trim: true, sparse: true, unique: true, index: true },
  staffIdGeneratedAt: { type: Date, default: null },
  staffIdLocked: { type: Boolean, default: false, index: true },
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
  loginAllowed: { type: Boolean, default: true, index: true },
  accountNote: { type: String, default: null, trim: true },
  onlineStatus: { type: String, enum: ['online', 'idle', 'offline', 'on_break'], default: 'offline', index: true },
  // Legacy flag used by older admin/staff endpoints
  forceReset: { type: Boolean, default: false },

  // New auth / team management fields
  // Preferred flag name for admin panel UX
  mustResetPassword: { type: Boolean, default: false },
  mustChangePassword: { type: Boolean, default: false },
  tempPasswordExpiresAt: { type: Date, default: null },
  tokenVersion: { type: Number, default: 0 },
  sessionsRevokedAt: { type: Date, default: null },
  resetTokensRevokedAt: { type: Date, default: null },
  lastPasswordChangedAt: { type: Date, default: null },
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
  isOwner: { type: Boolean, default: false, index: true },
  isProtected: { type: Boolean, default: false, index: true },
  fullAccess: { type: Boolean, default: false },
  canBeDeleted: { type: Boolean, default: true },
  canBeSuspended: { type: Boolean, default: true },
  canBeDemoted: { type: Boolean, default: true },
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

  if (this.staffId) {
    this.staffId = String(this.staffId).trim().toUpperCase();
    this.staffIdLocked = true;
    if (!this.staffIdGeneratedAt) this.staffIdGeneratedAt = this.createdAt || new Date();
  }

  if (String(this.role || '').toLowerCase() === 'founder') {
    this.isFounder = true;
    this.isOwner = true;
    this.isProtected = true;
    this.fullAccess = true;
    this.canBeDeleted = false;
    this.canBeSuspended = false;
    this.canBeDemoted = false;
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
