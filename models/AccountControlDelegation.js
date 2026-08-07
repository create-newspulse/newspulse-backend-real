const mongoose = require('mongoose');

const ACCOUNT_CONTROL_DELEGATED_RIGHTS = Object.freeze([
  'view_staff_registry',
  'create_staff_account',
  'edit_staff_details',
  'extend_account_expiry',
  'reactivate_expired_account',
  'suspend_staff_account',
  'lock_staff_account',
  'unlock_staff_account',
  'reset_temporary_password',
  'force_password_change',
  'logout_staff_sessions',
  'archive_staff_account',
  'assign_staff_access',
  'assign_staff_tasks',
]);

const MANAGEABLE_ACCOUNT_TYPES = Object.freeze([
  'management_staff',
  'field_network_staff',
  'newsroom_staff',
  'intern',
]);

const accountControlDelegationSchema = new mongoose.Schema(
  {
    delegatedToStaffId: { type: String, required: true, trim: true, uppercase: true, index: true },
    grantedRights: { type: [String], default: [] },
    manageableAccountTypes: { type: [String], default: [] },
    startsAt: { type: Date, default: Date.now, index: true },
    expiresAt: { type: Date, default: null, index: true },
    active: { type: Boolean, default: true, index: true },
    appointedByFounderId: { type: String, required: true, trim: true },
    auditReason: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

accountControlDelegationSchema.pre('save', function normalizeDelegation(next) {
  const rightSet = new Set(ACCOUNT_CONTROL_DELEGATED_RIGHTS);
  const typeSet = new Set(MANAGEABLE_ACCOUNT_TYPES);
  this.delegatedToStaffId = String(this.delegatedToStaffId || '').trim().toUpperCase();
  this.grantedRights = Array.from(new Set((this.grantedRights || []).map((right) => String(right || '').trim()).filter((right) => rightSet.has(right))));
  this.manageableAccountTypes = Array.from(new Set((this.manageableAccountTypes || []).map((type) => String(type || '').trim()).filter((type) => typeSet.has(type))));
  next();
});

module.exports = mongoose.models.AccountControlDelegation || mongoose.model('AccountControlDelegation', accountControlDelegationSchema);
module.exports.ACCOUNT_CONTROL_DELEGATED_RIGHTS = ACCOUNT_CONTROL_DELEGATED_RIGHTS;
module.exports.MANAGEABLE_ACCOUNT_TYPES = MANAGEABLE_ACCOUNT_TYPES;