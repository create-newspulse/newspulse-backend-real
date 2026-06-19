const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const Role = require('../models/Role');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireAuth } = require('../middleware/requireAuth');
const { logAudit } = require('../lib/audit');
const {
  AUTH_PERMISSIONS,
  FOUNDER_ONLY_MODULES,
  FOUNDER_ONLY_RIGHTS,
  ROLE_DEFAULT_ACCESS,
  ROLE_DEPARTMENT_DEFAULTS,
  TEAM_ASSIGNED_SECTIONS,
  TEAM_COVERAGE_AREAS,
  TEAM_DEPARTMENTS,
  TEAM_ROLES,
  defaultDepartmentForRole,
  hasPermission,
  isFounderRole,
  isProtectedFounderUser,
  legacyPermissionsFromRights,
  normalizeModuleAccess,
  normalizeOrganizationFields,
  normalizePermissions,
  normalizeRole,
  normalizeSpecialRights,
  normalizeStatus,
  normalizeStringList,
  requirePasswordPolicy,
  safeUserDto,
} = require('../lib/teamAccess');

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, ...data });
}

function bad(res, status, message, code) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function syncReqUserFromAdmin(req) {
  if (!req.admin) return;
  req.user = {
    id: req.admin.id || null,
    email: req.admin.email || null,
    name: req.admin.name || null,
    role: req.admin.role || null,
    permissions: Array.isArray(req.admin.permissions) ? req.admin.permissions : [],
    status: req.admin.status || 'active',
    mustChangePassword: Boolean(req.admin.mustChangePassword),
    tokenVersion: typeof req.admin.tokenVersion === 'number' ? req.admin.tokenVersion : 0,
    isFounder: Boolean(req.admin.isFounder || normalizeRole(req.admin.role) === 'founder'),
    isProtected: Boolean(req.admin.isProtected || normalizeRole(req.admin.role) === 'founder'),
  };
}

function requireTeamAuth(req, res, next) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.toLowerCase().startsWith('bearer ')) return requireAuth(req, res, next);

  return requireAdminAuth(req, res, function onAuthed(err) {
    if (err) return next(err);
    syncReqUserFromAdmin(req);
    return next();
  });
}

function requireTeamPermission(permission) {
  return (req, res, next) => {
    if (!req.user) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
    if (!hasPermission(req.user, permission)) return bad(res, 403, 'Forbidden', 'FORBIDDEN');
    return next();
  };
}

function requireFounderActor(req, res, next) {
  if (!req.user) return bad(res, 401, 'Unauthorized', 'UNAUTHORIZED');
  if (!isFounderRole(req.user.role) && !req.user.isFounder) return bad(res, 403, 'Founder role required', 'FOUNDER_REQUIRED');
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

function actorId(req) {
  return mongoose.isValidObjectId(req.user?.id) ? req.user.id : null;
}

function userListQuery() {
  return { $or: [{ role: { $in: TEAM_ROLES } }, { roleId: { $exists: true, $ne: null } }, { staffId: { $exists: true, $ne: null } }] };
}

function parseDateOrNull(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date;
}

async function assignTemporaryPassword(userOrId) {
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const update = {
    $set: {
      passwordHash,
      mustChangePassword: true,
      mustResetPassword: true,
      forceReset: true,
      tempPasswordExpiresAt: expiresAt,
      status: 'active',
      updatedAt: new Date(),
    },
    $inc: { tokenVersion: 1 },
  };

  const id = typeof userOrId === 'object' && userOrId?._id ? userOrId._id : userOrId;
  const updated = await User.findByIdAndUpdate(id, update, { new: true });
  return { updated, tempPassword, tempPasswordExpiresAt: expiresAt };
}

function roleSlugFromName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s*&\s*/g, '-')
    .replace(/\s*\/\s*/g, '-')
    .replace(/\s+/g, '-');
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
  const specialRightsOverride = hasRights ? normalizeSpecialRights(body.specialRightsOverride || body.specialRights) : undefined;
  return {
    patch: {
      ...(hasModules ? { moduleAccessOverride } : {}),
      ...(hasRights ? { specialRightsOverride, permissions: mergeLegacyPermissions(body.permissions, specialRightsOverride) } : {}),
    },
    audit: [
      ...(hasModules ? ['moduleAccessOverride'] : []),
      ...(hasRights ? ['specialRightsOverride'] : []),
    ],
  };
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
  const assignedInput = body.assignedSections !== undefined
    ? body.assignedSections
    : (body.sections !== undefined
      ? body.sections
      : ((Array.isArray(currentUser?.assignedSections) && currentUser.assignedSections.length)
        ? currentUser.assignedSections
        : currentUser?.sections));
  const coverageInput = body.coverageAreas !== undefined ? body.coverageAreas : currentUser?.coverageAreas;

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

async function listUsersHandler(_req, res) {
  if (!isDbReady()) {
    return ok(res, { data: { users: [], availableRoles: TEAM_ROLES }, users: [], availableRoles: TEAM_ROLES });
  }

  const docs = await User.find(userListQuery()).sort({ createdAt: -1 }).lean();
  const users = (docs || []).map(safeUserDto);
  return ok(res, { data: { users, availableRoles: TEAM_ROLES }, users, availableRoles: TEAM_ROLES });
}

async function createUserHandler(req, res) {
  if (!ensureDb(res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const fullName = String(body.fullName || body.name || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const staffId = body.staffId != null ? String(body.staffId || '').trim() : null;
  const permissions = normalizePermissions(body.permissions);
  const generateTemporaryPassword = body.generateTemporaryPassword !== false;
  const providedPassword = String(body.password || body.initialPassword || '');
  const accessExpiresAt = parseDateOrNull(body.accessExpiresAt);

  if (!fullName) return bad(res, 400, 'fullName is required', 'MISSING_FULL_NAME');
  if (!email) return bad(res, 400, 'email is required', 'INVALID_EMAIL');
  const roleAssignment = await resolveRoleAssignment(req, body, 'intern');
  if (roleAssignment.error) return bad(res, roleAssignment.error.status, roleAssignment.error.message, roleAssignment.error.code);
  const organization = normalizeUserOrganizationInput(body, roleAssignment.role);
  if (organization.error) return bad(res, organization.error.status, organization.error.message, organization.error.code);
  const accessOverride = parseAccessOverride(req, body);
  if (accessOverride.error) return bad(res, accessOverride.error.status, accessOverride.error.message, accessOverride.error.code);
  if (accessExpiresAt === undefined && body.accessExpiresAt !== undefined) return bad(res, 400, 'Invalid accessExpiresAt', 'INVALID_DATE');
  if (!generateTemporaryPassword) {
    const policy = requirePasswordPolicy(providedPassword);
    if (!policy.ok) return bad(res, 400, policy.message, 'WEAK_PASSWORD');
  }

  const existing = await User.findOne({ email }).lean();
  if (existing) return bad(res, 409, 'Email already exists', 'EMAIL_EXISTS');

  const temporaryPassword = generateTemporaryPassword ? generateTempPassword() : null;
  const password = generateTemporaryPassword ? temporaryPassword : providedPassword;
  const passwordHash = await hashPassword(password);
  const tempPasswordExpiresAt = generateTemporaryPassword ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null;

  const created = await User.create({
    email,
    name: fullName,
    fullName,
    staffId: staffId || null,
    roleId: roleAssignment.roleId || null,
    roleName: roleAssignment.roleName || roleAssignment.role,
    role: roleAssignment.role,
    department: organization.department,
    sections: organization.sections,
    assignedSections: organization.assignedSections,
    coverageAreas: organization.coverageAreas,
    designation: body.designation != null ? String(body.designation || '').trim() : null,
    permissions: accessOverride.patch.permissions || permissions,
    moduleAccessOverride: accessOverride.patch.moduleAccessOverride || [],
    specialRightsOverride: accessOverride.patch.specialRightsOverride || [],
    passwordHash,
    status: normalizeStatus(body.status) || 'active',
    mustChangePassword: generateTemporaryPassword,
    mustResetPassword: generateTemporaryPassword,
    forceReset: generateTemporaryPassword,
    tempPasswordExpiresAt,
    createdBy: actorId(req),
    updatedBy: actorId(req),
    accessExpiresAt: accessExpiresAt === undefined ? null : accessExpiresAt,
    isFounder: false,
    isProtected: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await logAudit(req, 'TEAM_CREATE_USER', String(created._id), { email, role: roleAssignment.role, roleId: roleAssignment.roleId || null, generatedTemporaryPassword: generateTemporaryPassword });
  if (roleAssignment.roleId) await logAudit(req, 'TEAM_ROLE_CHANGE', String(created._id), { to: roleAssignment.roleId, role: roleAssignment.role });
  if (accessOverride.audit.length) await logAudit(req, 'TEAM_ACCESS_CHANGE', String(created._id), { fields: accessOverride.audit });
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
  return ok(res, { data: { user: safeUserDto(user) }, user: safeUserDto(user) });
}

async function updateUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

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
    patch.staffId = body.staffId != null ? String(body.staffId || '').trim() : null;
    audit.fields.push('staffId');
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
  if (body.accessExpiresAt !== undefined) {
    const accessExpiresAt = parseDateOrNull(body.accessExpiresAt);
    if (accessExpiresAt === undefined) return bad(res, 400, 'Invalid accessExpiresAt', 'INVALID_DATE');
    patch.accessExpiresAt = accessExpiresAt;
    audit.fields.push('accessExpiresAt');
  }
  if (body.status !== undefined) {
    const status = normalizeStatus(body.status);
    if (!status) return bad(res, 400, 'Invalid status', 'INVALID_STATUS');
    patch.status = status;
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

  const updated = await User.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true });
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');

  if (audit.roleChanged) await logAudit(req, 'TEAM_ROLE_CHANGE', String(updated._id), audit.roleChanged);
  if (accessOverride.audit.includes('moduleAccessOverride')) await logAudit(req, 'TEAM_ACCESS_CHANGE', String(updated._id), { moduleAccessOverride: patch.moduleAccessOverride });
  if (accessOverride.audit.includes('specialRightsOverride')) await logAudit(req, 'TEAM_SPECIAL_RIGHTS_CHANGE', String(updated._id), { specialRightsOverride: patch.specialRightsOverride });
  await logAudit(req, 'TEAM_UPDATE_USER', String(updated._id), audit);
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function accessOverrideHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder permissions are protected', 'FOUNDER_PROTECTED');

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
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'suspended', updatedBy: actorId(req), updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await logAudit(req, 'TEAM_SUSPEND_USER', req.params.id, null);
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function lockUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const lockedUntil = parseDateOrNull(body.lockedUntil);
  if (lockedUntil === undefined && body.lockedUntil !== undefined) return bad(res, 400, 'Invalid lockedUntil', 'INVALID_DATE');
  const finalLockedUntil = lockedUntil === undefined ? new Date(Date.now() + 24 * 60 * 60 * 1000) : lockedUntil;
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'locked', lockedUntil: finalLockedUntil, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await logAudit(req, 'TEAM_LOCK_USER', req.params.id, { lockedUntil: finalLockedUntil });
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function resetPasswordHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');
  if (!hasPermission(req.user, 'auth.generate_temp_password')) return bad(res, 403, 'Forbidden', 'FORBIDDEN');

  const { updated, tempPassword, tempPasswordExpiresAt } = await assignTemporaryPassword(req.params.id);
  if (!updated) return bad(res, 404, 'Not found', 'NOT_FOUND');
  await logAudit(req, 'TEAM_RESET_PASSWORD', req.params.id, { temporaryPasswordExpiresAt: tempPasswordExpiresAt });
  return ok(res, { data: { user: safeUserDto(updated), temporaryPassword: tempPassword, tempPassword, tempPasswordExpiresAt } });
}

async function forcePasswordChangeHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');

  const updated = await User.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        mustChangePassword: true,
        mustResetPassword: true,
        forceReset: true,
        updatedBy: actorId(req),
        updatedAt: new Date(),
      },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  );
  await logAudit(req, 'TEAM_FORCE_PASSWORD_CHANGE', req.params.id, null);
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function permissionsHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder permissions are protected', 'FOUNDER_PROTECTED');

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
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $inc: { tokenVersion: 1 }, $set: { updatedBy: actorId(req), updatedAt: new Date() } },
    { new: true },
  );
  await logAudit(req, 'TEAM_LOGOUT_USER_SESSIONS', req.params.id, null);
  return ok(res, { data: { user: safeUserDto(updated), tokenVersion: updated.tokenVersion }, user: safeUserDto(updated), tokenVersion: updated.tokenVersion });
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
    },
    roles: TEAM_ROLES,
    departments: TEAM_DEPARTMENTS,
    assignedSections: TEAM_ASSIGNED_SECTIONS,
    coverageAreas: TEAM_COVERAGE_AREAS,
    roleDepartmentDefaults: ROLE_DEPARTMENT_DEFAULTS,
  });
}

async function activateUserHandler(req, res) {
  if (!ensureDb(res)) return;
  const user = await findUserById(req.params.id, res);
  if (!user) return;
  if (isProtectedFounderUser(user)) return bad(res, 403, 'Founder account is protected', 'FOUNDER_PROTECTED');
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { $set: { status: 'active', lockedUntil: null, updatedBy: actorId(req), updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
    { new: true },
  );
  await logAudit(req, 'TEAM_ACTIVATE_USER', req.params.id, null);
  return ok(res, { data: { user: safeUserDto(updated) }, user: safeUserDto(updated) });
}

async function statusHandler(req, res) {
  const status = normalizeStatus(req.body?.status);
  if (status === 'suspended') return suspendUserHandler(req, res);
  if (status === 'locked') return lockUserHandler(req, res);
  if (status === 'active') return activateUserHandler(req, res);
  return bad(res, 400, 'Invalid status', 'INVALID_STATUS');
}

router.get(['/users', '/team/users'], requireTeamAuth, requireTeamPermission('auth.create_user'), listUsersHandler);
router.post(['/create-user', '/team/users'], requireTeamAuth, requireTeamPermission('auth.create_user'), createUserHandler);
router.get(['/users/:id', '/team/users/:id'], requireTeamAuth, requireTeamPermission('auth.create_user'), getUserHandler);
router.patch(['/users/:id', '/team/users/:id'], requireTeamAuth, requireTeamPermission('auth.create_user'), updateUserHandler);
router.patch(['/users/:id/access', '/team/users/:id/access'], requireTeamAuth, requireFounderActor, accessOverrideHandler);
router.patch(['/users/:id/suspend', '/team/users/:id/suspend'], requireTeamAuth, requireTeamPermission('auth.suspend_user'), suspendUserHandler);
router.post('/team/users/:id/suspend', requireTeamAuth, requireTeamPermission('auth.suspend_user'), suspendUserHandler);
router.patch('/team/users/:id/status', requireTeamAuth, requireTeamPermission('auth.suspend_user'), statusHandler);
router.patch(['/users/:id/lock', '/team/users/:id/lock'], requireTeamAuth, requireTeamPermission('auth.lock_user'), lockUserHandler);
router.patch(['/users/:id/reset-password', '/team/users/:id/reset-password'], requireTeamAuth, requireTeamPermission('auth.reset_password'), resetPasswordHandler);
router.post('/team/users/:id/force-reset', requireTeamAuth, requireTeamPermission('auth.reset_password'), resetPasswordHandler);
router.patch(['/users/:id/force-password-change', '/team/users/:id/force-password-change'], requireTeamAuth, requireTeamPermission('auth.force_password_change'), forcePasswordChangeHandler);
router.patch(['/users/:id/permissions', '/team/users/:id/permissions'], requireTeamAuth, requireFounderActor, permissionsHandler);
router.post(['/users/:id/logout-all', '/team/users/:id/logout-all'], requireTeamAuth, requireTeamPermission('auth.logout_user_sessions'), logoutAllHandler);
router.post('/team/users/:id/activate', requireTeamAuth, requireTeamPermission('auth.suspend_user'), activateUserHandler);
router.patch('/team/users/:id/activate', requireTeamAuth, requireTeamPermission('auth.suspend_user'), activateUserHandler);
router.get('/audit-logs', requireTeamAuth, requireTeamPermission('auth.view_login_activity'), auditLogsHandler);
router.get('/permissions', requireTeamAuth, (_req, res) => ok(res, { data: { permissions: AUTH_PERMISSIONS }, permissions: AUTH_PERMISSIONS }));
router.get(['/options', '/team/options'], requireTeamAuth, requireTeamPermission('auth.create_user'), optionsHandler);

module.exports = router;