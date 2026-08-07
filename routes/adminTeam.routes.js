const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const News = require('../models/News');
const FinanceRecord = require('../models/FinanceRecord');
const AuditLog = require('../models/AuditLog');
const OtpToken = require('../models/OtpToken');
const Role = require('../models/Role');
const SessionLog = require('../models/SessionLog');
const StaffTask = require('../models/StaffTask');
const AccountControlDelegation = require('../models/AccountControlDelegation');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAuth, requireModuleAccess, requireTaskRight } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');
const {
  ACCOUNT_STATUS,
  hasNoExpiry,
  isAccountExpired,
  isFounderAccount,
  lifecycleStatus,
} = require('../lib/accountLifecycle');
const {
  FOUNDER_STAFF_ID,
  ensureUserStaffId,
  previewNextStaffId,
  retireStaffId,
  resolveStaffIdForNewUser,
} = require('../lib/staffId');
const {
  AUTH_PERMISSIONS,
  ADMIN_MODULE_KEYS,
  ACCOUNT_CONTROL_RIGHT_KEYS,
  DEFAULT_TASK_TEMPLATES,
  SPECIAL_RIGHT_KEYS,
  SPECIAL_RIGHT_GROUPS,
  FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS,
  FOUNDER_ONLY_MODULES,
  FOUNDER_ONLY_RIGHTS,
  ROLE_DEFAULT_ACCESS,
  ROLE_DEPARTMENT_DEFAULTS,
  STAFF_CONTROL_CENTER,
  TASK_CATEGORIES,
  TASK_LEVELS,
  TASK_RIGHT_KEYS,
  TASK_STATUSES,
  TEAM_ASSIGNED_SECTIONS,
  TEAM_COVERAGE_AREAS,
  TEAM_DEPARTMENTS,
  TEAM_ROLES,
  buildRolesWorkflow,
  computeEffectiveAccess,
  defaultDepartmentForRole,
  hasPermission,
  isFounderRole,
  isProtectedFounderUser,
  legacyPermissionsFromRights,
  normalizeModuleAccess,
  normalizeAccountControlRights,
  normalizeOrganizationFields,
  normalizePermissions,
  normalizeRole,
  normalizeSpecialRights,
  normalizeStatus,
  normalizeStringList,
  normalizeTaskRights,
  normalizeTemporaryAccessList,
  requirePasswordPolicy,
  safeUserDto,
} = require('../lib/teamAccess');
const {
  CANONICAL_TO_LEGACY_MODULE,
  canonicalModuleKey,
  evaluateAllModuleAccess,
  getFounderModulePolicy,
  normalizeStaffModuleStates,
  parseStaffModuleAccessPayload,
} = require('../services/founderAccessPolicyService');

const router = express.Router();
const FOUNDER_PROTECTED_MESSAGE = 'Founder account is protected. Use Founder My Account / Safe Zone.';
const PROTECTED_FOUNDER_EMAIL = 'kiran@newspulse.co.in';
const STAFF_MANAGE_GRANTS = Object.freeze(['staff_manage', 'staff.manage', 'team.manage']);
const { ACCOUNT_CONTROL_DELEGATED_RIGHTS, MANAGEABLE_ACCOUNT_TYPES } = AccountControlDelegation;
const DELEGATED_RIGHT_TO_LEGACY_RIGHT = Object.freeze({
  view_staff_registry: 'staff_view_details',
  create_staff_account: null,
  edit_staff_details: 'staff_edit_basic',
  extend_account_expiry: 'staff_extend_access',
  reactivate_expired_account: 'staff_reactivate',
  suspend_staff_account: 'staff_suspend',
  lock_staff_account: 'staff_lock',
  unlock_staff_account: 'staff_lock',
  reset_temporary_password: 'staff_reset_password',
  force_password_change: 'staff_force_password_change',
  logout_staff_sessions: 'staff_logout_devices',
  archive_staff_account: 'staff_archive',
  assign_staff_access: null,
  assign_staff_tasks: null,
});

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, ...data });
}

function bad(res, status, message, code) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function authBad(res, status, code) {
  if (status === 401) return bad(res, 401, 'Unauthorized. Please login again.', code || 'UNAUTHORIZED');
  if (status === 403) return bad(res, 403, 'Access denied. Founder permission required.', code || 'FORBIDDEN');
  return bad(res, status, status === 403 ? 'Forbidden' : 'Unauthorized', code);
}

function syncReqUserFromAdmin(req) {
  if (!req.admin) return;
  req.user = {
    id: req.admin.id || null,
    email: req.admin.email || null,
    name: req.admin.name || null,
    role: req.admin.role || null,
    staffId: req.admin.staffId || null,
    moduleAccess: Array.isArray(req.admin.moduleAccess) ? req.admin.moduleAccess : [],
    permissions: Array.isArray(req.admin.permissions) ? req.admin.permissions : [],
    specialRights: Array.isArray(req.admin.specialRights) ? req.admin.specialRights : [],
    taskRights: Array.isArray(req.admin.taskRights) ? req.admin.taskRights : [],
    accountControlRights: Array.isArray(req.admin.accountControlRights) ? req.admin.accountControlRights : [],
    status: req.admin.status || 'active',
    mustChangePassword: Boolean(req.admin.mustChangePassword),
    tokenVersion: typeof req.admin.tokenVersion === 'number' ? req.admin.tokenVersion : 0,
    isFounder: Boolean(req.admin.isFounder || normalizeRole(req.admin.role) === 'founder'),
    isProtected: Boolean(req.admin.isProtected || normalizeRole(req.admin.role) === 'founder'),
  };
}

function hasAdminCredential(req) {
  const authHeader = String(req.headers.authorization || '');
  const cookieHeader = String(req.headers.cookie || '');
  return authHeader.toLowerCase().startsWith('bearer ')
    || /(?:^|;\s*)np_admin(?:=|_email=|_session=|_access=|_token=)/.test(cookieHeader);
}

function requireTeamAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) return requireAuth(req, res, next);
  if (!hasAdminCredential(req)) return authBad(res, 401, 'UNAUTHORIZED');

  return requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return next(err);
    syncReqUserFromAdmin(req);
    return next();
  });
}

function requirePermanentDeleteAuth(req, res, next) {
  const originalStatus = res.status.bind(res);
  const originalJson = res.json.bind(res);
  let currentStatus = 200;

  res.status = (status) => {
    currentStatus = status;
    return originalStatus(status);
  };
  res.json = (payload) => {
    const payloadStatus = payload && typeof payload === 'object' ? Number(payload.status || 0) : 0;
    if (currentStatus === 401 || payloadStatus === 401) {
      const body = payload && typeof payload === 'object' ? payload : {};
      return originalJson({
        ...body,
        ok: false,
        success: false,
        status: 401,
        code: body.code || 'UNAUTHORIZED',
        message: 'Session expired. Please login again.',
      });
    }
    return originalJson(payload);
  };

  return requireTeamAuth(req, res, (err) => {
    res.status = originalStatus;
    res.json = originalJson;
    if (err) return next(err);
    return next();
  });
}

function requireTeamPermission(permission) {
  return (req, res, next) => {
    if (!req.user) return authBad(res, 401, 'UNAUTHORIZED');
    if (!hasStaffActionPermission(req.user, permission)) return authBad(res, 403, 'FORBIDDEN');
    return next();
  };
}

function hasStaffActionPermission(user, permission) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (hasPermission(user, permission) || hasPermission(user, 'team.manage')) return true;
  const accountRights = new Set(Array.isArray(user.accountControlRights) ? user.accountControlRights : []);
  const permissionToAccountRight = {
    'auth.change_staff_email': 'staff_change_email',
    'auth.reset_password': 'staff_reset_password',
    'auth.generate_temp_password': 'staff_generate_temp_password',
    'auth.force_password_change': 'staff_force_password_change',
    'auth.suspend_user': 'staff_suspend',
    'auth.lock_user': 'staff_lock',
    'auth.logout_user_sessions': 'staff_logout_devices',
    'auth.view_login_activity': 'staff_view_details',
  };
  if (permissionToAccountRight[permission] && accountRights.has(permissionToAccountRight[permission])) return true;
  const granted = new Set([
    ...(Array.isArray(user.permissions) ? user.permissions : []),
    ...(Array.isArray(user.specialRights) ? user.specialRights : []),
  ].map((value) => String(value || '').trim()).filter(Boolean));
  return STAFF_MANAGE_GRANTS.some((grant) => granted.has(grant));
}

function requireFounderActor(req, res, next) {
  if (!req.user) return authBad(res, 401, 'UNAUTHORIZED');
  if (!isFounderRole(req.user.role) && !req.user.isFounder) return authBad(res, 403, 'FOUNDER_REQUIRED');
  return next();
}

function ensureDb(res) {
  if (isDbReady()) return true;
  bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');
  return false;
}

function generateTempPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

async function hashPassword(password) {
  const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
  return bcrypt.hash(String(password), rounds);
}

async function findUserById(id, res) {
  if (!mongoose.isValidObjectId(String(id))) {
    bad(res, 400, 'Invalid id', 'INVALID_ID');
    return null;
  }
  const user = await User.findById(String(id));
  if (!user) {
    bad(res, 404, 'Not found', 'NOT_FOUND');
    return null;
  }
  return user;
}

async function findUserByIdOrStaffId(id, res) {
  const raw = String(id || '').trim();
  if (!raw) {
    bad(res, 400, 'Invalid id', 'INVALID_ID');
    return null;
  }
  if (/^NP-[A-Z0-9-]+$/i.test(raw)) {
    const user = await User.findOne({ staffId: raw.toUpperCase() });
    if (!user) {
      bad(res, 404, 'Not found', 'NOT_FOUND');
      return null;
    }
    return user;
  }
  if (mongoose.isValidObjectId(raw)) return findUserById(raw, res);
  const user = await User.findOne({ staffId: raw.toUpperCase() });
  if (!user) {
    bad(res, 404, 'Not found', 'NOT_FOUND');
    return null;
  }
  return user;
}

async function blockFounderStaffAction(req, res, user, attemptedAction) {
  await logAudit(req, 'BLOCKED_FOUNDER_STAFF_ACTION', user?._id ? String(user._id) : req.params?.id || null, {
    attemptedAction,
    staffId: user?.staffId || null,
    targetRole: user?.role || null,
  });
  return bad(res, 403, FOUNDER_PROTECTED_MESSAGE, 'FOUNDER_PROTECTED');
}

async function ensureMutableStaffTarget(req, res, user, attemptedAction) {
  const staffId = String(user?.staffId || '').trim().toUpperCase();
  if (!isProtectedFounderUser(user) && staffId !== FOUNDER_STAFF_ID) return true;
  await blockFounderStaffAction(req, res, user, attemptedAction);
  return false;
}

function actorId(req) {
  return mongoose.isValidObjectId(req.user?.id) ? req.user.id : null;
}

function userListQuery(options = {}) {
  const base = { $or: [{ role: { $in: TEAM_ROLES } }, { roleId: { $exists: true, $ne: null } }, { staffId: { $exists: true, $ne: null } }] };
  const filters = [base];
  if (!options.includeArchived) filters.push({ status: { $ne: 'archived' } }, { accountStatus: { $ne: 'archived' } }, { isArchived: { $ne: true } });
  if (!options.includeDeleted) filters.push({ status: { $nin: ['deleted', 'deleted_test'] } }, { accountStatus: { $nin: ['deleted', 'deleted_test'] } }, { isDeleted: { $ne: true } }, { deletedAt: { $in: [null, undefined] } });
  if (!options.includeTest) filters.push({ isTestAccount: { $ne: true } });
  return filters.length === 1 ? base : { $and: filters };
}

function parseDateOrNull(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

function pickDateAlias(body, primary, alias) {
  return body[primary] !== undefined ? body[primary] : body[alias];
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
}

function resolveAccessExpiryInput(body, fallbackDate = null) {
  const input = body && typeof body === 'object' ? body : {};
  const preset = String(input.expiryPreset || input.accessPeriod || input.duration || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (input.noExpiry === true || input.setNoExpiry === true || input.permanent === true || preset === 'no_expiry' || preset === 'none' || preset === 'permanent') {
    return { accessExpiresAt: null, noExpiry: true, preset: 'no_expiry' };
  }
  const now = new Date();
  if (preset === '30_days' || preset === '30_day') return { accessExpiresAt: addDays(now, 30), noExpiry: false, preset: '30_days' };
  if (preset === '90_days' || preset === '90_day') return { accessExpiresAt: addDays(now, 90), noExpiry: false, preset: '90_days' };
  if (preset === '6_months' || preset === '6_month') return { accessExpiresAt: addMonths(now, 6), noExpiry: false, preset: '6_months' };
  if (preset === '1_year' || preset === 'one_year') return { accessExpiresAt: addMonths(now, 12), noExpiry: false, preset: '1_year' };
  const rawDate = pickDateAlias(input, 'accessExpiresAt', 'accessExpiryDate');
  const customRaw = rawDate !== undefined ? rawDate : input.customDate;
  if (customRaw !== undefined) {
    const parsed = parseDateOrNull(customRaw);
    if (parsed === undefined) return { error: { status: 400, message: 'Invalid accessExpiryDate', code: 'INVALID_DATE' } };
    if (parsed === null) return { accessExpiresAt: null, noExpiry: true, preset: 'no_expiry' };
    return { accessExpiresAt: parsed, noExpiry: false, preset: 'custom' };
  }
  return { accessExpiresAt: fallbackDate || null, noExpiry: fallbackDate ? false : true, preset: fallbackDate ? 'existing' : 'no_expiry' };
}

async function auditAccountLifecycle(req, action, targetUserId, beforeValue, afterValue, extra = {}) {
  await logAudit(req, action, targetUserId, {
    oldValue: beforeValue,
    newValue: afterValue,
    before: beforeValue,
    after: afterValue,
    actorStaffId: req.user?.staffId || null,
    actorRole: req.user?.role || null,
    targetStaffId: extra.targetStaffId || null,
    reason: auditReasonFromBody(req.body) || extra.reason || null,
    ...extra,
  });
}

function normalizeRequestedStaffId(value) {
  const raw = String(value || '').trim();
  if (!raw) return undefined;
  if (/next\s+new\s+staff\s+id/i.test(raw)) return undefined;
  return raw;
}

async function assignTemporaryPassword(userOrId, options = {}) {
  const tempPassword = options.temporaryPassword || generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const now = new Date();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const id = typeof userOrId === 'object' && userOrId?._id ? userOrId._id : userOrId;
  await markUserSessionsRevoked(id, now, options.sessionReason || 'staff_password_changed');
  const update = {
    $set: {
      passwordHash,
      mustChangePassword: true,
      mustResetPassword: true,
      forceReset: true,
      tempPasswordExpiresAt: expiresAt,
      sessionsRevokedAt: now,
      currentSessionId: null,
      onlineStatus: 'offline',
      lastLogoutAt: now,
      updatedAt: now,
    },
    $inc: { tokenVersion: 1 },
  };

  const updated = await User.findByIdAndUpdate(id, update, { new: true });
  return { updated, tempPassword, tempPasswordExpiresAt: expiresAt };
}

function resolveTemporaryPasswordInput(body) {
  const supplied = body && body.temporaryPassword !== undefined ? String(body.temporaryPassword || '') : '';
  if (!supplied) return { temporaryPassword: null, provided: false };
  if (body.allowProvidedTemporaryPassword !== true) {
    return { error: { status: 400, message: 'Provided temporaryPassword requires allowProvidedTemporaryPassword=true', code: 'TEMP_PASSWORD_NOT_CONFIRMED_SAFE' } };
  }
  const policy = requirePasswordPolicy(supplied);
  if (!policy.ok) return { error: { status: 400, message: policy.message, code: 'WEAK_PASSWORD' } };
  return { temporaryPassword: supplied, provided: true };
}

function roleSlugFromName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s*&\s*/g, '-')
    .replace(/\s*\/\s*/g, '-')
    .replace(/\s+/g, '-');
}

function roleFallbackForPosition(position) {
  const normalized = String(position || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const map = {
    founder: 'founder',
    manager: 'manager',
    'hr & admin': 'manager',
    'finance & accounts': 'finance & accounts manager',
    'ads & revenue growth': 'ads & revenue growth manager',
    'chief editor': 'editor',
    'tech support': 'tech support',
    'grievance officer': 'fact checker',
    'seo executive': 'copy editor',
    'marketing manager': 'social media manager',
    'bureau chief': 'manager',
    'state coordinator': 'reporter',
    'district reporter': 'reporter',
    'community reporter coordinator': 'reporter',
    'editorial head': 'editor',
    'copy editor': 'copy editor',
    reporter: 'reporter',
    'live tv controller': 'live tv controller',
    'video editor': 'video editor',
    'social media': 'social media manager',
    'ads marketing': 'ads & revenue growth manager',
    intern: 'intern',
  };
  return map[normalized] || null;
}

function defaultTasksForPosition(position) {
  const key = STAFF_CONTROL_CENTER.positions.find((item) => item.toLowerCase() === String(position || '').trim().toLowerCase());
  return key && DEFAULT_TASK_TEMPLATES[key] ? DEFAULT_TASK_TEMPLATES[key].slice() : [];
}

function normalizeAccountGroup(value) {
  const raw = String(value || '').trim();
  return STAFF_CONTROL_CENTER.accountGroups.find((group) => group.toLowerCase() === raw.toLowerCase()) || null;
}

function normalizePosition(value) {
  const raw = String(value || '').trim();
  return STAFF_CONTROL_CENTER.positions.find((position) => position.toLowerCase() === raw.toLowerCase()) || null;
}

async function loadRoleFromInput(body) {
  if (!isDbReady()) return null;
  if (body.roleId && mongoose.isValidObjectId(String(body.roleId))) {
    const role = await Role.findById(String(body.roleId)).lean();
    if (role) return role;
  }
  if (!body.roleSlug) return null;
  const slug = roleSlugFromName(body.roleSlug);
  if (!slug) return null;
  return Role.findOne({ slug }).lean();
}

function includesFounderOnlyAccess(moduleAccess, specialRights) {
  const modules = new Set(normalizeModuleAccess(moduleAccess));
  const rights = new Set(normalizeSpecialRights(specialRights));
  return FOUNDER_ONLY_MODULES.some((key) => modules.has(key)) || FOUNDER_ONLY_RIGHTS.some((key) => rights.has(key));
}

function actorIsFounder(req) {
  return Boolean(req.user?.isFounder || isFounderRole(req.user?.role));
}

const SHARED_SYSTEM_EMAILS = Object.freeze([
  'newspulse.team@gmail.com',
  'newspulse.admin@gmail.com',
  'newspulse.ads@gmail.com',
]);

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function actorCanChangeStaffEmail(req) {
  if (hasStaffActionPermission(req.user, 'auth.change_staff_email')) return true;
  return Array.isArray(req.user?.specialRights) && req.user.specialRights.includes('staff_email_change');
}

function requireTeamAccountControlRight(rightKey, fallbackPermission = null) {
  return (req, res, next) => {
    if (!req.user) return authBad(res, 401, 'UNAUTHORIZED');
    if (actorIsFounder(req)) return next();
    const accountRights = new Set(Array.isArray(req.user.accountControlRights) ? req.user.accountControlRights : []);
    if (accountRights.has(rightKey)) return next();
    if (fallbackPermission && hasStaffActionPermission(req.user, fallbackPermission)) return next();
    return bad(res, 403, 'Action denied. Founder permission is required.', 'FORBIDDEN');
  };
}

function normalizeDelegatedRights(value) {
  const allowed = new Set(ACCOUNT_CONTROL_DELEGATED_RIGHTS);
  const source = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of source) {
    const right = String(raw || '').trim();
    if (!allowed.has(right) || seen.has(right)) continue;
    seen.add(right);
    out.push(right);
  }
  return out;
}

function normalizeManageableAccountTypes(value) {
  const allowed = new Set(MANAGEABLE_ACCOUNT_TYPES);
  const source = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const raw of source) {
    const type = String(raw || '').trim().toLowerCase();
    if (!allowed.has(type) || seen.has(type)) continue;
    seen.add(type);
    out.push(type);
  }
  return out;
}

function accountTypeForUser(user) {
  if (!user || isFounderAccount(user)) return null;
  const role = normalizeRole(user.role);
  const position = String(user.position || user.officialTitle || user.designation || '').trim().toLowerCase();
  const group = String(user.accountGroup || '').trim().toLowerCase();
  const department = String(user.department || '').trim().toLowerCase();
  if (role === 'intern' || position.includes('intern') || group.includes('intern') || department.includes('intern')) return 'intern';
  if (group.includes('field') || department.includes('field') || ['reporter'].includes(role) || position.includes('reporter') || position.includes('coordinator') || position.includes('bureau')) return 'field_network_staff';
  if (group.includes('newsroom') || department.includes('newsroom') || department.includes('editorial') || ['editor', 'copy editor', 'fact checker', 'live tv controller', 'video editor', 'social media manager'].includes(role) || position.includes('editor')) return 'newsroom_staff';
  return 'management_staff';
}

function delegationDto(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: obj._id ? String(obj._id) : null,
    _id: obj._id ? String(obj._id) : null,
    delegatedToStaffId: obj.delegatedToStaffId || null,
    grantedRights: normalizeDelegatedRights(obj.grantedRights),
    manageableAccountTypes: normalizeManageableAccountTypes(obj.manageableAccountTypes),
    startsAt: obj.startsAt || null,
    expiresAt: obj.expiresAt || null,
    active: obj.active !== false,
    appointedByFounderId: obj.appointedByFounderId || null,
    auditReason: obj.auditReason || null,
    createdAt: obj.createdAt || null,
    updatedAt: obj.updatedAt || null,
  };
}

function delegationActiveForRight(delegation, rightKey, targetType, now = new Date()) {
  if (!delegation || delegation.active === false) return false;
  const startsAt = delegation.startsAt ? new Date(delegation.startsAt) : null;
  const expiresAt = delegation.expiresAt ? new Date(delegation.expiresAt) : null;
  if (startsAt && !Number.isNaN(startsAt.getTime()) && startsAt > now) return false;
  if (expiresAt && (!Number.isNaN(expiresAt.getTime()) && expiresAt <= now)) return false;
  if (!normalizeDelegatedRights(delegation.grantedRights).includes(rightKey)) return false;
  return normalizeManageableAccountTypes(delegation.manageableAccountTypes).includes(targetType);
}

async function findValidDelegation(actor, rightKey, targetType, now = new Date()) {
  const staffId = String(actor?.staffId || '').trim().toUpperCase();
  if (!staffId || !rightKey || !targetType) return null;
  const query = { delegatedToStaffId: staffId, active: true };
  const found = AccountControlDelegation.find ? await AccountControlDelegation.find(query).lean() : [];
  return (found || []).find((delegation) => delegationActiveForRight(delegation, rightKey, targetType, now)) || null;
}

async function actorHasDelegatedRight(req, rightKey, targetUser) {
  if (actorIsFounder(req)) return { ok: true, founder: true };
  if (!targetUser || isFounderAccount(targetUser)) return { ok: false, code: 'FOUNDER_PROTECTED' };
  const targetType = accountTypeForUser(targetUser);
  const delegation = await findValidDelegation(req.user, rightKey, targetType);
  if (delegation) return { ok: true, delegation };

  const legacyRight = DELEGATED_RIGHT_TO_LEGACY_RIGHT[rightKey];
  const explicitRights = new Set(Array.isArray(req.user?.accountControlRights) ? req.user.accountControlRights : []);
  if (legacyRight && explicitRights.has(legacyRight)) return { ok: true, legacyRight };
  return { ok: false, code: 'DELEGATED_RIGHT_REQUIRED' };
}

function requireDelegatedAccountControlRight(rightKey) {
  return async (req, res, next) => {
    if (!req.user) return authBad(res, 401, 'UNAUTHORIZED');
    if (actorIsFounder(req)) return next();
    const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
    if (!user) return;
    req.accountControlTargetUser = user;
    const decision = await actorHasDelegatedRight(req, rightKey, user);
    if (decision.ok) {
      req.accountControlDelegation = decision.delegation || null;
      return next();
    }
    if (decision.code === 'FOUNDER_PROTECTED') return bad(res, 403, FOUNDER_PROTECTED_MESSAGE, 'FOUNDER_PROTECTED');
    return bad(res, 403, 'Delegated account-control right required.', 'FORBIDDEN');
  };
}

function requireDelegatedRegistryRight(rightKey) {
  return async (req, res, next) => {
    if (!req.user) return authBad(res, 401, 'UNAUTHORIZED');
    if (actorIsFounder(req)) return next();
    const staffId = String(req.user.staffId || '').trim().toUpperCase();
    if (!staffId) return bad(res, 403, 'Delegated account-control right required.', 'FORBIDDEN');
    const found = AccountControlDelegation.find ? await AccountControlDelegation.find({ delegatedToStaffId: staffId, active: true }).lean() : [];
    const active = (found || []).some((delegation) => {
      const rights = normalizeDelegatedRights(delegation.grantedRights);
      const types = normalizeManageableAccountTypes(delegation.manageableAccountTypes);
      const startsAt = delegation.startsAt ? new Date(delegation.startsAt) : null;
      const expiresAt = delegation.expiresAt ? new Date(delegation.expiresAt) : null;
      const now = new Date();
      return rights.includes(rightKey)
        && types.length > 0
        && (!startsAt || Number.isNaN(startsAt.getTime()) || startsAt <= now)
        && (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt > now)
        && delegation.active !== false;
    });
    if (active) return next();
    return bad(res, 403, 'Delegated account-control right required.', 'FORBIDDEN');
  };
}

function sharedSystemMailboxAllowed(req, body) {
  return actorIsFounder(req) && body?.allowSharedSystemMailbox === true;
}

async function markUserSessionsRevoked(userId, revokedAt, reason = 'staff_action') {
  await SessionLog.updateMany(
    { userId, status: 'active' },
    { $set: { status: 'ended', logoutAt: revokedAt, lastSeenAt: revokedAt, logoutReason: String(reason || 'staff_action').slice(0, 120) } },
  );
}

async function revokeResetTokensForEmail(email, revokedAt) {
  await OtpToken.updateMany(
    { email, used: false },
    {
      $set: {
        used: true,
        status: 'replaced',
        replacedAt: revokedAt,
        resetToken: null,
        resetTokenExpiresAt: revokedAt,
      },
    },
  );
}

async function auditStaffEmail(req, action, targetUserId, meta = {}) {
  await logAudit(req, action, targetUserId, {
    actorId: req.user?.id || null,
    targetUserId: targetUserId ? String(targetUserId) : null,
    timestamp: new Date().toISOString(),
    ...meta,
  });
}

function staffIdMigrationEnabled(req, body) {
  return actorIsFounder(req)
    && String(process.env.ALLOW_STAFF_ID_MIGRATION || '').trim() === '1'
    && Boolean(body?.allowStaffIdMigration);
}

async function resolveRoleAssignment(req, body, fallbackRole) {
  const roleDoc = await loadRoleFromInput(body);
  if (roleDoc) {
    if (roleDoc.slug === 'founder') return { error: { status: 403, message: 'Founder account is protected', code: 'FOUNDER_PROTECTED' } };
    if (!actorIsFounder(req) && includesFounderOnlyAccess(roleDoc.moduleAccess, roleDoc.specialRights)) {
      return { error: { status: 403, message: 'Founder role required', code: 'FOUNDER_REQUIRED' } };
    }
    return {
      roleId: roleDoc._id,
      roleName: roleDoc.name,
      role: roleDoc.slug,
      roleDoc,
    };
  }

  const role = normalizeRole(body.role || body.roleName || fallbackRole || 'intern');
  if (!role) return { error: { status: 400, message: 'Invalid role', code: 'INVALID_ROLE' } };
  if (role === 'founder') return { error: { status: 403, message: 'Founder account is protected', code: 'FOUNDER_PROTECTED' } };
  if (role === 'admin' && !actorIsFounder(req)) return { error: { status: 403, message: 'Only Founder can assign Admin role', code: 'FOUNDER_REQUIRED' } };
  if (!actorIsFounder(req) && includesFounderOnlyAccess(ROLE_DEFAULT_ACCESS[role]?.moduleAccess, ROLE_DEFAULT_ACCESS[role]?.specialRights)) {
    return { error: { status: 403, message: 'Founder role required', code: 'FOUNDER_REQUIRED' } };
  }
  return { role, roleName: role };
}

function parseAccessOverride(req, body) {
  const hasModules = body.moduleAccessOverride !== undefined || body.moduleAccess !== undefined;
  const hasRights = body.specialRightsOverride !== undefined || body.specialRights !== undefined;
  if (!hasModules && !hasRights) return { patch: {}, audit: [] };
  if (!actorIsFounder(req)) return { error: { status: 403, message: 'Founder role required', code: 'FOUNDER_REQUIRED' } };

  const moduleAccessOverride = hasModules ? normalizeModuleAccess(body.moduleAccessOverride || body.moduleAccess) : undefined;
  const requestedRights = hasRights ? normalizeSpecialRights(body.specialRightsOverride || body.specialRights) : undefined;
  const specialRightsOverride = hasRights ? requestedRights.filter((key) => !FOUNDER_ONLY_RIGHTS.includes(key)) : undefined;
  const blockedFounderOnly = hasRights ? requestedRights.filter((key) => FOUNDER_ONLY_RIGHTS.includes(key)) : [];
  return {
    patch: {
      ...(hasModules ? { moduleAccessOverride } : {}),
      ...(hasRights ? { specialRightsOverride, permissions: mergeLegacyPermissions(body.permissions, specialRightsOverride) } : {}),
    },
    blockedFounderOnly,
    audit: [
      ...(hasModules ? ['moduleAccessOverride'] : []),
      ...(hasRights ? ['specialRightsOverride'] : []),
    ],
  };
}

function normalizeTemporaryAccessInput(req, value) {
  if (value === undefined) return { entries: [] };
  if (!Array.isArray(value)) return { error: { status: 400, message: 'temporaryAccess must be an array', code: 'INVALID_TEMPORARY_ACCESS' } };
  const entries = [];
  const now = new Date();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return { error: { status: 400, message: 'Invalid temporaryAccess entry', code: 'INVALID_TEMPORARY_ACCESS' } };
    const moduleKey = raw.moduleKey && ADMIN_MODULE_KEYS.includes(String(raw.moduleKey).trim()) ? String(raw.moduleKey).trim() : null;
    const rightKey = raw.rightKey && SPECIAL_RIGHT_KEYS.includes(String(raw.rightKey).trim()) ? String(raw.rightKey).trim() : null;
    if (!moduleKey && !rightKey) return { error: { status: 400, message: 'Each temporaryAccess entry requires a valid moduleKey or rightKey', code: 'INVALID_TEMPORARY_TARGET' } };
    if (rightKey && FOUNDER_ONLY_RIGHTS.includes(rightKey)) return { error: { status: 403, message: 'Founder-only rights cannot be granted temporarily', code: 'FOUNDER_ONLY_RIGHT' } };
    const expiresAt = parseDateOrNull(raw.expiresAt);
    if (expiresAt === undefined) return { error: { status: 400, message: 'Invalid temporaryAccess expiresAt', code: 'INVALID_DATE' } };
    if (expiresAt && expiresAt <= now) return { error: { status: 400, message: 'temporaryAccess expiresAt must be in the future', code: 'INVALID_DATE' } };
    entries.push({
      _id: new mongoose.Types.ObjectId(),
      moduleKey,
      rightKey,
      enabled: raw.enabled !== false,
      expiresAt: expiresAt || null,
      reason: String(raw.reason || '').trim().slice(0, 500) || null,
      grantedBy: actorId(req),
      grantedAt: now,
    });
  }
  return { entries };
}

function mergeLegacyPermissions(existingPermissions, rights) {
  const out = [];
  const seen = new Set();
  for (const value of [...normalizePermissions(existingPermissions), ...legacyPermissionsFromRights(rights)]) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function rawDepartmentProvided(value) {
  return value !== undefined && value !== null && String(value || '').trim() !== '';
}

function normalizeUserOrganizationInput(body, role, currentUser = null) {
  const roleValue = role || currentUser?.role || null;
  const departmentInput = body.department !== undefined ? body.department : currentUser?.department;
  if (body.assignedSections !== undefined && !Array.isArray(body.assignedSections)) {
    return { error: { status: 400, message: 'assignedSections must be an array', code: 'INVALID_ASSIGNED_SECTIONS' } };
  }
  if (body.coverageAreas !== undefined && !Array.isArray(body.coverageAreas)) {
    return { error: { status: 400, message: 'coverageAreas must be an array', code: 'INVALID_COVERAGE_AREAS' } };
  }
  const assignedInput = body.assignedSections !== undefined
    ? body.assignedSections
    : (body.sections !== undefined
      ? body.sections
      : ((Array.isArray(currentUser?.assignedSections) && currentUser.assignedSections.length)
        ? currentUser.assignedSections
        : currentUser?.sections));
  const coverageInput = body.coverageAreas !== undefined
    ? body.coverageAreas
    : (body.coverageArea !== undefined
      ? (Array.isArray(body.coverageArea) ? body.coverageArea : [body.coverageArea])
      : currentUser?.coverageAreas);

  const organization = normalizeOrganizationFields({
    role: roleValue,
    department: departmentInput,
    assignedSections: assignedInput,
    coverageAreas: coverageInput,
    sections: assignedInput,
  });

  if (rawDepartmentProvided(body.department) && !organization.department) {
    return { error: { status: 400, message: 'Invalid department', code: 'INVALID_DEPARTMENT' } };
  }

  return {
    department: organization.department || defaultDepartmentForRole(roleValue) || null,
    assignedSections: organization.assignedSections,
    coverageAreas: organization.coverageAreas,
    sections: organization.sections,
  };
}

async function listUsersHandler(req, res) {
  if (!isDbReady()) {
    return ok(res, { data: { users: [], availableRoles: TEAM_ROLES }, users: [], availableRoles: TEAM_ROLES });
  }

  const includeArchived = String(req.query?.includeArchived || '').toLowerCase() === 'true' || req.query?.includeArchived === '1';
  const includeDeleted = String(req.query?.includeDeleted || '').toLowerCase() === 'true' || req.query?.includeDeleted === '1';
  const includeTest = String(req.query?.includeTest || '').toLowerCase() === 'true' || req.query?.includeTest === '1';
  const docs = await User.find(userListQuery({ includeArchived, includeDeleted, includeTest })).sort({ createdAt: -1 }).lean();
  const ensured = await Promise.all((docs || []).map(async (doc) => {
    const result = await ensureUserStaffId(doc, { action: 'TEAM_STAFF_ID_BACKFILLED' });
    return result.user || doc;
  }));
  const users = ensured.map(safeUserDto);
  return ok(res, { data: { users, availableRoles: TEAM_ROLES }, users, availableRoles: TEAM_ROLES });
}

async function createUserHandler(req, res) {
  if (!ensureDb(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fullName = String(body.fullName || body.name || '').trim();
  const email = String(body.email || body.loginId || '').trim().toLowerCase();
  const accountGroup = normalizeAccountGroup(body.accountGroup);
  const permissions = normalizePermissions(body.permissions);
  const generateTemporaryPassword = body.generateTemporaryPassword !== false;
  const mustChangePassword = generateTemporaryPassword || body.mustChangePassword !== false;
  const providedPassword = String(body.password || body.initialPassword || '');
  const accessExpiresAtRaw = pickDateAlias(body, 'accessExpiresAt', 'accessExpiryDate');
  const accessExpiresAt = parseDateOrNull(accessExpiresAtRaw);

  if (!fullName) return bad(res, 400, 'fullName is required', 'MISSING_FULL_NAME');
  if (!email) return bad(res, 400, 'email is required', 'INVALID_EMAIL');
  if (body.accountGroup && !accountGroup) return bad(res, 400, 'Invalid accountGroup', 'INVALID_ACCOUNT_GROUP');
  if (accountGroup === 'Founder Account') return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');
  const roleAssignment = await resolveRoleAssignment(req, body, roleFallbackForPosition(body.position || body.officialTitle) || 'intern');
  if (roleAssignment.error) return bad(res, roleAssignment.error.status, roleAssignment.error.message, roleAssignment.error.code);
  const organization = normalizeUserOrganizationInput(body, roleAssignment.role);
  if (organization.error) return bad(res, organization.error.status, organization.error.message, organization.error.code);
  const accessOverride = parseAccessOverride(req, body);
  if (accessOverride.error) return bad(res, accessOverride.error.status, accessOverride.error.message, accessOverride.error.code);
  const temporaryAccess = normalizeTemporaryAccessInput(req, body.temporaryAccess);
  if (temporaryAccess.error) return bad(res, temporaryAccess.error.status, temporaryAccess.error.message, temporaryAccess.error.code);
  const accountStatus = normalizeStatus(body.accountStatus !== undefined ? body.accountStatus : body.status);
  if ((body.accountStatus !== undefined || body.status !== undefined) && !accountStatus) return bad(res, 400, 'Invalid accountStatus', 'INVALID_STATUS');
  if (accessExpiresAt === undefined && accessExpiresAtRaw !== undefined) return bad(res, 400, 'Invalid accessExpiryDate', 'INVALID_DATE');
  if (!generateTemporaryPassword) {
    const policy = requirePasswordPolicy(providedPassword);
    if (!policy.ok) return bad(res, 400, policy.message, 'WEAK_PASSWORD');
  }

  const existing = await User.findOne({ email }).lean();
  if (existing) return bad(res, 409, 'Email already exists', 'EMAIL_EXISTS');

  let resolvedStaffId;
  try {
    resolvedStaffId = await resolveStaffIdForNewUser(
      { role: roleAssignment.role, isFounder: roleAssignment.role === 'founder' },
      { requestedStaffId: normalizeRequestedStaffId(body.staffId) },
    );
  } catch (error) {
    if (error?.code === 'STAFF_ID_EXISTS') return bad(res, 409, error.message || 'Staff ID already exists', 'STAFF_ID_EXISTS');
    if (error?.code === 'STAFF_ID_RETIRED') return bad(res, 409, error.message || 'Staff ID cannot be reused', 'STAFF_ID_RETIRED');
    return bad(res, 400, error?.message || 'Invalid Staff ID', 'INVALID_STAFF_ID');
  }

  if (!generateTemporaryPassword && resolvedStaffId.staffId === providedPassword) {
    return bad(res, 400, 'Password cannot match Staff ID', 'STAFF_ID_PASSWORD_NOT_ALLOWED');
  }

  const temporaryPassword = generateTemporaryPassword ? generateTempPassword() : null;
  const password = generateTemporaryPassword ? temporaryPassword : providedPassword;
  const passwordHash = await hashPassword(password);
  const tempPasswordExpiresAt = generateTemporaryPassword ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

  const created = await User.create({
    email,
    name: fullName,
    fullName,
    staffId: resolvedStaffId.staffId,
    staffIdGeneratedAt: resolvedStaffId.generatedAt,
    staffIdLocked: true,
    roleId: roleAssignment.roleId || null,
    roleName: roleAssignment.roleName || roleAssignment.role,
    role: roleAssignment.role,
    department: organization.department,
    sections: organization.sections,
    assignedSections: organization.assignedSections,
    coverageAreas: organization.coverageAreas,
    designation: body.designation != null ? String(body.designation || '').trim() : null,
    reportingManager: body.reportingManager != null ? String(body.reportingManager || '').trim() || null : null,
    employmentType: body.employmentType != null ? String(body.employmentType || '').trim() || null : null,
    accountGroup: accountGroup || null,
    position: normalizePosition(body.position || body.officialTitle) || null,
    officialTitle: body.officialTitle != null ? String(body.officialTitle || '').trim() || null : (normalizePosition(body.position) || null),
    responsibility: body.responsibility != null ? String(body.responsibility || '').trim() || null : null,
    coverageArea: body.coverageArea != null && !Array.isArray(body.coverageArea) ? String(body.coverageArea || '').trim() || null : null,
    defaultTasks: body.defaultTasks !== undefined ? normalizeStringList(body.defaultTasks, 100) : defaultTasksForPosition(body.position || body.officialTitle),
    customTasks: normalizeStringList(body.customTasks, 100),
    recoveryEmail: body.recoveryEmail != null ? String(body.recoveryEmail || '').trim().toLowerCase() || null : null,
    permissions: accessOverride.patch.permissions || permissions,
    moduleAccessOverride: accessOverride.patch.moduleAccessOverride || [],
    specialRightsOverride: accessOverride.patch.specialRightsOverride || [],
    temporaryAccess: temporaryAccess.entries,
    passwordHash,
    status: accountStatus || 'active',
    accountStatus: accountStatus || 'active',
    mustChangePassword,
    mustResetPassword: mustChangePassword,
    forceReset: mustChangePassword,
    tempPasswordExpiresAt,
    createdBy: actorId(req),
    updatedBy: actorId(req),
    accessExpiresAt: accessExpiresAt === undefined ? null : accessExpiresAt,
    noExpiry: body.noExpiry === true || accessExpiresAt === null || accessExpiresAt === undefined,
    isFounder: false,
    isProtected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await logAudit(req, 'TEAM_CREATE_USER', String(created._id), {
    email,
    role: roleAssignment.role,
    roleId: roleAssignment.roleId || null,
    designation: created.designation || null,
    department: created.department || null,
    coverageAreas: created.coverageAreas || [],
    accessExpiresAt,
    generatedTemporaryPassword: generateTemporaryPassword,
    reason: String(body.reason || '').trim().slice(0, 500) || null,
  });
  if (resolvedStaffId.generated) {
    await logAudit(req, 'TEAM_STAFF_ID_GENERATED', String(created._id), {
      staffId: resolvedStaffId.staffId,
      year: resolvedStaffId.year,
      sequence: resolvedStaffId.sequence,
    });
  }
  if (roleAssignment.roleId) await logAudit(req, 'TEAM_ROLE_CHANGE', String(created._id), { to: roleAssignment.roleId, role: roleAssignment.role });
  if (accessOverride.audit.length) await logAudit(req, 'TEAM_ACCESS_CHANGE', String(created._id), { fields: accessOverride.audit, blockedFounderOnly: accessOverride.blockedFounderOnly || [], reason: String(body.reason || '').trim().slice(0, 500) || null });
  if (temporaryAccess.entries.length) await logAudit(req, 'TEAM_TEMP_ACCESS_GRANTED', String(created._id), { count: temporaryAccess.entries.length, reason: String(body.reason || '').trim().slice(0, 500) || null });
  return ok(
    res,
    {
      data: {
        user: safeUserDto(created),
        ...(generateTemporaryPassword ? { temporaryPassword, tempPassword: temporaryPassword, tempPasswordExpiresAt } : {}),
      },
    },
    201,
  );
}

async function getUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_VIEWED'))) return;
  const ensured = await ensureUserStaffId(user, { action: 'TEAM_STAFF_ID_BACKFILLED' });
  const finalUser = ensured.user || user;
  await logAudit(req, 'STAFF_VIEWED', String(finalUser._id), null);
  return ok(res, { data: { user: safeUserDto(finalUser) }, user: safeUserDto(finalUser) });
}

async function updateUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_UPDATED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = { updatedBy: actorId(req), updatedAt: new Date() };
  const audit = { fields: [] };

  if (body.fullName != null || body.name != null) {
    const fullName = String(body.fullName || body.name || '').trim();
    if (!fullName) return bad(res, 400, 'fullName is required', 'MISSING_FULL_NAME');
    patch.fullName = fullName;
    patch.name = fullName;
    audit.fields.push('fullName');
  }
  if (body.staffId !== undefined) {
    if (!staffIdMigrationEnabled(req, body) || user.staffIdLocked || user.staffId) {
      await logAudit(req, 'TEAM_STAFF_ID_CHANGE_BLOCKED', String(user._id), {
        attemptedStaffId: body.staffId != null ? String(body.staffId || '').trim() : null,
      });
      return bad(res, 400, 'Staff ID is immutable after creation', 'STAFF_ID_IMMUTABLE');
    }
  }
  if (body.role !== undefined || body.roleId !== undefined || body.roleName !== undefined || body.roleSlug !== undefined) {
    const roleAssignment = await resolveRoleAssignment(req, body, user.role);
    if (roleAssignment.error) return bad(res, roleAssignment.error.status, roleAssignment.error.message, roleAssignment.error.code);
    if (roleAssignment.role !== user.role || String(roleAssignment.roleId || '') !== String(user.roleId || '')) {
      audit.roleChanged = { from: user.roleId || normalizeRole(user.role) || user.role, to: roleAssignment.roleId || roleAssignment.role };
    }
    patch.role = roleAssignment.role;
    patch.roleName = roleAssignment.roleName || roleAssignment.role;
    patch.roleId = roleAssignment.roleId || null;
    audit.fields.push('role');
  }
  if (body.designation !== undefined) {
    patch.designation = body.designation != null ? String(body.designation || '').trim() : null;
    audit.fields.push('designation');
  }
  if (body.reportingManager !== undefined) {
    patch.reportingManager = body.reportingManager != null ? String(body.reportingManager || '').trim() || null : null;
    audit.fields.push('reportingManager');
  }
  if (body.employmentType !== undefined) {
    patch.employmentType = body.employmentType != null ? String(body.employmentType || '').trim() || null : null;
    audit.fields.push('employmentType');
  }
  if (body.accountGroup !== undefined) {
    const accountGroup = normalizeAccountGroup(body.accountGroup);
    if (body.accountGroup && !accountGroup) return bad(res, 400, 'Invalid accountGroup', 'INVALID_ACCOUNT_GROUP');
    if (accountGroup === 'Founder Account') return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');
    patch.accountGroup = accountGroup;
    audit.fields.push('accountGroup');
  }
  if (body.position !== undefined) {
    const position = normalizePosition(body.position);
    if (body.position && !position) return bad(res, 400, 'Invalid position', 'INVALID_POSITION');
    patch.position = position;
    if (!body.defaultTasks && position) patch.defaultTasks = defaultTasksForPosition(position);
    audit.fields.push('position');
  }
  if (body.officialTitle !== undefined) {
    patch.officialTitle = body.officialTitle != null ? String(body.officialTitle || '').trim() || null : null;
    audit.fields.push('officialTitle');
  }
  if (body.responsibility !== undefined) {
    patch.responsibility = body.responsibility != null ? String(body.responsibility || '').trim() || null : null;
    audit.fields.push('responsibility');
  }
  if (body.defaultTasks !== undefined) {
    patch.defaultTasks = normalizeStringList(body.defaultTasks, 100);
    audit.fields.push('defaultTasks');
  }
  if (body.customTasks !== undefined) {
    patch.customTasks = normalizeStringList(body.customTasks, 100);
    audit.fields.push('customTasks');
  }
  if (body.accessExpiresAt !== undefined) {
    const accessExpiresAt = parseDateOrNull(body.accessExpiresAt);
    if (accessExpiresAt === undefined) return bad(res, 400, 'Invalid accessExpiresAt', 'INVALID_DATE');
    patch.accessExpiresAt = accessExpiresAt;
    audit.fields.push('accessExpiresAt');
  }
  if (body.accessExpiryDate !== undefined) {
    const accessExpiresAt = parseDateOrNull(body.accessExpiryDate);
    if (accessExpiresAt === undefined) return bad(res, 400, 'Invalid accessExpiryDate', 'INVALID_DATE');
    patch.accessExpiresAt = accessExpiresAt;
    audit.fields.push('accessExpiresAt');
  }
  if (body.status !== undefined || body.accountStatus !== undefined) {
    const status = normalizeStatus(body.accountStatus !== undefined ? body.accountStatus : body.status);
    if (!status) return bad(res, 400, 'Invalid status', 'INVALID_STATUS');
    patch.status = status;
    patch.accountStatus = status;
    audit.fields.push('status');
  }
  const accessOverride = parseAccessOverride(req, body);
  if (accessOverride.error) return bad(res, accessOverride.error.status, accessOverride.error.message, accessOverride.error.code);
  Object.assign(patch, accessOverride.patch);
  audit.fields.push(...accessOverride.audit);

  const roleChanged = Object.prototype.hasOwnProperty.call(patch, 'role');
  const organizationTouched = body.department !== undefined
    || body.sections !== undefined
    || body.assignedSections !== undefined
    || body.coverageAreas !== undefined
    || body.coverageArea !== undefined
    || roleChanged;

  if (organizationTouched) {
    const organization = normalizeUserOrganizationInput(body, patch.role || user.role, user);
    if (organization.error) return bad(res, organization.error.status, organization.error.message, organization.error.code);
    patch.department = organization.department;
    patch.sections = organization.sections;
    patch.assignedSections = organization.assignedSections;
    patch.coverageAreas = organization.coverageAreas;
    if (!audit.fields.includes('department')) audit.fields.push('department');
    if (!audit.fields.includes('sections')) audit.fields.push('sections');
    if (!audit.fields.includes('assignedSections')) audit.fields.push('assignedSections');
    if (!audit.fields.includes('coverageAreas')) audit.fields.push('coverageAreas');
  }

  if (body.staffId !== undefined && staffIdMigrationEnabled(req, body) && !user.staffId) {
    try {
      const resolvedStaffId = await resolveStaffIdForNewUser(user, { requestedStaffId: normalizeRequestedStaffId(body.staffId), excludeUserId: String(user._id) });
      patch.staffId = resolvedStaffId.staffId;
      patch.staffIdLocked = true;
      patch.staffIdGeneratedAt = resolvedStaffId.generatedAt;
      audit.fields.push('staffId');
    } catch (error) {
      if (error?.code === 'STAFF_ID_EXISTS') return bad(res, 409, error.message || 'Staff ID already exists', 'STAFF_ID_EXISTS');
      if (error?.code === 'STAFF_ID_RETIRED') return bad(res, 409, error.message || 'Staff ID cannot be reused', 'STAFF_ID_RETIRED');
      return bad(res, 400, error?.message || 'Invalid Staff ID', 'INVALID_STAFF_ID');
    }
  }

  const updated = await User.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  const ensured = await ensureUserStaffId(updated, { action: 'TEAM_STAFF_ID_BACKFILLED' });
  const finalUser = ensured.user || updated;

  if (audit.roleChanged) await logAudit(req, 'TEAM_ROLE_CHANGE', String(finalUser._id), audit.roleChanged);
  if (accessOverride.audit.includes('moduleAccessOverride')) await logAudit(req, 'TEAM_ACCESS_CHANGE', String(updated._id), { moduleAccessOverride: patch.moduleAccessOverride, oldValue: user.moduleAccessOverride || [], newValue: patch.moduleAccessOverride || [], blockedFounderOnly: accessOverride.blockedFounderOnly || [] });
  if (accessOverride.audit.includes('specialRightsOverride')) await logAudit(req, 'TEAM_SPECIAL_RIGHTS_CHANGE', String(updated._id), { specialRightsOverride: patch.specialRightsOverride, oldValue: user.specialRightsOverride || [], newValue: patch.specialRightsOverride || [], blockedFounderOnly: accessOverride.blockedFounderOnly || [] });
  await logAudit(req, 'STAFF_UPDATED', String(finalUser._id), audit);
  return ok(res, { data: { user: safeUserDto(finalUser) }, user: safeUserDto(finalUser) });
}

async function changeUserEmailHandler(req, res) {
  if (!ensureDb(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const newEmail = normalizeEmailAddress(body.newEmail || body.email || body.loginId);
  const reason = String(body.reason || '').trim().slice(0, 500);

  if (!actorCanChangeStaffEmail(req)) {
    await auditStaffEmail(req, 'STAFF_EMAIL_CHANGE_BLOCKED', req.params.id, { reason: 'missing_permission', attemptedEmail: newEmail || null });
    return bad(res, 403, 'Forbidden', 'FORBIDDEN');
  }

  const user = await findUserById(req.params.id, res);
  if (!user) return;

  const oldEmail = normalizeEmailAddress(user.email);
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_EMAIL_CHANGED'))) return;

  if (!newEmail) {
    await auditStaffEmail(req, 'STAFF_EMAIL_CHANGE_BLOCKED', String(user._id), { oldEmail, reason: 'missing_new_email' });
    return bad(res, 400, 'newEmail is required', 'MISSING_EMAIL');
  }

  if (!isValidEmail(newEmail)) {
    await auditStaffEmail(req, 'STAFF_EMAIL_CHANGE_BLOCKED', String(user._id), { oldEmail, newEmail, reason: 'invalid_email' });
    return bad(res, 400, 'Invalid email', 'INVALID_EMAIL');
  }

  if (newEmail === oldEmail) {
    await auditStaffEmail(req, 'STAFF_EMAIL_CHANGE_BLOCKED', String(user._id), { oldEmail, newEmail, reason: 'email_unchanged' });
    return bad(res, 400, 'New email must be different from current email', 'EMAIL_UNCHANGED');
  }

  if (SHARED_SYSTEM_EMAILS.includes(newEmail) && !sharedSystemMailboxAllowed(req, body)) {
    await auditStaffEmail(req, 'STAFF_EMAIL_CHANGE_BLOCKED', String(user._id), { oldEmail, newEmail, reason: 'shared_system_mailbox' });
    return bad(res, 400, 'Shared News Pulse system mailboxes cannot be used for normal staff login', 'SHARED_SYSTEM_EMAIL_BLOCKED');
  }

  const duplicate = await User.findOne({ email: newEmail }).lean();
  if (duplicate) {
    await auditStaffEmail(req, 'STAFF_EMAIL_CHANGE_DUPLICATE', String(user._id), { oldEmail, newEmail, duplicateUserId: String(duplicate._id || duplicate.id || '') || null, reason });
    return bad(res, 409, 'Email already exists', 'EMAIL_EXISTS');
  }

  const now = new Date();
  const forcePasswordChange = body.forcePasswordChange === true;
  await revokeResetTokensForEmail(oldEmail, now);
  await markUserSessionsRevoked(user._id, now, 'staff_email_changed');

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        email: newEmail,
        emailVerified: false,
        pendingEmail: null,
        lastEmailChangedAt: now,
        ...(forcePasswordChange ? { mustChangePassword: true, mustResetPassword: true, forceReset: true } : {}),
        sessionsRevokedAt: now,
        resetTokensRevokedAt: now,
        currentSessionId: null,
        onlineStatus: 'offline',
        lastLogoutAt: now,
        updatedBy: actorId(req),
        updatedAt: now,
      },
      $push: {
        emailHistory: {
          oldEmail,
          newEmail,
          changedBy: actorId(req),
          changedAt: now,
          reason,
        },
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  );

  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');

  await auditStaffEmail(req, 'STAFF_EMAIL_CHANGED', String(updated._id), {
    oldEmail,
    newEmail,
    reason,
    forcePasswordChange,
    logoutAllDevices: true,
    sessionsRevokedAt: now,
    resetTokensRevokedAt: now,
  });

  return ok(res, {
    message: forcePasswordChange ? 'Staff email updated. User must change password on next login.' : 'Staff email updated.',
    user: {
      id: String(updated._id),
      email: updated.email,
      staffId: updated.staffId || null,
      mustChangePassword: Boolean(updated.mustChangePassword || updated.mustResetPassword || updated.forceReset),
    },
    data: {
      user: {
        id: String(updated._id),
        email: updated.email,
        staffId: updated.staffId || null,
        mustChangePassword: Boolean(updated.mustChangePassword || updated.mustResetPassword || updated.forceReset),
      },
    },
  });
}

async function accessOverrideHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_UPDATED'))) return;

  const accessOverride = parseAccessOverride(req, req.body && typeof req.body === 'object' ? req.body : {});
  if (accessOverride.error) return bad(res, accessOverride.error.status, accessOverride.error.message, accessOverride.error.code);
  if (!accessOverride.audit.length) return bad(res, 400, 'No access changes supplied', 'NO_ACCESS_CHANGES');

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { ...accessOverride.patch, updatedBy: actorId(req), updatedAt: new Date() } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  if (accessOverride.audit.includes('moduleAccessOverride')) await logAudit(req, 'TEAM_ACCESS_CHANGE', String(updated._id), { moduleAccessOverride: updated.moduleAccessOverride });
  if (accessOverride.audit.includes('specialRightsOverride')) await logAudit(req, 'TEAM_SPECIAL_RIGHTS_CHANGE', String(updated._id), { specialRightsOverride: updated.specialRightsOverride });
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function suspendUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_SUSPENDED'))) return;
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_suspended');

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { status: 'suspended', accountStatus: 'suspended', loginAllowed: false, suspendedAt: now, sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now, updatedBy: actorId(req), updatedAt: now }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await logAudit(req, 'STAFF_SUSPENDED', String(user._id), null);
  await auditAccountLifecycle(req, 'ACCOUNT_SUSPENDED', String(user._id), { accountStatus: user.accountStatus || user.status || null }, { accountStatus: updated.accountStatus, suspendedAt: updated.suspendedAt }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Staff account suspended.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function lockUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_LOCKED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const lockedUntil = parseDateOrNull(body.lockedUntil);
  if (lockedUntil === undefined && body.lockedUntil !== undefined) return bad(res, 400, 'Invalid lockedUntil', 'INVALID_DATE');
  const finalLockedUntil = lockedUntil === undefined ? new Date(Date.now() + 24 * 60 * 60 * 1000) : lockedUntil;
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_locked');
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { status: 'locked', accountStatus: 'locked', loginAllowed: false, lockedAt: now, lockedUntil: finalLockedUntil, sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now, updatedBy: actorId(req), updatedAt: now }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await logAudit(req, 'STAFF_LOCKED', String(user._id), { lockedUntil: finalLockedUntil });
  await auditAccountLifecycle(req, 'ACCOUNT_LOCKED', String(user._id), { accountStatus: user.accountStatus || user.status || null }, { accountStatus: updated.accountStatus, lockedAt: updated.lockedAt, lockedUntil: updated.lockedUntil }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Staff account locked.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function unlockUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_UNLOCKED'))) return;
  if (isAccountExpired(user)) return bad(res, 400, 'Account access has expired. Reactivate the account instead.', 'ACCOUNT_EXPIRED');
  const now = new Date();
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { status: 'active', accountStatus: 'active', loginAllowed: true, lockedUntil: null, lockedAt: null, updatedBy: actorId(req), updatedAt: now }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_UNLOCKED', String(user._id), { fromStatus: user.accountStatus || user.status || null });
  await auditAccountLifecycle(req, 'ACCOUNT_UNLOCKED', String(user._id), { accountStatus: user.accountStatus || user.status || null, lockedAt: user.lockedAt || null }, { accountStatus: updated.accountStatus, lockedAt: null }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Staff account unlocked.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function resetPasswordHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_PASSWORD_RESET'))) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const resolved = resolveTemporaryPasswordInput(body);
  if (resolved.error) return bad(res, resolved.error.status, resolved.error.message, resolved.error.code);

  const { updated, tempPassword, tempPasswordExpiresAt } = await assignTemporaryPassword(user._id, {
    temporaryPassword: resolved.temporaryPassword,
    sessionReason: 'staff_password_reset',
  });
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_PASSWORD_RESET', String(user._id), { temporaryPasswordExpiresAt: tempPasswordExpiresAt, providedTemporaryPassword: resolved.provided });
  await auditAccountLifecycle(req, 'PASSWORD_RESET_REQUIRED', String(user._id), { passwordStatus: 'set' }, { passwordStatus: 'force_change_required', temporaryPasswordExpiresAt: tempPasswordExpiresAt }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Temporary password generated. It is shown only once.', data: { user: safeUserDto(updated), temporaryPassword: tempPassword, tempPassword, tempPasswordExpiresAt }, user: safeUserDto(updated), temporaryPassword: tempPassword, tempPasswordExpiresAt });
}

async function generateTemporaryPasswordHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_TEMP_PASSWORD_GENERATED'))) return;
  const { updated, tempPassword, tempPasswordExpiresAt } = await assignTemporaryPassword(user._id, { sessionReason: 'staff_temp_password_generated' });
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_TEMP_PASSWORD_GENERATED', String(user._id), { temporaryPasswordExpiresAt: tempPasswordExpiresAt });
  await auditAccountLifecycle(req, 'PASSWORD_RESET_REQUIRED', String(user._id), { passwordStatus: 'set' }, { passwordStatus: 'force_change_required', temporaryPasswordExpiresAt: tempPasswordExpiresAt }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Temporary password generated. It is shown only once.', data: { user: safeUserDto(updated), temporaryPassword: tempPassword, tempPasswordExpiresAt }, user: safeUserDto(updated), temporaryPassword: tempPassword, tempPasswordExpiresAt });
}

async function forcePasswordChangeHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_FORCE_CHANGE_PASSWORD'))) return;
  if (user.mustChangePassword || user.mustResetPassword || user.forceReset) {
    await logAudit(req, 'STAFF_FORCE_CHANGE_PASSWORD', String(user._id), { alreadyRequired: true });
    return ok(res, { message: 'Password change already required.', data: { user: safeUserDto(user) }, user: safeUserDto(user) });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const now = new Date();
  if (body.logoutAllDevices === true) await markUserSessionsRevoked(user._id, now, 'staff_force_change_password');

  const updated = await User.findByIdAndUpdate(
    user._id,
    {
      $set: {
        mustChangePassword: true,
        mustResetPassword: true,
        forceReset: true,
        ...(body.logoutAllDevices === true ? { sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now } : {}),
        updatedBy: actorId(req),
        updatedAt: now,
      },
      ...(body.logoutAllDevices === true ? { $inc: { tokenVersion: 1 } } : {}),
    },
    { new: true },
  );
  await logAudit(req, 'STAFF_FORCE_CHANGE_PASSWORD', String(user._id), { logoutAllDevices: body.logoutAllDevices === true });
  await auditAccountLifecycle(req, 'PASSWORD_RESET_REQUIRED', String(user._id), { passwordStatus: 'set' }, { passwordStatus: 'force_change_required' }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Password change required on next login.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function permissionsHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_UPDATED'))) return;

  const permissions = normalizePermissions(req.body?.permissions);
  const oldPermissions = Array.isArray(user.permissions) ? user.permissions.slice() : [];
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { permissions, updatedBy: actorId(req), updatedAt: new Date() } },
    { new: true },
  );
  const liveTvChanged = oldPermissions.includes('live_tv.full_access') !== permissions.includes('live_tv.full_access')
    || oldPermissions.includes('live_tv.emergency_stop') !== permissions.includes('live_tv.emergency_stop');
  await logAudit(req, 'TEAM_PERMISSION_CHANGE', req.params.id, { permissions });
  if (liveTvChanged) await logAudit(req, 'TEAM_LIVE_TV_PERMISSION_CHANGE', req.params.id, { permissions });
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function logoutAllHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_LOGOUT_ALL_DEVICES'))) return;
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_logout_all_devices');
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $inc: { tokenVersion: 1 }, $set: { sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now, updatedBy: actorId(req), updatedAt: now } },
    { new: true },
  );
  await logAudit(req, 'STAFF_LOGOUT_ALL_DEVICES', String(user._id), null);
  await auditAccountLifecycle(req, 'SESSIONS_REVOKED', String(user._id), { tokenVersion: user.tokenVersion || 0 }, { tokenVersion: updated.tokenVersion, sessionsRevokedAt: now }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'All staff sessions revoked.', data: { user: safeUserDto(updated), tokenVersion: updated.tokenVersion }, user: safeUserDto(updated), tokenVersion: updated.tokenVersion });
}

async function extendAccessHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_ACCESS_EXTENDED'))) return;
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const expiry = resolveAccessExpiryInput(body, user.accessExpiresAt || null);
  if (expiry.error) return bad(res, expiry.error.status, expiry.error.message, expiry.error.code);
  const now = new Date();
  const accessExpiresAt = expiry.accessExpiresAt;
  const wasExpired = lifecycleStatus(user, now) === ACCOUNT_STATUS.EXPIRED;
  const patch = { accessExpiresAt, noExpiry: expiry.noExpiry, updatedBy: actorId(req), updatedAt: now };
  if (wasExpired) Object.assign(patch, { status: 'active', accountStatus: 'active', loginAllowed: true, lockedUntil: null });
  const update = { $set: patch };
  if (wasExpired || body.logoutAllDevices === true) {
    await markUserSessionsRevoked(user._id, now, 'staff_access_extended');
    Object.assign(update.$set, { sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now });
    update.$inc = { tokenVersion: 1 };
  }
  const updated = await User.findByIdAndUpdate(user._id, update, { new: true });
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_ACCESS_EXTENDED', String(user._id), { accessExpiresAt, noExpiry: expiry.noExpiry, reactivatedExpiredAccount: wasExpired });
  await auditAccountLifecycle(req, expiry.noExpiry ? 'ACCOUNT_NO_EXPIRY_SET' : 'ACCOUNT_EXPIRY_EXTENDED', String(user._id), { accountStatus: user.accountStatus || user.status || null, accessExpiresAt: user.accessExpiresAt || null, noExpiry: hasNoExpiry(user) }, { accountStatus: updated.accountStatus, accessExpiresAt: updated.accessExpiresAt || null, noExpiry: updated.noExpiry === true }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Staff access extended.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function reactivateUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_REACTIVATED'))) return;
  const current = String(user.accountStatus || user.status || 'active').toLowerCase();
  if (!['expired', 'suspended', 'archived', 'locked', 'active'].includes(current)) return bad(res, 400, 'Account cannot be reactivated from current status', 'INVALID_STATUS');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const expiry = resolveAccessExpiryInput(body, user.accessExpiresAt || null);
  if (expiry.error) return bad(res, expiry.error.status, expiry.error.message, expiry.error.code);
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_reactivated');
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { status: 'active', accountStatus: 'active', loginAllowed: true, lockedUntil: null, lockedAt: null, suspendedAt: null, isArchived: false, archivedAt: null, archivedBy: null, accessExpiresAt: expiry.accessExpiresAt, noExpiry: expiry.noExpiry, reactivatedAt: now, sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now, updatedBy: actorId(req), updatedAt: now }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  let passwordPayload = {};
  if (body.resetPassword === true || body.requirePasswordReset === true || body.reactivateAndResetPassword === true) {
    const resolved = resolveTemporaryPasswordInput(body);
    if (resolved.error) return bad(res, resolved.error.status, resolved.error.message, resolved.error.code);
    const reset = await assignTemporaryPassword(user._id, { temporaryPassword: resolved.temporaryPassword, sessionReason: 'staff_reactivated_password_reset' });
    if (reset.updated) {
      passwordPayload = { temporaryPassword: reset.tempPassword, tempPassword: reset.tempPassword, tempPasswordExpiresAt: reset.tempPasswordExpiresAt, user: safeUserDto(reset.updated) };
    }
  }
  const finalUser = passwordPayload.user ? await User.findById(user._id) : updated;
  await logAudit(req, 'STAFF_REACTIVATED', String(user._id), { fromStatus: current, accessExpiresAt: expiry.accessExpiresAt, noExpiry: expiry.noExpiry, passwordResetRequired: Boolean(passwordPayload.temporaryPassword) });
  await auditAccountLifecycle(req, 'ACCOUNT_REACTIVATED', String(user._id), { accountStatus: current, accessExpiresAt: user.accessExpiresAt || null, noExpiry: hasNoExpiry(user), staffId: user.staffId || null }, { accountStatus: 'active', accessExpiresAt: finalUser.accessExpiresAt || null, noExpiry: finalUser.noExpiry === true, staffId: finalUser.staffId || null }, { targetStaffId: finalUser.staffId || null });
  return ok(res, { message: 'Staff account reactivated.', data: { user: safeUserDto(finalUser), ...passwordPayload }, user: safeUserDto(finalUser), ...passwordPayload });
}

async function keepExpiredHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_KEPT_EXPIRED'))) return;
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_kept_expired');
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { status: 'expired', accountStatus: 'expired', loginAllowed: false, noExpiry: false, accessExpiresAt: user.accessExpiresAt || now, sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now, updatedBy: actorId(req), updatedAt: now }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await auditAccountLifecycle(req, 'ACCOUNT_KEPT_EXPIRED', String(user._id), { accountStatus: user.accountStatus || user.status || null }, { accountStatus: updated.accountStatus, accessExpiresAt: updated.accessExpiresAt || null }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Staff account kept expired.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function accountControlStateHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  const roleDoc = await loadRoleDocForUser(user);
  const effectiveAccess = await buildFounderStudioEffectiveAccess(user, roleDoc);
  const status = lifecycleStatus(user);
  const activeSessionCount = user.currentSessionId ? 1 : 0;
  const accountState = {
    staffId: user.staffId || null,
    loginEmail: user.email || null,
    accountStatus: status,
    accessStartAt: user.createdAt || null,
    accessExpiresAt: hasNoExpiry(user) ? null : (user.accessExpiresAt || null),
    accountExpiresAt: hasNoExpiry(user) ? null : (user.accessExpiresAt || null),
    noExpiry: hasNoExpiry(user),
    lastLoginAt: user.lastLoginAt || null,
    passwordStatus: (user.mustChangePassword || user.mustResetPassword || user.forceReset) ? 'force_change_required' : 'set',
    forcePasswordChange: Boolean(user.mustChangePassword || user.mustResetPassword || user.forceReset),
    activeSessionCount,
    suspendedAt: user.suspendedAt || null,
    lockedAt: user.lockedAt || null,
    archivedAt: user.archivedAt || null,
    reactivatedAt: user.reactivatedAt || null,
    updatedAt: user.updatedAt || null,
    updatedBy: user.updatedBy || null,
  };
  const baseUser = typeof user.toObject === 'function' ? user.toObject() : user;
  const userDto = safeUserDto({ ...baseUser, activeSessionCount });
  return ok(res, { data: { user: userDto, accountState, effectiveAccess }, user: userDto, accountState, effectiveAccess });
}

async function listDelegationsHandler(req, res) {
  if (!ensureDb(res)) return;
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder role required', 'FOUNDER_REQUIRED');
  const filter = {};
  if (req.query?.staffId) filter.delegatedToStaffId = String(req.query.staffId || '').trim().toUpperCase();
  const docs = await AccountControlDelegation.find(filter).sort({ updatedAt: -1, createdAt: -1 }).lean();
  const delegations = (docs || []).map(delegationDto);
  return ok(res, { data: { delegations, rights: ACCOUNT_CONTROL_DELEGATED_RIGHTS, manageableAccountTypes: MANAGEABLE_ACCOUNT_TYPES }, delegations, rights: ACCOUNT_CONTROL_DELEGATED_RIGHTS, manageableAccountTypes: MANAGEABLE_ACCOUNT_TYPES });
}

async function grantDelegationHandler(req, res) {
  if (!ensureDb(res)) return;
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder role required', 'FOUNDER_REQUIRED');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const delegatedToStaffId = String(body.delegatedToStaffId || body.staffId || '').trim().toUpperCase();
  if (!delegatedToStaffId) return bad(res, 400, 'delegatedToStaffId is required', 'MISSING_STAFF_ID');
  const target = await User.findOne({ staffId: delegatedToStaffId });
  if (!target) return bad(res, 404, 'Staff not found', 'NOT_FOUND');
  if (isFounderAccount(target)) return bad(res, 403, FOUNDER_PROTECTED_MESSAGE, 'FOUNDER_PROTECTED');
  const grantedRights = normalizeDelegatedRights(body.grantedRights || body.rights);
  const manageableAccountTypes = normalizeManageableAccountTypes(body.manageableAccountTypes || body.accountTypes);
  if (!grantedRights.length) return bad(res, 400, 'At least one delegated right is required', 'NO_DELEGATED_RIGHTS');
  if (!manageableAccountTypes.length) return bad(res, 400, 'At least one manageable account type is required', 'NO_MANAGEABLE_ACCOUNT_TYPES');
  const startsAt = body.startsAt === undefined ? new Date() : parseDateOrNull(body.startsAt);
  const expiresAt = body.expiresAt === undefined ? null : parseDateOrNull(body.expiresAt);
  if (startsAt === undefined || expiresAt === undefined) return bad(res, 400, 'Invalid delegation date', 'INVALID_DATE');
  const auditReason = auditReasonFromBody(body);
  if (!auditReason) return bad(res, 400, 'auditReason is required', 'AUDIT_REASON_REQUIRED');
  const created = await AccountControlDelegation.create({
    delegatedToStaffId,
    grantedRights,
    manageableAccountTypes,
    startsAt,
    expiresAt,
    active: body.active !== false,
    appointedByFounderId: req.user?.staffId || req.user?.id || FOUNDER_STAFF_ID,
    auditReason,
  });
  await logAudit(req, 'DELEGATION_GRANTED', String(target._id), { targetStaffId: delegatedToStaffId, grantedRights, manageableAccountTypes, startsAt, expiresAt, reason: auditReason });
  return ok(res, { message: 'Delegation granted.', data: { delegation: delegationDto(created) }, delegation: delegationDto(created) }, 201);
}

async function updateDelegationHandler(req, res) {
  if (!ensureDb(res)) return;
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder role required', 'FOUNDER_REQUIRED');
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid delegation id', 'INVALID_ID');
  const existing = await AccountControlDelegation.findById(String(req.params.id)).lean();
  if (!existing) return bad(res, 404, 'Delegation not found', 'NOT_FOUND');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = { updatedAt: new Date() };
  if (body.grantedRights !== undefined || body.rights !== undefined) {
    patch.grantedRights = normalizeDelegatedRights(body.grantedRights || body.rights);
    if (!patch.grantedRights.length) return bad(res, 400, 'At least one delegated right is required', 'NO_DELEGATED_RIGHTS');
  }
  if (body.manageableAccountTypes !== undefined || body.accountTypes !== undefined) {
    patch.manageableAccountTypes = normalizeManageableAccountTypes(body.manageableAccountTypes || body.accountTypes);
    if (!patch.manageableAccountTypes.length) return bad(res, 400, 'At least one manageable account type is required', 'NO_MANAGEABLE_ACCOUNT_TYPES');
  }
  if (body.startsAt !== undefined) {
    const startsAt = parseDateOrNull(body.startsAt);
    if (startsAt === undefined) return bad(res, 400, 'Invalid startsAt', 'INVALID_DATE');
    patch.startsAt = startsAt || new Date();
  }
  if (body.expiresAt !== undefined) {
    const expiresAt = parseDateOrNull(body.expiresAt);
    if (expiresAt === undefined) return bad(res, 400, 'Invalid expiresAt', 'INVALID_DATE');
    patch.expiresAt = expiresAt;
  }
  if (body.active !== undefined) patch.active = body.active !== false;
  const auditReason = auditReasonFromBody(body);
  if (auditReason) patch.auditReason = auditReason;
  const updated = await AccountControlDelegation.findByIdAndUpdate(String(req.params.id), { $set: patch }, { new: true });
  await logAudit(req, 'DELEGATION_UPDATED', null, { targetStaffId: existing.delegatedToStaffId || null, oldValue: delegationDto(existing), newValue: delegationDto(updated), reason: auditReason });
  return ok(res, { message: 'Delegation updated.', data: { delegation: delegationDto(updated) }, delegation: delegationDto(updated) });
}

async function revokeDelegationHandler(req, res) {
  if (!ensureDb(res)) return;
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder role required', 'FOUNDER_REQUIRED');
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid delegation id', 'INVALID_ID');
  const existing = await AccountControlDelegation.findById(String(req.params.id)).lean();
  if (!existing) return bad(res, 404, 'Delegation not found', 'NOT_FOUND');
  const updated = await AccountControlDelegation.findByIdAndUpdate(String(req.params.id), { $set: { active: false, updatedAt: new Date(), auditReason: auditReasonFromBody(req.body) || existing.auditReason || null } }, { new: true });
  const target = existing.delegatedToStaffId ? await User.findOne({ staffId: existing.delegatedToStaffId }) : null;
  if (target && !isFounderAccount(target)) {
    await User.findByIdAndUpdate(target._id, { $inc: { tokenVersion: 1 }, $set: { sessionsRevokedAt: new Date(), updatedAt: new Date() } });
  }
  await logAudit(req, 'DELEGATION_REVOKED', target?._id ? String(target._id) : null, { targetStaffId: existing.delegatedToStaffId || null, oldValue: delegationDto(existing), newValue: delegationDto(updated), reason: auditReasonFromBody(req.body) || null });
  return ok(res, { message: 'Delegation revoked.', data: { delegation: delegationDto(updated) }, delegation: delegationDto(updated) });
}

async function archiveUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = req.accountControlTargetUser || await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_ARCHIVED'))) return;
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_archived');
  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { status: 'archived', accountStatus: 'archived', isArchived: true, archivedAt: now, archivedBy: actorId(req), loginAllowed: false, sessionsRevokedAt: now, currentSessionId: null, onlineStatus: 'offline', lastLogoutAt: now, updatedBy: actorId(req), updatedAt: now }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_ARCHIVED', String(user._id), { reason: String(req.body?.reason || '').trim().slice(0, 500) || null });
  await auditAccountLifecycle(req, 'ACCOUNT_ARCHIVED', String(user._id), { accountStatus: user.accountStatus || user.status || null }, { accountStatus: updated.accountStatus, archivedAt: updated.archivedAt }, { targetStaffId: updated.staffId || null });
  return ok(res, { message: 'Staff account archived. Audit history was kept.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

function hasTestAccountMarker(user) {
  const direct = Boolean(user?.isTest || user?.test || user?.testOnly || user?.isTestAccount || (typeof user.get === 'function' && (user.get('isTest') || user.get('test') || user.get('testOnly') || user.get('isTestAccount'))));
  if (direct) return true;
  return /\b(test|demo|fake|unwanted)\b|unnamed/i.test([user?.name, user?.fullName, user?.email, user?.designation].map((value) => String(value || '')).join(' '));
}

async function getTestDeleteBlockers(user) {
  const blockers = [];
  const userId = String(user._id);
  const staffId = String(user.staffId || '').trim().toUpperCase();
  if (staffId === FOUNDER_STAFF_ID) blockers.push('Founder account cannot be deleted.');
  if (isProtectedFounderUser(user)) blockers.push('Founder/protected accounts cannot be deleted.');
  if (!hasTestAccountMarker(user)) blockers.push('Real staff accounts cannot be deleted. Archive account instead.');
  if (normalizeRole(user.role) === 'admin' || user.isOwner || user.fullAccess || user.canBeDeleted === false || user.isProtected) blockers.push('Real staff accounts cannot be deleted. Archive account instead.');

  const publishedNewsCount = await News.countDocuments({
    status: 'published',
    $or: [
      { 'workflowHistory.byUserId': user._id },
      { 'internalComments.byUserId': user._id },
    ],
  });
  if (publishedNewsCount > 0) blockers.push('Real staff accounts cannot be deleted. Archive account instead.');

  const financeCount = await FinanceRecord.countDocuments({ $or: [{ createdBy: user._id }, { updatedBy: user._id }] });
  if (financeCount > 0) blockers.push('Real staff accounts cannot be deleted. Archive account instead.');

  const criticalAuditCount = await AuditLog.countDocuments({
    key: `user:${userId}`,
    action: { $regex: /(FOUNDER|OWNER|SAFE|SECURITY|FINANCE|PAYMENT|PUBLISH|PERMISSION|ACCESS|ROLE_CHANGE|PASSWORD_RESET|EMAIL_CHANGED)/i },
  });
  if (criticalAuditCount > 0) blockers.push('Real staff accounts cannot be deleted. Archive account instead.');
  return blockers;
}

function deleteReasonFromBody(req, fallback) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return String(body.reason || body.deleteReason || fallback || '').trim().slice(0, 500) || null;
}

function founderDeleteConfirmationProvided(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return body.founderConfirmation === 'DELETE_TEST_ACCOUNT' || body.confirmation === 'DELETE_TEST_ACCOUNT' || body.confirmDeleteTestAccount === true;
}

async function deleteTestOnlyHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user) || String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID) {
    await logAudit(req, 'FOUNDER_DELETE_BLOCKED', String(user._id), { staffId: user.staffId || null });
    return bad(res, 403, FOUNDER_PROTECTED_MESSAGE, 'FOUNDER_PROTECTED');
  }
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder confirmation required. Archive Account instead.', 'FOUNDER_CONFIRMATION_REQUIRED');
  if (!founderDeleteConfirmationProvided(req)) return bad(res, 400, 'Founder confirmation is required. Archive Account instead.', 'MISSING_FOUNDER_CONFIRMATION');

  const blockers = await getTestDeleteBlockers(user);
  if (blockers.length) {
    await logAudit(req, 'STAFF_DELETE_BLOCKED', String(user._id), { reasons: blockers, staffId: user.staffId || null });
    return bad(res, 400, 'Real staff accounts cannot be deleted. Archive account instead.', 'TEST_DELETE_BLOCKED');
  }

  const deletedUser = safeUserDto(user);
  const now = new Date();
  const deleteReason = deleteReasonFromBody(req, 'safe test account cleanup');
  await markUserSessionsRevoked(user._id, now, 'staff_test_deleted');
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        status: 'deleted',
        accountStatus: 'deleted',
        isDeleted: true,
        deletedAt: now,
        deletedBy: actorId(req),
        deleteReason,
        loginAllowed: false,
        sessionsRevokedAt: now,
        currentSessionId: null,
        onlineStatus: 'offline',
        lastLogoutAt: now,
        updatedBy: actorId(req),
        updatedAt: now,
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_TEST_DELETED', req.params.id, { email: user.email, staffId: user.staffId || null, deleteReason });
  return ok(res, { message: 'Test staff account deleted.', data: { user: safeUserDto(updated), previousUser: deletedUser }, user: safeUserDto(updated) });
}

async function markTestAccountHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_MARKED_TEST'))) return;
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder confirmation required.', 'FOUNDER_REQUIRED');
  const now = new Date();
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = String(body.reason || body.testAccountReason || 'Marked as test/demo/unwanted account').trim().slice(0, 500);
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { isTestAccount: true, testAccountReason: reason, testAccountMarkedAt: now, testAccountMarkedBy: actorId(req), updatedBy: actorId(req), updatedAt: now } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_MARKED_TEST', req.params.id, { reason });
  return ok(res, { message: 'Staff account marked as test/demo/unwanted.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function auditLogsHandler(_req, res) {
  if (!ensureDb(res)) return;
  const docs = await AuditLog.find({ action: { $in: [
    'AUTH_LOGIN_SUCCESS',
    'AUTH_LOGIN_FAILED',
    'AUTH_LOGOUT',
    'TEAM_CREATE_USER',
    'TEAM_RESET_PASSWORD',
    'TEAM_FORCE_PASSWORD_CHANGE',
    'TEAM_SUSPEND_USER',
    'TEAM_LOCK_USER',
    'ROLE_CREATE',
    'ROLE_EDIT',
    'ROLE_DELETE',
    'TEAM_PERMISSION_CHANGE',
    'TEAM_ACCESS_CHANGE',
    'TEAM_SPECIAL_RIGHTS_CHANGE',
    'FINANCE_RECORD_CREATE',
    'FINANCE_RECORD_UPDATE',
    'TEAM_ROLE_CHANGE',
    'TEAM_LIVE_TV_PERMISSION_CHANGE',
    'TEAM_LOGOUT_USER_SESSIONS',
    'STAFF_VIEWED',
    'STAFF_UPDATED',
    'STAFF_EMAIL_CHANGED',
    'STAFF_TEMP_PASSWORD_GENERATED',
    'STAFF_PASSWORD_RESET',
    'STAFF_FORCE_CHANGE_PASSWORD',
    'STAFF_ACCESS_EXTENDED',
    'STAFF_REACTIVATED',
    'STAFF_SUSPENDED',
    'STAFF_LOCKED',
    'STAFF_LOGOUT_ALL_DEVICES',
    'STAFF_ARCHIVED',
    'STAFF_TEST_DELETED',
    'STAFF_MARKED_TEST',
    'STAFF_DELETE_BLOCKED',
    'staff_deleted_permanently',
    'FOUNDER_DELETE_BLOCKED',
    'BLOCKED_FOUNDER_STAFF_ACTION',
    'STAFF_EMAIL_CHANGE_BLOCKED',
    'STAFF_EMAIL_CHANGE_DUPLICATE',
    'STAFF_FOUNDER_EMAIL_CHANGE_BLOCKED',
  ] } })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return ok(res, { data: { auditLogs: docs || [] }, auditLogs: docs || [] });
}

async function optionsHandler(_req, res) {
  return ok(res, {
    data: {
      roles: TEAM_ROLES,
      departments: TEAM_DEPARTMENTS,
      assignedSections: TEAM_ASSIGNED_SECTIONS,
      coverageAreas: TEAM_COVERAGE_AREAS,
      roleDepartmentDefaults: ROLE_DEPARTMENT_DEFAULTS,
      staffControlCenter: { ...STAFF_CONTROL_CENTER, departments: STAFF_CONTROL_CENTER.departments.slice(), sections: STAFF_CONTROL_CENTER.sections.slice() },
    },
    roles: TEAM_ROLES,
    departments: TEAM_DEPARTMENTS,
    assignedSections: TEAM_ASSIGNED_SECTIONS,
    coverageAreas: TEAM_COVERAGE_AREAS,
    roleDepartmentDefaults: ROLE_DEPARTMENT_DEFAULTS,
    staffControlCenter: { ...STAFF_CONTROL_CENTER, departments: STAFF_CONTROL_CENTER.departments.slice(), sections: STAFF_CONTROL_CENTER.sections.slice() },
  });
}

async function nextStaffIdHandler(_req, res) {
  if (!ensureDb(res)) return;
  const preview = await previewNextStaffId();
  return ok(res, { data: preview, nextStaffId: preview.staffId });
}

async function activateUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_REACTIVATED'))) return;
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'active', accountStatus: 'active', loginAllowed: true, lockedUntil: null, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await logAudit(req, 'STAFF_REACTIVATED', req.params.id, null);
  return ok(res, { message: 'Staff account reactivated.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function statusHandler(req, res) {
  const status = normalizeStatus(req.body?.status);
  if (status === 'suspended') return suspendUserHandler(req, res);
  if (status === 'locked') return lockUserHandler(req, res);
  if (status === 'active') return activateUserHandler(req, res);
  return bad(res, 400, 'Invalid status', 'INVALID_STATUS');
}

// ---------------------------------------------------------------------------
// Staff Control Center — Founder Access Studio
// ---------------------------------------------------------------------------

function isSafeZoneMasterLocked() {
  const value = String(process.env.SAFE_ZONE_MASTER_LOCK || process.env.SAFE_ZONE_LOCKED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'locked'].includes(value);
}

async function loadRoleDocForUser(user) {
  if (!isDbReady() || !user) return null;
  if (user.isFounder || normalizeRole(user.role) === 'founder') return null;
  if (user.roleId && mongoose.isValidObjectId(String(user.roleId))) {
    const byId = await Role.findById(user.roleId).lean();
    if (byId) return byId;
  }
  const slug = roleSlugFromName(user.role || user.roleName);
  if (!slug) return null;
  return Role.findOne({ slug }).lean();
}

// Accept either an array of keys or an object map { key: true/false }.
function parseKeyMap(...candidates) {
  for (const value of candidates) {
    if (Array.isArray(value)) return { provided: true, keys: value.map((item) => String(item || '').trim()).filter(Boolean) };
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).filter((key) => value[key] === true || value[key] === 'on' || value[key] === 'ON' || value[key] === 1);
      return { provided: true, keys };
    }
  }
  return { provided: false, keys: [] };
}

function auditReasonFromBody(body) {
  const reason = String(body?.auditReason || body?.reason || '').trim();
  return reason.length >= 3 ? reason.slice(0, 500) : null;
}

function parseModuleAccessStates(body) {
  return parseStaffModuleAccessPayload(body);
}

async function buildFounderStudioEffectiveAccess(user, roleDoc) {
  const legacyAccess = computeEffectiveAccess(user, roleDoc, isSafeZoneMasterLocked());
  const policy = await getFounderModulePolicy({ defaultWhenDbUnavailable: true });
  const canonicalModules = evaluateAllModuleAccess(user, policy);
  return {
    ...legacyAccess,
    accessVersion: typeof user?.accessVersion === 'number' ? user.accessVersion : 0,
    policyVersion: policy.version,
    canonicalModules,
  };
}

async function accessStaffListHandler(req, res) {
  if (!isDbReady()) return ok(res, { data: { staff: [], availableRoles: TEAM_ROLES }, staff: [], users: [] });
  const docs = await User.find(userListQuery({})).sort({ createdAt: -1 }).lean();
  const ensured = await Promise.all((docs || []).map(async (doc) => {
    const result = await ensureUserStaffId(doc, { action: 'TEAM_STAFF_ID_BACKFILLED' });
    return result.user || doc;
  }));
  const staff = ensured.map(safeUserDto);
  return ok(res, { data: { staff, users: staff, availableRoles: TEAM_ROLES }, staff, users: staff });
}

async function accessStaffDetailHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  const roleDoc = await loadRoleDocForUser(user);
  const effectiveAccess = await buildFounderStudioEffectiveAccess(user, roleDoc);
  return ok(res, { data: { user: safeUserDto(user), effectiveAccess }, user: safeUserDto(user), effectiveAccess });
}

async function effectiveAccessHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  const roleDoc = await loadRoleDocForUser(user);
  const effectiveAccess = await buildFounderStudioEffectiveAccess(user, roleDoc);
  return ok(res, { data: { effectiveAccess }, effectiveAccess });
}

async function setModuleAccessHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserByIdOrStaffId(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_MODULE_ACCESS_CHANGED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = auditReasonFromBody(body);
  if (!reason) return bad(res, 400, 'auditReason is required', 'AUDIT_REASON_REQUIRED');
  const parsed = parseModuleAccessStates(body);
  if (!parsed.provided) return bad(res, 400, 'modules is required', 'NO_MODULE_CHANGES');
  if (parsed.errors.length) {
    const first = parsed.errors[0];
    return res.status(400).json({
      ok: false,
      success: false,
      status: 400,
      code: 'INVALID_MODULE_ACCESS_PAYLOAD',
      message: 'Invalid module access payload',
      field: first.field,
      invalidField: first.field,
      reason: first.reason,
      invalidFields: parsed.errors,
    });
  }
  const moduleAccessStates = parsed.states;
  const moduleAccessOverride = normalizeModuleAccess(parsed.enabledLegacyKeys);

  const updated = await User.findByIdAndUpdate(
    user._id,
    { $set: { moduleAccessOverride, moduleAccessStates, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { accessVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_ACCESS_CHANGE', String(updated._id), { oldValue: { moduleAccessOverride: user.moduleAccessOverride || [], moduleAccessStates: user.moduleAccessStates || {} }, newValue: { moduleAccessOverride, moduleAccessStates }, moduleAccessOverride, moduleAccessStates, reason, accessVersion: updated.accessVersion });
  const roleDoc = await loadRoleDocForUser(updated);
  return ok(res, { message: 'Module access updated.', data: { user: safeUserDto(updated), record: { moduleAccessOverride, moduleAccessStates, accessVersion: updated.accessVersion }, effectiveAccess: await buildFounderStudioEffectiveAccess(updated, roleDoc) }, user: safeUserDto(updated), record: { moduleAccessOverride, moduleAccessStates, accessVersion: updated.accessVersion } });
}

async function setSpecialRightsHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_SPECIAL_RIGHTS_CHANGED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = auditReasonFromBody(body);
  if (!reason) return bad(res, 400, 'auditReason is required', 'AUDIT_REASON_REQUIRED');
  const parsed = parseKeyMap(body.rights, body.specialRights, body.specialRightsOverride);
  if (!parsed.provided) return bad(res, 400, 'rights is required', 'NO_RIGHT_CHANGES');
  // Founder-only rights can never be granted to non-founder staff via the studio.
  const founderOnly = new Set(FOUNDER_ONLY_RIGHTS);
  const requested = normalizeSpecialRights(parsed.keys);
  const specialRightsOverride = requested.filter((key) => !founderOnly.has(key));
  const blockedFounderOnly = requested.filter((key) => founderOnly.has(key));
  const permissions = mergeLegacyPermissions(user.permissions, specialRightsOverride);

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { specialRightsOverride, permissions, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { accessVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_SPECIAL_RIGHTS_CHANGE', String(updated._id), { oldValue: user.specialRightsOverride || [], newValue: specialRightsOverride, specialRightsOverride, blockedFounderOnly, reason, accessVersion: updated.accessVersion });
  const roleDoc = await loadRoleDocForUser(updated);
  return ok(res, {
    message: blockedFounderOnly.length ? 'Special rights updated. Founder-only rights were ignored.' : 'Special rights updated.',
    data: { user: safeUserDto(updated), blockedFounderOnly, effectiveAccess: await buildFounderStudioEffectiveAccess(updated, roleDoc) },
    user: safeUserDto(updated),
    blockedFounderOnly,
  });
}

async function setTaskRightsHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_TASK_RIGHTS_CHANGED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = auditReasonFromBody(body);
  if (!reason) return bad(res, 400, 'auditReason is required', 'AUDIT_REASON_REQUIRED');
  const parsed = parseKeyMap(body.taskRights, body.rights, body.taskRightsOverride);
  if (!parsed.provided) return bad(res, 400, 'taskRights is required', 'NO_TASK_RIGHT_CHANGES');
  const taskRightsOverride = normalizeTaskRights(parsed.keys);

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { taskRightsOverride, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { accessVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_TASK_RIGHTS_CHANGE', String(updated._id), { oldValue: user.taskRightsOverride || [], newValue: taskRightsOverride, reason, accessVersion: updated.accessVersion });
  const roleDoc = await loadRoleDocForUser(updated);
  return ok(res, { message: 'Task rights updated.', data: { user: safeUserDto(updated), effectiveAccess: await buildFounderStudioEffectiveAccess(updated, roleDoc) }, user: safeUserDto(updated) });
}

async function setAccountControlRightsHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_ACCOUNT_CONTROL_RIGHTS_CHANGED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = auditReasonFromBody(body);
  if (!reason) return bad(res, 400, 'auditReason is required', 'AUDIT_REASON_REQUIRED');
  const parsed = parseKeyMap(body.accountControlRights, body.rights, body.accountControlRightsOverride);
  if (!parsed.provided) return bad(res, 400, 'accountControlRights is required', 'NO_ACCOUNT_CONTROL_RIGHT_CHANGES');
  const requested = normalizeAccountControlRights(parsed.keys);
  const accountControlRightsOverride = requested.filter((key) => !FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS.includes(key));
  const blockedFounderOnly = requested.filter((key) => FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS.includes(key));

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { accountControlRightsOverride, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { accessVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_ACCOUNT_CONTROL_RIGHTS_CHANGE', String(updated._id), { oldValue: user.accountControlRightsOverride || [], newValue: accountControlRightsOverride, blockedFounderOnly, reason, accessVersion: updated.accessVersion });
  const roleDoc = await loadRoleDocForUser(updated);
  return ok(res, {
    message: blockedFounderOnly.length ? 'Account control rights updated. Founder-only rights were ignored.' : 'Account control rights updated.',
    data: { user: safeUserDto(updated), blockedFounderOnly, effectiveAccess: await buildFounderStudioEffectiveAccess(updated, roleDoc) },
    user: safeUserDto(updated),
    blockedFounderOnly,
  });
}

async function grantTemporaryAccessHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_TEMP_ACCESS_GRANTED'))) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reason = auditReasonFromBody(body);
  if (!reason) return bad(res, 400, 'auditReason is required', 'AUDIT_REASON_REQUIRED');
  const canonicalTempModuleKey = canonicalModuleKey(body.moduleKey, { allowLegacy: true, allowAliases: true });
  const moduleKey = canonicalTempModuleKey && canonicalTempModuleKey !== 'safeZone' ? (CANONICAL_TO_LEGACY_MODULE[canonicalTempModuleKey] || canonicalTempModuleKey) : null;
  const rightKey = body.rightKey && SPECIAL_RIGHT_KEYS.includes(String(body.rightKey).trim()) ? String(body.rightKey).trim() : null;
  if (!moduleKey && !rightKey) return bad(res, 400, 'A valid moduleKey or rightKey is required', 'INVALID_TEMPORARY_TARGET');
  if (rightKey && FOUNDER_ONLY_RIGHTS.includes(rightKey)) return bad(res, 403, 'Founder-only rights cannot be granted temporarily', 'FOUNDER_ONLY_RIGHT');

  const expiresAt = parseDateOrNull(body.expiresAt);
  if (expiresAt === undefined || !expiresAt) return bad(res, 400, 'A valid ISO expiresAt is required for temporary access', 'INVALID_DATE');
  if (expiresAt <= new Date()) return bad(res, 400, 'expiresAt must be in the future', 'INVALID_DATE');

  const entry = {
    _id: new mongoose.Types.ObjectId(),
    moduleKey,
    rightKey,
    enabled: body.enabled !== false,
    expiresAt: expiresAt || null,
    reason,
    grantedBy: actorId(req),
    grantedAt: new Date(),
  };

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $push: { temporaryAccess: entry }, $set: { updatedBy: actorId(req), updatedAt: new Date() }, $inc: { accessVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_TEMP_ACCESS_GRANTED', String(updated._id), { moduleKey, canonicalModuleKey: canonicalTempModuleKey, rightKey, enabled: entry.enabled, expiresAt: entry.expiresAt, temporaryAccessId: String(entry._id), reason, accessVersion: updated.accessVersion });
  const roleDoc = await loadRoleDocForUser(updated);
  return ok(res, { message: 'Temporary access granted.', data: { user: safeUserDto(updated), temporaryAccess: normalizeTemporaryAccessList(updated.temporaryAccess), effectiveAccess: await buildFounderStudioEffectiveAccess(updated, roleDoc) }, user: safeUserDto(updated) }, 201);
}

async function removeTemporaryAccessHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (!(await ensureMutableStaffTarget(req, res, user, 'STAFF_TEMP_ACCESS_REMOVED'))) return;
  const temporaryAccessId = String(req.params.temporaryAccessId || '').trim();
  if (!mongoose.isValidObjectId(temporaryAccessId)) return bad(res, 400, 'Invalid temporaryAccessId', 'INVALID_ID');
  const exists = (Array.isArray(user.temporaryAccess) ? user.temporaryAccess : []).some((entry) => String(entry?._id) === temporaryAccessId);
  if (!exists) return bad(res, 404, 'Temporary access entry not found', 'NOT_FOUND');

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $pull: { temporaryAccess: { _id: new mongoose.Types.ObjectId(temporaryAccessId) } }, $set: { updatedBy: actorId(req), updatedAt: new Date() }, $inc: { accessVersion: 1 } },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_TEMP_ACCESS_REMOVED', String(updated._id), { temporaryAccessId, accessVersion: updated.accessVersion });
  const roleDoc = await loadRoleDocForUser(updated);
  return ok(res, { message: 'Temporary access removed.', data: { user: safeUserDto(updated), temporaryAccess: normalizeTemporaryAccessList(updated.temporaryAccess), effectiveAccess: await buildFounderStudioEffectiveAccess(updated, roleDoc) }, user: safeUserDto(updated) });
}

// ---------------------------------------------------------------------------
// Staff Control Center — Archived / Test Accounts
// ---------------------------------------------------------------------------

async function archivedListHandler(_req, res) {
  if (!isDbReady()) return ok(res, { data: { staff: [] }, staff: [], users: [] });
  const docs = await User.find({
    $and: [
      { $or: [{ role: { $in: TEAM_ROLES } }, { roleId: { $exists: true, $ne: null } }, { staffId: { $exists: true, $ne: null } }] },
      { $or: [{ isArchived: true }, { status: 'archived' }, { accountStatus: 'archived' }, { isTestAccount: true }] },
    ],
  }).sort({ archivedAt: -1, updatedAt: -1 }).lean();
  const staff = (docs || []).map(safeUserDto);
  return ok(res, { data: { staff, users: staff }, staff, users: staff });
}

async function restoreUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user) || String(user.staffId || '').trim().toUpperCase() === FOUNDER_STAFF_ID) {
    return blockFounderStaffAction(req, res, user, 'STAFF_RESTORED');
  }
  const now = new Date();
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        status: 'active',
        accountStatus: 'active',
        isArchived: false,
        archivedAt: null,
        archivedBy: null,
        loginAllowed: true,
        lockedUntil: null,
        updatedBy: actorId(req),
        updatedAt: now,
      },
    },
    { new: true },
  );
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'STAFF_RESTORED', req.params.id, { fromStatus: String(user.accountStatus || user.status || '') || null });
  return ok(res, { message: 'Staff account restored.', data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

function permanentDeleteConfirmed(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  return String(body.confirmText || '').trim() === 'DELETE';
}

function isProtectedFounderDeleteTarget(user) {
  const staffId = String(user?.staffId || '').trim().toUpperCase();
  const email = normalizeEmailAddress(user?.email);
  return isProtectedFounderUser(user) || staffId === FOUNDER_STAFF_ID || email === PROTECTED_FOUNDER_EMAIL;
}

async function deletePermanentlyHandler(req, res) {
  if (!ensureDb(res)) return;
  if (!actorIsFounder(req)) return bad(res, 403, 'Founder permission required.', 'FOUNDER_REQUIRED');
  if (!mongoose.isValidObjectId(String(req.params.id))) return bad(res, 400, 'Invalid id', 'INVALID_ID');
  const user = await User.findById(String(req.params.id));
  if (!user) return bad(res, 404, 'Staff not found.', 'NOT_FOUND');

  // Never delete Founder / NP-FND-0001 / protected accounts.
  if (isProtectedFounderDeleteTarget(user)) {
    await logAudit(req, 'FOUNDER_DELETE_BLOCKED', String(user._id), {
      staffId: user.staffId || null,
      targetStaffId: user.staffId || null,
      targetEmail: user.email || null,
      result: 'blocked',
      reason: 'founder_account_protected',
    });
    return bad(res, 403, 'Founder account cannot be deleted.', 'FOUNDER_PROTECTED');
  }

  const deleteReason = deleteReasonFromBody(req, null);
  if (!permanentDeleteConfirmed(req) || !deleteReason) return bad(res, 400, 'Confirmation text and reason are required.', 'MISSING_CONFIRMATION_OR_REASON');

  const isArchived = Boolean(user.isArchived || ['archived'].includes(String(user.accountStatus || user.status || '').toLowerCase()));
  const isTest = hasTestAccountMarker(user) || Boolean(user.isTestAccount);

  // Real staff accounts require explicit force delete AND must pass safety checks.
  if (!isArchived && !isTest) {
    if (req.body?.forceDelete !== true) {
      return bad(res, 400, 'Real staff accounts cannot be deleted. Archive the account or confirm force delete.', 'FORCE_DELETE_REQUIRED');
    }
  }
  const blockers = await getTestDeleteBlockers(user);
  if (blockers.length && !isArchived) {
    await logAudit(req, 'STAFF_DELETE_BLOCKED', String(user._id), { reasons: blockers, staffId: user.staffId || null });
    return bad(res, 400, 'Account has linked records and cannot be permanently deleted. Archive instead.', 'PERMANENT_DELETE_BLOCKED');
  }

  const removedSnapshot = safeUserDto(user);
  const deletedStaffId = user.staffId || null;
  const now = new Date();
  await markUserSessionsRevoked(user._id, now, 'staff_permanent_delete');
  const deleteResult = await User.deleteOne({ _id: user._id });
  if (!deleteResult || deleteResult.deletedCount !== 1) return bad(res, 404, 'Staff not found.', 'NOT_FOUND');
  retireStaffId(deletedStaffId);
  await logAudit(req, 'staff_deleted_permanently', String(user._id), {
    actor: 'Founder',
    targetStaffId: deletedStaffId,
    targetEmail: user.email || null,
    deletedStaffId,
    reason: deleteReason,
    result: 'success',
    time: now.toISOString(),
  });
  return ok(res, { message: 'Staff account permanently deleted.', deletedStaffId, data: { deleted: true, deletedStaffId, previousUser: removedSnapshot }, deleted: true });
}

// ---------------------------------------------------------------------------
// Staff Control Center — Roles & Workflow
// ---------------------------------------------------------------------------

async function rolesWorkflowHandler(_req, res) {
  let roleDocs = [];
  if (isDbReady()) {
    try { roleDocs = await Role.find({}).sort({ sortOrder: 1, name: 1 }).lean(); } catch (_) { roleDocs = []; }
  }
  const workflow = buildRolesWorkflow(roleDocs);
  return ok(res, { data: workflow, ...workflow });
}

function taskDto(task) {
  if (!task) return null;
  const id = task._id ? String(task._id) : (task.id ? String(task.id) : null);
  return {
    ...(id ? { id, _id: id } : {}),
    title: task.title || '',
    description: task.description || '',
    accountGroup: task.accountGroup || null,
    taskCategory: task.taskCategory || null,
    taskLevel: task.taskLevel || null,
    assignedToStaffId: task.assignedToStaffId || null,
    assignedByStaffId: task.assignedByStaffId || null,
    department: task.department || null,
    coverageArea: task.coverageArea || null,
    priority: task.priority || 'Normal',
    status: task.status || 'Assigned',
    dueDate: task.dueDate || null,
    relatedModule: task.relatedModule || null,
    relatedNewsId: task.relatedNewsId || null,
    attachments: Array.isArray(task.attachments) ? task.attachments : [],
    comments: Array.isArray(task.comments) ? task.comments : [],
    createdBy: task.createdBy || null,
    updatedBy: task.updatedBy || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    completedAt: task.completedAt || null,
    closedAt: task.closedAt || null,
    auditId: task.auditId || null,
  };
}

function actorStaffIdValue(req) {
  return String(req.user?.staffId || req.user?.id || '').trim() || null;
}

function parseTaskDate(value, fieldName) {
  if (value === undefined || value === null || value === '') return { value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { error: { status: 400, message: `Invalid ${fieldName}`, code: 'INVALID_DATE' } };
  return { value: date };
}

function normalizeTaskPayload(body, options = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const patch = {};
  if (options.requireTitle || input.title !== undefined) {
    const title = String(input.title || '').trim();
    if (!title) return { error: { status: 400, message: 'title is required', code: 'MISSING_TITLE' } };
    patch.title = title;
  }
  if (input.description !== undefined) patch.description = String(input.description || '').trim();
  if (input.accountGroup !== undefined) {
    const accountGroup = normalizeAccountGroup(input.accountGroup);
    if (input.accountGroup && !accountGroup) return { error: { status: 400, message: 'Invalid accountGroup', code: 'INVALID_ACCOUNT_GROUP' } };
    patch.accountGroup = accountGroup;
  }
  if (options.requireCategory || input.taskCategory !== undefined) {
    const taskCategory = TASK_CATEGORIES.find((item) => item.toLowerCase() === String(input.taskCategory || '').trim().toLowerCase());
    if (!taskCategory) return { error: { status: 400, message: 'Invalid taskCategory', code: 'INVALID_TASK_CATEGORY' } };
    patch.taskCategory = taskCategory;
  }
  if (options.requireLevel || input.taskLevel !== undefined) {
    const taskLevel = TASK_LEVELS.find((item) => item.toLowerCase() === String(input.taskLevel || '').trim().toLowerCase());
    if (!taskLevel) return { error: { status: 400, message: 'Invalid taskLevel', code: 'INVALID_TASK_LEVEL' } };
    patch.taskLevel = taskLevel;
  }
  if (input.assignedToStaffId !== undefined) patch.assignedToStaffId = String(input.assignedToStaffId || '').trim().toUpperCase() || null;
  if (input.assignedByStaffId !== undefined) patch.assignedByStaffId = String(input.assignedByStaffId || '').trim().toUpperCase() || null;
  if (input.department !== undefined) patch.department = String(input.department || '').trim() || null;
  if (input.coverageArea !== undefined) patch.coverageArea = String(input.coverageArea || '').trim() || null;
  if (input.priority !== undefined) {
    const priority = ['Low', 'Normal', 'High', 'Urgent'].find((item) => item.toLowerCase() === String(input.priority || '').trim().toLowerCase());
    if (!priority) return { error: { status: 400, message: 'Invalid priority', code: 'INVALID_PRIORITY' } };
    patch.priority = priority;
  }
  if (input.status !== undefined) {
    const status = TASK_STATUSES.find((item) => item.toLowerCase() === String(input.status || '').trim().toLowerCase());
    if (!status) return { error: { status: 400, message: 'Invalid status', code: 'INVALID_TASK_STATUS' } };
    patch.status = status;
  }
  if (input.dueDate !== undefined) {
    const dueDate = parseTaskDate(input.dueDate, 'dueDate');
    if (dueDate.error) return dueDate;
    patch.dueDate = dueDate.value;
  }
  if (input.relatedModule !== undefined) patch.relatedModule = input.relatedModule ? String(input.relatedModule || '').trim() : null;
  if (input.relatedNewsId !== undefined) {
    if (input.relatedNewsId && !mongoose.isValidObjectId(String(input.relatedNewsId))) return { error: { status: 400, message: 'Invalid relatedNewsId', code: 'INVALID_RELATED_NEWS_ID' } };
    patch.relatedNewsId = input.relatedNewsId || null;
  }
  if (input.attachments !== undefined) patch.attachments = Array.isArray(input.attachments) ? input.attachments.slice(0, 20).map((item) => ({ name: String(item?.name || '').trim() || null, url: String(item?.url || '').trim() || null, type: String(item?.type || '').trim() || null })) : [];
  return { patch };
}

function taskVisibilityQuery(req) {
  if (actorIsFounder(req)) return {};
  const actorStaffId = actorStaffIdValue(req);
  if (Array.isArray(req.user?.taskRights) && req.user.taskRights.includes('task_view_team')) return {};
  return { $or: [{ assignedToStaffId: actorStaffId }, { assignedByStaffId: actorStaffId }, { createdBy: actorId(req) }] };
}

async function findTaskById(req, res) {
  if (!mongoose.isValidObjectId(String(req.params.id))) {
    bad(res, 400, 'Invalid task id', 'INVALID_ID');
    return null;
  }
  const task = await StaffTask.findById(String(req.params.id));
  if (!task) {
    bad(res, 404, 'Task not found', 'TASK_NOT_FOUND');
    return null;
  }
  return task;
}

async function listTasksHandler(req, res) {
  if (!isDbReady()) return ok(res, { data: { tasks: [] }, tasks: [] });
  const docs = await StaffTask.find(taskVisibilityQuery(req)).sort({ createdAt: -1 }).limit(300).lean();
  const tasks = (docs || []).map(taskDto);
  return ok(res, { data: { tasks, categories: TASK_CATEGORIES, levels: TASK_LEVELS, statuses: TASK_STATUSES }, tasks });
}

async function getTaskHandler(req, res) {
  if (!ensureDb(res)) return;
  const task = await findTaskById(req, res);
  if (!task) return;
  const visibleQuery = taskVisibilityQuery(req);
  if (Object.keys(visibleQuery).length && !(await StaffTask.exists({ _id: task._id, ...visibleQuery }))) return bad(res, 403, 'Access Denied. Founder permission is required.', 'FORBIDDEN');
  return ok(res, { data: { task: taskDto(task) }, task: taskDto(task) });
}

async function createTaskHandler(req, res) {
  if (!ensureDb(res)) return;
  const parsed = normalizeTaskPayload(req.body, { requireTitle: true, requireCategory: true, requireLevel: true });
  if (parsed.error) return bad(res, parsed.error.status, parsed.error.message, parsed.error.code);
  const now = new Date();
  const created = await StaffTask.create({
    ...parsed.patch,
    assignedByStaffId: parsed.patch.assignedByStaffId || actorStaffIdValue(req),
    status: parsed.patch.status || 'Assigned',
    createdBy: actorId(req),
    updatedBy: actorId(req),
    createdAt: now,
    updatedAt: now,
  });
  await logAudit(req, 'TASK_CREATED', String(created._id), { targetType: 'staff_task', targetId: String(created._id), module: 'staff_tasks', newValue: taskDto(created) });
  return ok(res, { message: 'Task created.', data: { task: taskDto(created) }, task: taskDto(created) }, 201);
}

async function updateTaskHandler(req, res) {
  if (!ensureDb(res)) return;
  const task = await findTaskById(req, res);
  if (!task) return;
  const parsed = normalizeTaskPayload(req.body, {});
  if (parsed.error) return bad(res, parsed.error.status, parsed.error.message, parsed.error.code);
  const oldValue = taskDto(task);
  Object.assign(task, parsed.patch, { updatedBy: actorId(req), updatedAt: new Date() });
  if (task.status === 'Completed' && !task.completedAt) task.completedAt = new Date();
  if (task.status === 'Closed' && !task.closedAt) task.closedAt = new Date();
  await task.save();
  await logAudit(req, 'TASK_EDITED', String(task._id), { targetType: 'staff_task', targetId: String(task._id), module: 'staff_tasks', oldValue, newValue: taskDto(task) });
  return ok(res, { message: 'Task updated.', data: { task: taskDto(task) }, task: taskDto(task) });
}

async function assignTaskHandler(req, res, action = 'TASK_ASSIGNED') {
  if (!ensureDb(res)) return;
  const task = await findTaskById(req, res);
  if (!task) return;
  const assignedToStaffId = String(req.body?.assignedToStaffId || '').trim().toUpperCase();
  if (!assignedToStaffId) return bad(res, 400, 'assignedToStaffId is required', 'MISSING_ASSIGNEE');
  const oldValue = { assignedToStaffId: task.assignedToStaffId || null };
  task.assignedToStaffId = assignedToStaffId;
  task.assignedByStaffId = actorStaffIdValue(req);
  task.updatedBy = actorId(req);
  task.updatedAt = new Date();
  await task.save();
  await logAudit(req, action, String(task._id), { targetType: 'staff_task', targetId: String(task._id), module: 'staff_tasks', oldValue, newValue: { assignedToStaffId } });
  return ok(res, { message: action === 'TASK_REASSIGNED' ? 'Task reassigned.' : 'Task assigned.', data: { task: taskDto(task) }, task: taskDto(task) });
}

async function statusTaskHandler(req, res, forcedStatus = null) {
  if (!ensureDb(res)) return;
  const task = await findTaskById(req, res);
  if (!task) return;
  const status = forcedStatus || TASK_STATUSES.find((item) => item.toLowerCase() === String(req.body?.status || '').trim().toLowerCase());
  if (!status) return bad(res, 400, 'Invalid status', 'INVALID_TASK_STATUS');
  const oldValue = { status: task.status || null };
  task.status = status;
  task.updatedBy = actorId(req);
  task.updatedAt = new Date();
  if (status === 'Completed') task.completedAt = new Date();
  if (status === 'Closed') task.closedAt = new Date();
  await task.save();
  const action = status === 'Completed' ? 'TASK_COMPLETED' : (status === 'Closed' ? 'TASK_CLOSED' : 'TASK_STATUS_CHANGED');
  await logAudit(req, action, String(task._id), { targetType: 'staff_task', targetId: String(task._id), module: 'staff_tasks', oldValue, newValue: { status } });
  return ok(res, { message: 'Task status updated.', data: { task: taskDto(task) }, task: taskDto(task) });
}

async function commentTaskHandler(req, res) {
  if (!ensureDb(res)) return;
  const task = await findTaskById(req, res);
  if (!task) return;
  const message = String(req.body?.message || req.body?.comment || '').trim();
  if (!message) return bad(res, 400, 'comment is required', 'MISSING_COMMENT');
  task.comments.push({ staffId: actorStaffIdValue(req), userId: actorId(req), message, createdAt: new Date() });
  task.updatedBy = actorId(req);
  task.updatedAt = new Date();
  await task.save();
  await logAudit(req, 'TASK_COMMENTED', String(task._id), { targetType: 'staff_task', targetId: String(task._id), module: 'staff_tasks' });
  return ok(res, { message: 'Comment added.', data: { task: taskDto(task) }, task: taskDto(task) });
}

async function deleteTaskHandler(req, res) {
  if (!ensureDb(res)) return;
  const task = await findTaskById(req, res);
  if (!task) return;
  const oldValue = taskDto(task);
  await StaffTask.deleteOne({ _id: task._id });
  await logAudit(req, 'TASK_DELETED', String(task._id), { targetType: 'staff_task', targetId: String(task._id), module: 'staff_tasks', oldValue });
  return ok(res, { message: 'Task deleted.', data: { deleted: true }, deleted: true });
}

async function accountGroupsHandler(_req, res) {
  return ok(res, { data: { accountGroups: STAFF_CONTROL_CENTER.accountGroups.slice() }, accountGroups: STAFF_CONTROL_CENTER.accountGroups.slice() });
}

async function positionsHandler(_req, res) {
  return ok(res, { data: { positions: STAFF_CONTROL_CENTER.positions.slice() }, positions: STAFF_CONTROL_CENTER.positions.slice() });
}

async function defaultTaskTemplatesHandler(_req, res) {
  const templates = Object.fromEntries(Object.entries(DEFAULT_TASK_TEMPLATES).map(([key, value]) => [key, value.slice()]));
  return ok(res, { data: { defaultTaskTemplates: templates, categories: TASK_CATEGORIES, levels: TASK_LEVELS, statuses: TASK_STATUSES }, defaultTaskTemplates: templates });
}

router.get(['/users', '/team/users'], requireTeamAuth, requireTeamPermission('auth.create_user'), listUsersHandler);
router.post(['/create-user', '/team/users'], requireTeamAuth, requireTeamPermission('auth.create_user'), createUserHandler);
router.get(['/users/:id', '/team/users/:id'], requireTeamAuth, requireTeamPermission('auth.create_user'), getUserHandler);
router.patch(['/users/:id/email', '/team/users/:id/email'], requireTeamAuth, changeUserEmailHandler);
router.patch(['/users/:id', '/team/users/:id'], requireTeamAuth, requireTeamPermission('auth.create_user'), updateUserHandler);
router.patch(['/users/:id/access', '/team/users/:id/access'], requireTeamAuth, requireFounderActor, accessOverrideHandler);
router.patch(['/users/:id/suspend', '/team/users/:id/suspend'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), suspendUserHandler);
router.post('/team/users/:id/suspend', requireTeamAuth, requireTeamPermission('auth.suspend_user'), suspendUserHandler);
router.patch('/team/users/:id/status', requireTeamAuth, requireTeamPermission('auth.suspend_user'), statusHandler);
router.patch(['/users/:id/lock', '/team/users/:id/lock'], requireTeamAuth, requireTeamPermission('auth.lock_user'), lockUserHandler);
router.post(['/users/:id/lock', '/team/users/:id/lock'], requireTeamAuth, requireTeamPermission('auth.lock_user'), lockUserHandler);
router.post(['/users/:id/generate-temporary-password', '/team/users/:id/generate-temporary-password'], requireTeamAuth, requireTeamPermission('auth.generate_temp_password'), generateTemporaryPasswordHandler);
router.patch(['/users/:id/reset-password', '/team/users/:id/reset-password'], requireTeamAuth, requireTeamPermission('auth.reset_password'), resetPasswordHandler);
router.post(['/users/:id/reset-password', '/team/users/:id/reset-password'], requireTeamAuth, requireTeamPermission('auth.reset_password'), resetPasswordHandler);
router.post('/team/users/:id/force-reset', requireTeamAuth, requireTeamPermission('auth.reset_password'), resetPasswordHandler);
router.patch(['/users/:id/force-password-change', '/team/users/:id/force-password-change'], requireTeamAuth, requireTeamPermission('auth.force_password_change'), forcePasswordChangeHandler);
router.post(['/users/:id/force-change-password', '/team/users/:id/force-change-password'], requireTeamAuth, requireTeamPermission('auth.force_password_change'), forcePasswordChangeHandler);
router.post(['/users/:id/force-password-change', '/team/users/:id/force-password-change'], requireTeamAuth, requireTeamPermission('auth.force_password_change'), forcePasswordChangeHandler);
router.patch(['/users/:id/permissions', '/team/users/:id/permissions'], requireTeamAuth, requireFounderActor, permissionsHandler);
router.post(['/users/:id/logout-all', '/team/users/:id/logout-all'], requireTeamAuth, requireTeamPermission('auth.logout_user_sessions'), logoutAllHandler);
router.post(['/users/:id/logout-all-devices', '/team/users/:id/logout-all-devices'], requireTeamAuth, requireTeamPermission('auth.logout_user_sessions'), logoutAllHandler);
router.post(['/users/:id/extend-access', '/team/users/:id/extend-access'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), extendAccessHandler);
router.post(['/users/:id/reactivate', '/team/users/:id/reactivate'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), reactivateUserHandler);
router.post(['/users/:id/keep-expired', '/team/users/:id/keep-expired'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), keepExpiredHandler);
router.post(['/users/:id/archive', '/team/users/:id/archive'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), archiveUserHandler);
router.delete(['/users/:id/test-only', '/team/users/:id/test-only'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), deleteTestOnlyHandler);
router.post(['/users/:id/mark-test-account', '/team/users/:id/mark-test-account'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), markTestAccountHandler);
router.post('/team/users/:id/activate', requireTeamAuth, requireTeamPermission('auth.suspend_user'), activateUserHandler);
router.patch('/team/users/:id/activate', requireTeamAuth, requireTeamPermission('auth.suspend_user'), activateUserHandler);
router.get('/audit-logs', requireTeamAuth, requireTeamPermission('auth.view_login_activity'), auditLogsHandler);
router.get('/permissions', requireTeamAuth, (_req, res) => ok(res, { data: { permissions: AUTH_PERMISSIONS }, permissions: AUTH_PERMISSIONS }));
router.get(['/options', '/team/options'], requireTeamAuth, requireTeamPermission('auth.create_user'), optionsHandler);
router.get(['/next-staff-id', '/team/next-staff-id'], requireTeamAuth, requireTeamPermission('auth.create_user'), nextStaffIdHandler);

// --- Staff Control Center: Founder Access Studio ---
router.get(['/access/staff', '/team/access/staff'], requireTeamAuth, requireFounderActor, accessStaffListHandler);
router.get(['/access/staff/:id/effective-access', '/team/access/staff/:id/effective-access'], requireTeamAuth, requireFounderActor, effectiveAccessHandler);
router.get(['/access/staff/:id', '/team/access/staff/:id'], requireTeamAuth, requireFounderActor, accessStaffDetailHandler);
router.patch(['/access/staff/:id/modules', '/team/access/staff/:id/modules'], requireTeamAuth, requireFounderActor, setModuleAccessHandler);
router.patch(['/access/staff/:id/rights', '/team/access/staff/:id/rights'], requireTeamAuth, requireFounderActor, setSpecialRightsHandler);
router.patch(['/access/staff/:id/task-rights', '/team/access/staff/:id/task-rights'], requireTeamAuth, requireFounderActor, setTaskRightsHandler);
router.patch(['/access/staff/:id/account-control-rights', '/team/access/staff/:id/account-control-rights'], requireTeamAuth, requireFounderActor, setAccountControlRightsHandler);
router.post(['/access/staff/:id/temporary', '/team/access/staff/:id/temporary'], requireTeamAuth, requireFounderActor, grantTemporaryAccessHandler);
router.delete(['/access/staff/:id/temporary/:temporaryAccessId', '/team/access/staff/:id/temporary/:temporaryAccessId'], requireTeamAuth, requireFounderActor, removeTemporaryAccessHandler);

// --- Staff Control Center: Task Board / Assignment Desk ---
router.get(['/tasks', '/team/tasks'], requireTeamAuth, requireModuleAccess('staff_tasks'), listTasksHandler);
router.post(['/tasks', '/team/tasks'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_create'), createTaskHandler);
router.get(['/tasks/:id', '/team/tasks/:id'], requireTeamAuth, requireModuleAccess('staff_tasks'), getTaskHandler);
router.patch(['/tasks/:id', '/team/tasks/:id'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_edit'), updateTaskHandler);
router.post(['/tasks/:id/assign', '/team/tasks/:id/assign'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_assign'), (req, res) => assignTaskHandler(req, res, 'TASK_ASSIGNED'));
router.post(['/tasks/:id/reassign', '/team/tasks/:id/reassign'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_assign'), (req, res) => assignTaskHandler(req, res, 'TASK_REASSIGNED'));
router.post(['/tasks/:id/status', '/team/tasks/:id/status'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_update_status'), (req, res) => statusTaskHandler(req, res));
router.post(['/tasks/:id/comment', '/team/tasks/:id/comment'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_comment'), commentTaskHandler);
router.post(['/tasks/:id/complete', '/team/tasks/:id/complete'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_complete'), (req, res) => statusTaskHandler(req, res, 'Completed'));
router.post(['/tasks/:id/close', '/team/tasks/:id/close'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_close'), (req, res) => statusTaskHandler(req, res, 'Closed'));
router.delete(['/tasks/:id', '/team/tasks/:id'], requireTeamAuth, requireModuleAccess('staff_tasks'), requireTaskRight('task_delete'), deleteTaskHandler);

// --- Staff Control Center: Staff Registry ---
router.get(['/staff', '/team/staff'], requireTeamAuth, requireDelegatedRegistryRight('view_staff_registry'), listUsersHandler);
router.post(['/staff', '/team/staff'], requireTeamAuth, requireDelegatedRegistryRight('create_staff_account'), createUserHandler);
router.get(['/staff/:id', '/team/staff/:id'], requireTeamAuth, requireDelegatedAccountControlRight('view_staff_registry'), getUserHandler);
router.patch(['/staff/:id/email', '/team/staff/:id/email'], requireTeamAuth, changeUserEmailHandler);
router.patch(['/staff/:id', '/team/staff/:id'], requireTeamAuth, requireDelegatedAccountControlRight('edit_staff_details'), updateUserHandler);
router.get(['/staff/:id/account-control', '/team/staff/:id/account-control'], requireTeamAuth, requireDelegatedAccountControlRight('view_staff_registry'), accountControlStateHandler);

// --- Staff Control Center: Security & Sessions ---
router.post(['/staff/:id/generate-temporary-password', '/team/staff/:id/generate-temporary-password'], requireTeamAuth, requireDelegatedAccountControlRight('reset_temporary_password'), generateTemporaryPasswordHandler);
router.post(['/staff/:id/reset-password', '/team/staff/:id/reset-password'], requireTeamAuth, requireDelegatedAccountControlRight('reset_temporary_password'), resetPasswordHandler);
router.post(['/staff/:id/force-change-password', '/team/staff/:id/force-change-password'], requireTeamAuth, requireDelegatedAccountControlRight('force_password_change'), forcePasswordChangeHandler);
router.post(['/staff/:id/logout-all-devices', '/team/staff/:id/logout-all-devices'], requireTeamAuth, requireDelegatedAccountControlRight('logout_staff_sessions'), logoutAllHandler);
router.post(['/staff/:id/suspend', '/team/staff/:id/suspend'], requireTeamAuth, requireDelegatedAccountControlRight('suspend_staff_account'), suspendUserHandler);
router.post(['/staff/:id/lock', '/team/staff/:id/lock'], requireTeamAuth, requireDelegatedAccountControlRight('lock_staff_account'), lockUserHandler);
router.post(['/staff/:id/unlock', '/team/staff/:id/unlock'], requireTeamAuth, requireDelegatedAccountControlRight('unlock_staff_account'), unlockUserHandler);
router.post(['/staff/:id/reactivate', '/team/staff/:id/reactivate'], requireTeamAuth, requireDelegatedAccountControlRight('reactivate_expired_account'), reactivateUserHandler);
router.post(['/staff/:id/extend-access', '/team/staff/:id/extend-access'], requireTeamAuth, requireDelegatedAccountControlRight('extend_account_expiry'), extendAccessHandler);
router.post(['/staff/:id/change-expiry', '/team/staff/:id/change-expiry'], requireTeamAuth, requireDelegatedAccountControlRight('extend_account_expiry'), extendAccessHandler);
router.post(['/staff/:id/set-no-expiry', '/team/staff/:id/set-no-expiry'], requireTeamAuth, requireDelegatedAccountControlRight('extend_account_expiry'), (req, res) => { req.body = { ...(req.body || {}), noExpiry: true }; return extendAccessHandler(req, res); });
router.post(['/staff/:id/keep-expired', '/team/staff/:id/keep-expired'], requireTeamAuth, requireDelegatedAccountControlRight('extend_account_expiry'), keepExpiredHandler);

// --- Staff Control Center: Archived / Test Accounts ---
router.get(['/archived', '/team/archived'], requireTeamAuth, requireDelegatedRegistryRight('archive_staff_account'), archivedListHandler);
router.post(['/staff/:id/archive', '/team/staff/:id/archive'], requireTeamAuth, requireDelegatedAccountControlRight('archive_staff_account'), archiveUserHandler);
router.post(['/staff/:id/restore', '/team/staff/:id/restore'], requireTeamAuth, requireDelegatedAccountControlRight('reactivate_expired_account'), restoreUserHandler);
router.delete(['/staff/:id/delete-permanently', '/team/staff/:id/delete-permanently'], requirePermanentDeleteAuth, deletePermanentlyHandler);

// --- Staff Control Center: Delegated Account Control ---
router.get(['/delegations', '/team/delegations'], requireTeamAuth, requireFounderActor, listDelegationsHandler);
router.post(['/delegations', '/team/delegations'], requireTeamAuth, requireFounderActor, grantDelegationHandler);
router.patch(['/delegations/:id', '/team/delegations/:id'], requireTeamAuth, requireFounderActor, updateDelegationHandler);
router.delete(['/delegations/:id', '/team/delegations/:id'], requireTeamAuth, requireFounderActor, revokeDelegationHandler);

// --- Staff Control Center: Roles & Workflow ---
router.get(['/account-groups', '/team/account-groups'], requireTeamAuth, accountGroupsHandler);
router.get(['/positions', '/team/positions'], requireTeamAuth, positionsHandler);
router.get(['/default-task-templates', '/team/default-task-templates'], requireTeamAuth, defaultTaskTemplatesHandler);
router.get(['/roles-workflow', '/team/roles-workflow'], requireTeamAuth, requireTeamPermission('auth.create_user'), rolesWorkflowHandler);

module.exports = router;