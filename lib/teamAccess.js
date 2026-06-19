const TEAM_ROLES = Object.freeze([
  'founder',
  'admin',
  'finance & accounts manager',
  'manager',
  'editor',
  'copy editor',
  'fact checker',
  'reporter',
  'live tv controller',
  'video editor',
  'ads & revenue growth manager',
  'social media manager',
  'tech support',
  'intern',
]);

const TEAM_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'expired', 'locked']);

const TEAM_DEPARTMENTS = Object.freeze([
  'Founder / Ownership',
  'Administration',
  'Finance & Accounts',
  'Operations / Newsroom Management',
  'Editorial / Newsroom',
  'Copy Desk / Editorial Desk',
  'Fact Check / Compliance',
  'Field Reporting / Newsroom',
  'Broadcast / Live TV',
  'Video Production',
  'Growth / Monetization',
  'Social Media',
  'Technology / IT',
  'Training / Internship',
]);

const TEAM_ASSIGNED_SECTIONS = Object.freeze([
  'All Sections',
  'National',
  'International',
  'Business',
  'Technology',
  'Science',
  'Sports',
  'Entertainment',
  'Lifestyle',
  'Gujarat',
  'Editorial',
  'Viral Videos',
  'Live TV',
  'Ads',
  'Finance',
  'Compliance',
  'SEO',
  'Analytics',
  'Technical',
  'Training',
]);

const TEAM_COVERAGE_AREAS = Object.freeze([
  'All Gujarat',
  'Ahmedabad',
  'Surat',
  'Rajkot',
  'Vadodara',
  'Gandhinagar',
  'Kutch',
  'Saurashtra',
  'South Gujarat',
  'North Gujarat',
  'Central Gujarat',
]);

const ROLE_DEPARTMENT_DEFAULTS = Object.freeze({
  founder: 'Founder / Ownership',
  admin: 'Administration',
  'finance & accounts manager': 'Finance & Accounts',
  manager: 'Operations / Newsroom Management',
  editor: 'Editorial / Newsroom',
  'copy editor': 'Copy Desk / Editorial Desk',
  'fact checker': 'Fact Check / Compliance',
  reporter: 'Field Reporting / Newsroom',
  'live tv controller': 'Broadcast / Live TV',
  'video editor': 'Video Production',
  'ads & revenue growth manager': 'Growth / Monetization',
  'social media manager': 'Social Media',
  'tech support': 'Technology / IT',
  intern: 'Training / Internship',
});

const ADMIN_MODULE_KEYS = Object.freeze([
  'dashboard',
  'add_news',
  'manage_news',
  'draft_desk',
  'community_reporter_queue',
  'reporter_portal_admin',
  'broadcast_center',
  'ads_manager',
  'finance_desk',
  'media',
  'viral_videos',
  'aira',
  'live_tv',
  'editorial',
  'seo',
  'analytics',
  'moderation',
  'compliance_reports',
  'ai_engine',
  'settings',
  'safe_zone',
  'team_management',
]);

const SPECIAL_RIGHT_KEYS = Object.freeze([
  'news_publish',
  'news_delete',
  'news_approve',
  'news_reject',
  'news_send_back',
  'news_pin_breaking',
  'live_tv_prepare',
  'live_tv_start',
  'live_tv_stop',
  'live_tv_emergency_stop',
  'ads_view',
  'ads_manage_slots',
  'ads_manage_sponsor_leads',
  'ads_manage_campaigns',
  'ads_view_analytics',
  'sponsor_submit_for_approval',
  'finance_view',
  'finance_create_invoice',
  'finance_update_invoice_status',
  'finance_add_revenue_entry',
  'finance_add_expense_entry',
  'finance_upload_receipt',
  'finance_prepare_monthly_report',
  'finance_export_summary',
  'finance_view_sponsor_payment_status',
  'finance_approve_payment',
  'finance_delete_record',
  'finance_change_bank_details',
  'finance_change_payment_gateway',
  'finance_approve_withdrawal',
  'finance_final_report_approval',
  'compliance_view',
  'staff_create',
  'staff_suspend',
  'staff_reset_password',
  'role_create',
  'role_edit',
  'role_delete',
  'settings_change',
  'safe_zone_access',
  'ai_engine_control',
  'emergency_lock',
]);

const FOUNDER_ONLY_MODULES = Object.freeze([
  'team_management',
  'settings',
  'safe_zone',
  'live_tv',
  'ai_engine',
]);

const FOUNDER_ONLY_RIGHTS = Object.freeze([
  'safe_zone_access',
  'role_create',
  'role_edit',
  'role_delete',
  'settings_change',
  'ai_engine_control',
  'emergency_lock',
  'live_tv_start',
  'live_tv_emergency_stop',
  'news_publish',
  'news_delete',
  'finance_approve_payment',
  'finance_delete_record',
  'finance_change_bank_details',
  'finance_change_payment_gateway',
  'finance_approve_withdrawal',
  'finance_final_report_approval',
]);

const AUTH_PERMISSIONS = Object.freeze([
  'auth.create_user',
  'auth.reset_password',
  'auth.generate_temp_password',
  'auth.force_password_change',
  'auth.suspend_user',
  'auth.lock_user',
  'auth.logout_user_sessions',
  'auth.view_login_activity',
]);

const TEAM_MANAGEMENT_PERMISSIONS = Object.freeze([
  'staff_activity_view_all',
  'staff_activity_view_own',
  'attendance_view_all',
  'attendance_view_own',
  'attendance_correct',
  'attendance_export',
  'schedule_manage',
  'schedule_view_own',
  'leave_approve',
  'leave_request',
  'offday_manage',
]);

const OWN_STAFF_PERMISSIONS = Object.freeze([
  'staff_activity_view_own',
  'attendance_view_own',
  'schedule_view_own',
  'leave_request',
]);

const FOUNDER_PERMISSIONS = Object.freeze([
  ...AUTH_PERMISSIONS,
  ...TEAM_MANAGEMENT_PERMISSIONS,
  'team.manage',
  'audit.read',
  'safe_owner_zone.full_access',
  'live_tv.full_access',
  'live_tv.emergency_stop',
  'ai.controls',
  'kiranos.controls',
  'emergency.controls',
  'ads_revenue.manage',
  'legal_compliance.manage',
  'system.settings.manage',
]);

const LEGACY_PERMISSION_TO_RIGHT = Object.freeze({
  'auth.create_user': 'staff_create',
  'auth.reset_password': 'staff_reset_password',
  'auth.generate_temp_password': 'staff_reset_password',
  'auth.force_password_change': 'staff_reset_password',
  'auth.suspend_user': 'staff_suspend',
  'auth.lock_user': 'staff_suspend',
  'auth.logout_user_sessions': 'staff_suspend',
  'auth.view_login_activity': 'compliance_view',
  'team.manage': 'staff_create',
  'audit.read': 'compliance_view',
  'safe_owner_zone.full_access': 'safe_zone_access',
  'live_tv.full_access': 'live_tv_start',
  'live_tv.emergency_stop': 'live_tv_emergency_stop',
  'ai.controls': 'ai_engine_control',
  'emergency.controls': 'emergency_lock',
  'ads_revenue.manage': 'ads_manage_campaigns',
  'legal_compliance.manage': 'compliance_view',
  'system.settings.manage': 'settings_change',
});

const RIGHT_TO_LEGACY_PERMISSION = Object.freeze({
  staff_create: 'auth.create_user',
  staff_suspend: 'auth.suspend_user',
  staff_reset_password: 'auth.reset_password',
  role_create: 'team.manage',
  role_edit: 'team.manage',
  role_delete: 'team.manage',
  compliance_view: 'auth.view_login_activity',
  safe_zone_access: 'safe_owner_zone.full_access',
  live_tv_start: 'live_tv.full_access',
  live_tv_emergency_stop: 'live_tv.emergency_stop',
  ai_engine_control: 'ai.controls',
  emergency_lock: 'emergency.controls',
  ads_manage_campaigns: 'ads_revenue.manage',
  settings_change: 'system.settings.manage',
});

const ROLE_DEFAULT_PERMISSIONS = Object.freeze({
  editor: Object.freeze(['content.fact_check']),
  'fact checker': Object.freeze(['content.fact_check']),
  'copy editor': Object.freeze(['content.write', 'content.edit_copy', 'content.submit_review']),
  reporter: Object.freeze(['content.submit_field_report', 'content.write_draft', 'content.upload_media', 'content.submit_breaking_alert']),
  'live tv controller': Object.freeze(['live_tv.prepare_stream', 'live_tv.prepare_schedule', 'live_tv.prepare_recordings']),
});

const ROLE_DEFAULT_ACCESS = Object.freeze({
  founder: Object.freeze({ moduleAccess: ADMIN_MODULE_KEYS, specialRights: SPECIAL_RIGHT_KEYS }),
  admin: Object.freeze({ moduleAccess: ['dashboard', 'add_news', 'manage_news', 'draft_desk', 'community_reporter_queue', 'reporter_portal_admin', 'broadcast_center', 'ads_manager', 'finance_desk', 'media', 'viral_videos', 'aira', 'live_tv', 'editorial', 'seo', 'analytics', 'moderation', 'compliance_reports'], specialRights: ['news_publish', 'news_delete', 'news_approve', 'news_reject', 'news_send_back', 'news_pin_breaking', 'live_tv_prepare', 'live_tv_stop', 'ads_view', 'ads_manage_slots', 'ads_manage_sponsor_leads', 'ads_manage_campaigns', 'ads_view_analytics', 'finance_view', 'finance_create_invoice', 'finance_update_invoice_status', 'finance_add_revenue_entry', 'finance_add_expense_entry', 'finance_upload_receipt', 'finance_prepare_monthly_report', 'finance_export_summary', 'finance_view_sponsor_payment_status', 'compliance_view'] }),
  'finance & accounts manager': Object.freeze({ moduleAccess: ['dashboard', 'finance_desk', 'ads_manager', 'analytics'], specialRights: ['finance_view', 'finance_create_invoice', 'finance_update_invoice_status', 'finance_add_revenue_entry', 'finance_add_expense_entry', 'finance_upload_receipt', 'finance_prepare_monthly_report', 'finance_export_summary', 'finance_view_sponsor_payment_status', 'ads_view', 'ads_view_analytics'] }),
  manager: Object.freeze({ moduleAccess: ['dashboard', 'manage_news', 'draft_desk', 'community_reporter_queue', 'reporter_portal_admin', 'broadcast_center', 'ads_manager', 'media', 'analytics', 'moderation', 'compliance_reports'], specialRights: ['news_approve', 'news_reject', 'news_send_back', 'ads_view', 'ads_view_analytics', 'compliance_view'] }),
  editor: Object.freeze({ moduleAccess: ['dashboard', 'add_news', 'manage_news', 'draft_desk', 'media', 'editorial', 'seo', 'analytics'], specialRights: ['news_publish', 'news_approve', 'news_reject', 'news_send_back', 'news_pin_breaking'] }),
  'copy editor': Object.freeze({ moduleAccess: ['dashboard', 'add_news', 'manage_news', 'draft_desk', 'media', 'editorial', 'seo'], specialRights: ['news_send_back'] }),
  'fact checker': Object.freeze({ moduleAccess: ['dashboard', 'manage_news', 'draft_desk', 'media', 'editorial'], specialRights: ['news_approve', 'news_reject', 'news_send_back'] }),
  reporter: Object.freeze({ moduleAccess: ['dashboard', 'add_news', 'media'], specialRights: [] }),
  'live tv controller': Object.freeze({ moduleAccess: ['dashboard', 'broadcast_center', 'media', 'live_tv'], specialRights: ['live_tv_prepare', 'live_tv_stop'] }),
  'video editor': Object.freeze({ moduleAccess: ['dashboard', 'media', 'viral_videos', 'broadcast_center'], specialRights: [] }),
  'ads & revenue growth manager': Object.freeze({ moduleAccess: ['dashboard', 'ads_manager', 'analytics'], specialRights: ['ads_view', 'ads_manage_slots', 'ads_manage_sponsor_leads', 'ads_manage_campaigns', 'ads_view_analytics', 'sponsor_submit_for_approval'] }),
  'social media manager': Object.freeze({ moduleAccess: ['dashboard', 'manage_news', 'media', 'viral_videos', 'seo', 'analytics'], specialRights: [] }),
  'tech support': Object.freeze({ moduleAccess: ['dashboard', 'media', 'analytics', 'compliance_reports'], specialRights: ['compliance_view'] }),
  intern: Object.freeze({ moduleAccess: ['dashboard'], specialRights: [] }),
});

function displayRoleName(name) {
  if (name === 'finance & accounts manager') return 'Finance & Accounts Manager';
  if (name === 'ads & revenue growth manager') return 'Ads & Revenue Growth Manager';
  return name.replace(/\b\w/g, (char) => char.toUpperCase());
}

function roleSlug(name) {
  return String(name || '').replace(/\s*&\s*/g, '-').replace(/\s*\/\s*/g, '-').replace(/\s+/g, '-');
}

const SYSTEM_ROLE_DEFINITIONS = Object.freeze(TEAM_ROLES.map((name, index) => {
  const access = ROLE_DEFAULT_ACCESS[name] || { moduleAccess: [], specialRights: [] };
  const displayName = displayRoleName(name);
  return Object.freeze({
    name: displayName,
    slug: roleSlug(name),
    description: `${displayName} system role`,
    sortOrder: index + 1,
    isSystemRole: true,
    isProtected: name === 'founder',
    moduleAccess: Object.freeze(access.moduleAccess.slice()),
    specialRights: Object.freeze(access.specialRights.slice()),
  });
}));

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!role) return null;
  if (role === 'copy-editor') return 'copy editor';
  if (role === 'fact-checker') return 'fact checker';
  if (role === 'video-editor') return 'video editor';
  if (role === 'live-tv-controller' || role === 'livetv controller') return 'live tv controller';
  if (role === 'social-media-manager') return 'social media manager';
  if (role === 'finance-and-accounts-manager' || role === 'finance accounts manager' || role === 'finance & accounts manager') return 'finance & accounts manager';
  if (role === 'ads revenue growth manager' || role === 'ads-and-revenue-growth-manager' || role === 'ads-revenue-growth-manager' || role === 'ads revenue manager' || role === 'ads/revenue manager' || role === 'ads-revenue-manager' || role === 'ads / revenue manager') return 'ads & revenue growth manager';
  if (role === 'tech-support') return 'tech support';
  return TEAM_ROLES.includes(role) ? role : null;
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  return TEAM_STATUSES.includes(status) ? status : null;
}

function normalizeComparableLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildCanonicalLookup(values) {
  return new Map((values || []).map((value) => [normalizeComparableLabel(value), value]));
}

const DEPARTMENT_LOOKUP = buildCanonicalLookup(TEAM_DEPARTMENTS);
const ASSIGNED_SECTION_LOOKUP = buildCanonicalLookup(TEAM_ASSIGNED_SECTIONS);
const COVERAGE_AREA_LOOKUP = buildCanonicalLookup(TEAM_COVERAGE_AREAS);

function canonicalLabel(value, lookup) {
  const key = normalizeComparableLabel(value);
  if (!key) return null;
  return lookup.get(key) || null;
}

function normalizeStringList(value, limit = 100) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const item = String(raw || '').trim();
    if (!item || item.length > 120 || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function defaultDepartmentForRole(role) {
  const normalizedRole = normalizeRole(role);
  if (!normalizedRole) return null;
  return ROLE_DEPARTMENT_DEFAULTS[normalizedRole] || null;
}

function normalizeDepartment(value, role = null) {
  const raw = value == null ? '' : String(value || '').trim();
  if (!raw) return defaultDepartmentForRole(role);
  return canonicalLabel(raw, DEPARTMENT_LOOKUP);
}

function normalizeAssignedSections(value, movedCoverageAreas = null) {
  const items = normalizeStringList(value, TEAM_ASSIGNED_SECTIONS.length + TEAM_COVERAGE_AREAS.length + 20);
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const section = canonicalLabel(item, ASSIGNED_SECTION_LOOKUP);
    if (section) {
      if (section === 'All Sections') return ['All Sections'];
      if (!seen.has(section)) {
        seen.add(section);
        out.push(section);
      }
      continue;
    }

    const coverageArea = canonicalLabel(item, COVERAGE_AREA_LOOKUP);
    if (coverageArea && Array.isArray(movedCoverageAreas)) movedCoverageAreas.push(coverageArea);
  }

  return out;
}

function normalizeCoverageAreas(value) {
  const items = normalizeStringList(value, TEAM_COVERAGE_AREAS.length + 20);
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const coverageArea = canonicalLabel(item, COVERAGE_AREA_LOOKUP);
    if (!coverageArea) continue;
    if (coverageArea === 'All Gujarat') return ['All Gujarat'];
    if (seen.has(coverageArea)) continue;
    seen.add(coverageArea);
    out.push(coverageArea);
  }

  return out;
}

function normalizeOrganizationFields(source) {
  const input = source && typeof source === 'object' ? source : {};
  const movedCoverageAreas = [];
  const assignedSections = normalizeAssignedSections(
    input.assignedSections !== undefined ? input.assignedSections : input.sections,
    movedCoverageAreas,
  );

  let coverageAreas = normalizeCoverageAreas([
    ...movedCoverageAreas,
    ...(Array.isArray(input.coverageAreas) ? input.coverageAreas : []),
  ]);

  if (assignedSections.includes('Gujarat') && coverageAreas.length === 0) {
    coverageAreas = ['All Gujarat'];
  }

  return {
    department: normalizeDepartment(input.department, input.role || input.roleName),
    assignedSections,
    coverageAreas,
    sections: assignedSections.slice(),
  };
}

function normalizeModuleAccess(value) {
  const allowed = new Set(ADMIN_MODULE_KEYS);
  return normalizeStringList(value, ADMIN_MODULE_KEYS.length).filter((key) => allowed.has(key));
}

function normalizeSpecialRights(value) {
  const allowed = new Set(SPECIAL_RIGHT_KEYS);
  return normalizeStringList(value, SPECIAL_RIGHT_KEYS.length).filter((key) => allowed.has(key));
}

function mergeUnique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function normalizePermissions(value) {
  return normalizeStringList(value, 150).filter((permission) => permission !== 'auth.view_password');
}

function isFounderRole(role) {
  return normalizeRole(role) === 'founder';
}

function isAdminRole(role) {
  return normalizeRole(role) === 'admin';
}

function isProtectedFounderUser(user) {
  if (!user) return false;
  return Boolean(user.isFounder || user.isProtected || isFounderRole(user.role));
}

function effectivePermissions(user) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return FOUNDER_PERMISSIONS.slice();

  const out = [];
  const seen = new Set();
  for (const permission of [
    ...OWN_STAFF_PERMISSIONS,
    ...(ROLE_DEFAULT_PERMISSIONS[role] || []),
    ...(Array.isArray(user?.permissions) ? user.permissions : []),
  ]) {
    const normalized = String(permission || '').trim();
    if (!normalized || normalized === 'auth.view_password' || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function legacyRightsFromPermissions(permissions) {
  const rights = [];
  for (const permission of Array.isArray(permissions) ? permissions : []) {
    const mapped = LEGACY_PERMISSION_TO_RIGHT[String(permission || '').trim()];
    if (mapped) rights.push(mapped);
  }
  return rights;
}

function legacyPermissionsFromRights(rights) {
  const permissions = [];
  for (const right of Array.isArray(rights) ? rights : []) {
    const mapped = RIGHT_TO_LEGACY_PERMISSION[String(right || '').trim()];
    if (mapped) permissions.push(mapped);
  }
  return permissions;
}

function effectiveModuleAccess(user, roleDoc) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return ADMIN_MODULE_KEYS.slice();

  const roleModules = roleDoc && Array.isArray(roleDoc.moduleAccess)
    ? roleDoc.moduleAccess
    : (ROLE_DEFAULT_ACCESS[role]?.moduleAccess || []);
  const override = Array.isArray(user?.moduleAccessOverride) ? user.moduleAccessOverride : [];
  return normalizeModuleAccess(mergeUnique([...roleModules, ...override]));
}

function effectiveSpecialRights(user, roleDoc) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return SPECIAL_RIGHT_KEYS.slice();

  const roleRights = roleDoc && Array.isArray(roleDoc.specialRights)
    ? roleDoc.specialRights
    : (ROLE_DEFAULT_ACCESS[role]?.specialRights || []);
  const override = Array.isArray(user?.specialRightsOverride) ? user.specialRightsOverride : [];
  const legacyRights = legacyRightsFromPermissions(user?.permissions);
  return normalizeSpecialRights(mergeUnique([...roleRights, ...override, ...legacyRights]));
}

function hasModuleAccess(user, moduleKey, roleDoc, safeZoneLocked = false) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (safeZoneLocked) return false;
  return effectiveModuleAccess(user, roleDoc).includes(String(moduleKey || '').trim());
}

function hasSpecialRight(user, rightKey, roleDoc, safeZoneLocked = false) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (safeZoneLocked) return false;
  return effectiveSpecialRights(user, roleDoc).includes(String(rightKey || '').trim());
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  const normalized = String(permission || '').trim();
  if (effectivePermissions(user).includes(normalized)) return true;
  const mappedRight = LEGACY_PERMISSION_TO_RIGHT[normalized];
  return mappedRight ? effectiveSpecialRights(user).includes(mappedRight) : false;
}

function safeUserDto(user) {
  const id = user && user._id ? String(user._id) : (user && user.id ? String(user.id) : null);
  const fullName = user?.fullName || user?.name || '';
  const organization = normalizeOrganizationFields(user);
  const rawDepartment = user?.department != null ? String(user.department || '').trim() : '';
  return {
    ...(id ? { _id: id, id } : {}),
    fullName,
    name: fullName,
    email: user?.email || '',
    staffId: user?.staffId || null,
    role: normalizeRole(user?.role) || user?.role || 'intern',
    department: organization.department || rawDepartment || defaultDepartmentForRole(user?.role) || null,
    sections: organization.sections,
    assignedSections: organization.assignedSections,
    coverageAreas: organization.coverageAreas,
    designation: user?.designation || null,
    roleId: user?.roleId || null,
    roleName: user?.roleName || normalizeRole(user?.role) || user?.role || 'intern',
    moduleAccessOverride: normalizeModuleAccess(user?.moduleAccessOverride),
    specialRightsOverride: normalizeSpecialRights(user?.specialRightsOverride),
    moduleAccess: effectiveModuleAccess(user),
    specialRights: effectiveSpecialRights(user),
    permissions: effectivePermissions(user),
    status: user?.status || 'pending',
    accountStatus: user?.accountStatus || (['active', 'suspended', 'locked', 'expired'].includes(String(user?.status || '').toLowerCase()) ? String(user.status).toLowerCase() : 'active'),
    onlineStatus: user?.onlineStatus || 'offline',
    mustChangePassword: Boolean(user?.mustChangePassword || user?.mustResetPassword || user?.forceReset),
    tempPasswordExpiresAt: user?.tempPasswordExpiresAt || null,
    createdBy: user?.createdBy || null,
    createdAt: user?.createdAt || null,
    updatedAt: user?.updatedAt || null,
    lastLoginAt: user?.lastLoginAt || null,
    lastLogoutAt: user?.lastLogoutAt || null,
    lastSeenAt: user?.lastSeenAt || null,
    currentSessionId: user?.currentSessionId || null,
    currentAttendanceId: user?.currentAttendanceId || null,
    currentBreakId: user?.currentBreakId || null,
    failedLoginCount: typeof user?.failedLoginCount === 'number' ? user.failedLoginCount : 0,
    lockedUntil: user?.lockedUntil || null,
    accessExpiresAt: user?.accessExpiresAt || null,
    isFounder: Boolean(user?.isFounder || isFounderRole(user?.role)),
    isProtected: Boolean(user?.isProtected || isFounderRole(user?.role)),
  };
}

function requirePasswordPolicy(password) {
  const value = String(password || '');
  if (value.length < 8) return { ok: false, message: 'Password must be at least 8 characters' };
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return { ok: false, message: 'Password must contain letters and numbers' };
  }
  return { ok: true };
}

module.exports = {
  ADMIN_MODULE_KEYS,
  AUTH_PERMISSIONS,
  FOUNDER_ONLY_MODULES,
  FOUNDER_ONLY_RIGHTS,
  FOUNDER_PERMISSIONS,
  OWN_STAFF_PERMISSIONS,
  ROLE_DEPARTMENT_DEFAULTS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_DEFAULT_ACCESS,
  SPECIAL_RIGHT_KEYS,
  TEAM_ASSIGNED_SECTIONS,
  TEAM_COVERAGE_AREAS,
  TEAM_DEPARTMENTS,
  TEAM_MANAGEMENT_PERMISSIONS,
  SYSTEM_ROLE_DEFINITIONS,
  TEAM_ROLES,
  TEAM_STATUSES,
  effectiveModuleAccess,
  effectivePermissions,
  effectiveSpecialRights,
  hasModuleAccess,
  hasPermission,
  hasSpecialRight,
  isAdminRole,
  isFounderRole,
  isProtectedFounderUser,
  legacyPermissionsFromRights,
  legacyRightsFromPermissions,
  defaultDepartmentForRole,
  normalizeAssignedSections,
  normalizeCoverageAreas,
  normalizeDepartment,
  normalizeModuleAccess,
  normalizeOrganizationFields,
  normalizePermissions,
  normalizeRole,
  normalizeSpecialRights,
  normalizeStatus,
  normalizeStringList,
  requirePasswordPolicy,
  safeUserDto,
};