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

const TEAM_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'expired', 'locked', 'archived', 'deleted', 'deleted_test']);

const STAFF_CONTROL_CENTER = Object.freeze({
  name: 'Staff Control Center',
  subtitle: 'Create staff, assign module access, control special rights, manage passwords, sessions, and staff roles — all under Founder control.',
  accountGroups: Object.freeze(['Founder Account', 'Management Staff', 'Field Network Staff', 'Staff Account / Newsroom Staff']),
  positions: Object.freeze([
    'Founder',
    'Manager',
    'HR & Admin',
    'Finance & Accounts',
    'Ads & Revenue Growth',
    'Chief Editor',
    'Tech Support',
    'Grievance Officer',
    'SEO Executive',
    'Marketing Manager',
    'Bureau Chief',
    'State Coordinator',
    'District Reporter',
    'Community Reporter Coordinator',
    'Editorial Head',
    'Copy Editor',
    'Reporter',
    'Live TV Controller',
    'Video Editor',
    'Social Media',
    'Ads Marketing',
    'Intern',
  ]),
  departments: Object.freeze([
    'Founder / Ownership',
    'Management & Operations',
    'Finance & Accounts',
    'Editorial / Newsroom',
    'Field Reporting',
    'Broadcast / Video / Live TV',
    'Growth / Revenue / Marketing',
    'Technology / Support',
    'Compliance / Grievance',
    'Intern / Trainee',
  ]),
  sections: Object.freeze([
    'Create Staff Account',
    'Staff Registry',
    'Founder Access Studio',
    'Security & Sessions',
    'Roles & Workflow',
    'Archived / Test Accounts',
  ]),
});

const DEFAULT_TASK_TEMPLATES = Object.freeze({
  'Manager': Object.freeze(['daily operations', 'team coordination', 'task follow-up', 'staff work tracking', 'department coordination', 'report to Founder']),
  'HR & Admin': Object.freeze(['staff onboarding', 'staff records', 'attendance/leave records', 'office/admin work', 'staff communication']),
  'Finance & Accounts': Object.freeze(['invoice records', 'receipts', 'expenses', 'revenue entries', 'sponsor payment status', 'monthly finance report to Founder']),
  'Ads & Revenue Growth': Object.freeze(['ad slots', 'sponsor leads', 'campaigns', 'revenue growth ideas', 'business outreach', 'partnership follow-up']),
  'Chief Editor': Object.freeze(['editorial leadership', 'newsroom standards', 'sensitive story review', 'editorial policy', 'guide editors/reporters', 'final editorial recommendation']),
  'Tech Support': Object.freeze(['login support', 'admin panel help', 'bug reporting', 'staff technical support', 'security issue reporting', 'system health checks']),
  'Grievance Officer': Object.freeze(['receive complaints', 'track grievance status', 'coordinate responses', 'prepare grievance records', 'escalate sensitive matters to Founder']),
  'SEO Executive': Object.freeze(['SEO title/meta', 'keywords', 'tags', 'article SEO checks', 'ranking improvement', 'traffic suggestions']),
  'Marketing Manager': Object.freeze(['promotion strategy', 'brand growth', 'campaign planning', 'partnerships', 'offline/online marketing', 'public awareness']),
  'Bureau Chief': Object.freeze(['manage bureau/region', 'coordinate state/district reporters', 'verify local reporting flow', 'send regional summary', 'report to Chief Editor / Founder']),
  'State Coordinator': Object.freeze(['coordinate state-level news', 'manage district updates', 'track state issues', 'coordinate reporters in state', 'send reports to newsroom']),
  'District Reporter': Object.freeze(['cover district news', 'send field reports', 'upload photos/videos', 'add sources/interviews', 'report public issues', 'send breaking alerts']),
  'Community Reporter Coordinator': Object.freeze(['handle community submissions', 'verify public tips', 'coordinate citizen reporters', 'filter fake reports', 'send valid leads to editor']),
  'Editorial Head': Object.freeze(['manage daily editorial desk', 'assign stories', 'review article flow', 'coordinate copy editor/reporter', 'send stories for approval', 'maintain content quality']),
  'Copy Editor': Object.freeze(['rewrite raw copy', 'fix grammar', 'improve headlines', 'improve article structure', 'prepare article for editor review']),
  'Reporter': Object.freeze(['write stories', 'submit reports', 'upload media', 'add sources', 'send breaking alerts', 'cover assigned topic/location']),
  'Live TV Controller': Object.freeze(['prepare live stream', 'add stream link', 'manage title/ticker', 'schedule live', 'monitor live status', 'prepare recordings/clips']),
  'Video Editor': Object.freeze(['edit video clips', 'make thumbnails', 'prepare reels/shorts', 'prepare news video packages', 'support live/video desk']),
  'Social Media': Object.freeze(['post approved content', 'write captions', 'prepare short updates', 'share breaking alerts', 'grow audience', 'track engagement']),
  'Ads Marketing': Object.freeze(['prepare ad creatives', 'support campaign promotion', 'coordinate sponsor posts', 'support ads/revenue team', 'promotional content']),
  'Intern': Object.freeze(['research help', 'draft support', 'data entry', 'basic reporting support', 'training tasks', 'assist senior staff']),
});

const TASK_CATEGORIES = Object.freeze(['Founder Task', 'Management Task', 'HR/Admin Task', 'Finance Task', 'Ads / Revenue Task', 'Marketing Task', 'Editorial Task', 'Reporting Task', 'Field Network Task', 'Technical Task', 'Grievance / Compliance Task', 'SEO Task', 'Live TV Task', 'Video Task', 'Social Media Task', 'Intern Task']);
const TASK_LEVELS = Object.freeze(['Founder Level', 'Management Level', 'Department Level', 'Staff Level', 'Field Level']);
const TASK_STATUSES = Object.freeze(['Assigned', 'In Progress', 'Submitted', 'Under Review', 'Completed', 'Closed', 'Overdue', 'Cancelled']);

const TEAM_DEPARTMENTS = Object.freeze([
  'Founder / Ownership',
  'Management & Operations',
  'Finance & Accounts',
  'Editorial / Newsroom',
  'Field Reporting',
  'Broadcast / Video / Live TV',
  'Growth / Revenue / Marketing',
  'Technology / Support',
  'Compliance / Grievance',
  'Intern / Trainee',
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
  admin: 'Management & Operations',
  'finance & accounts manager': 'Finance & Accounts',
  manager: 'Management & Operations',
  editor: 'Editorial / Newsroom',
  'copy editor': 'Editorial / Newsroom',
  'fact checker': 'Compliance / Grievance',
  reporter: 'Field Reporting',
  'live tv controller': 'Broadcast / Video / Live TV',
  'video editor': 'Broadcast / Video / Live TV',
  'ads & revenue growth manager': 'Growth / Revenue / Marketing',
  'social media manager': 'Growth / Revenue / Marketing',
  'tech support': 'Technology / Support',
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
  'dpdp_compliance',
  'ai_engine',
  'settings',
  'safe_zone',
  'team_management',
  'staff_tasks',
  'audit_logs',
]);

const TASK_RIGHT_KEYS = Object.freeze([
  'task_create',
  'task_assign',
  'task_edit',
  'task_update_status',
  'task_complete',
  'task_close',
  'task_delete',
  'task_view_team',
  'task_manage_department',
  'task_comment',
  'task_escalate',
]);

const ACCOUNT_CONTROL_RIGHT_KEYS = Object.freeze([
  'staff_view_details',
  'staff_edit_basic',
  'staff_change_email',
  'staff_generate_temp_password',
  'staff_reset_password',
  'staff_force_password_change',
  'staff_logout_devices',
  'staff_extend_access',
  'staff_reactivate',
  'staff_suspend',
  'staff_lock',
  'staff_archive',
  'staff_delete_permanently',
  'founder_account_control',
  'grant_account_control_rights',
  'revoke_account_control_rights',
]);

const FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS = Object.freeze([
  'staff_delete_permanently',
  'founder_account_control',
  'grant_account_control_rights',
  'revoke_account_control_rights',
]);

const SPECIAL_RIGHT_KEYS = Object.freeze([
  'news_create',
  'news_publish',
  'news_delete',
  'news_approve',
  'news_reject_send_back',
  'news_reject',
  'news_send_back',
  'news_pin_breaking',
  'news_submit',
  'news_edit',
  'news_schedule',
  'news_restore',
  'live_tv_prepare',
  'live_tv_edit_title',
  'live_tv_add_stream_link',
  'live_tv_update_ticker',
  'live_tv_schedule',
  'live_tv_start',
  'live_tv_stop',
  'live_tv_emergency_stop',
  'ads_view',
  'ads_manage_slots',
  'ads_manage_sponsor_leads',
  'ads_manage_campaigns',
  'ads_view_analytics',
  'media_kit_view',
  'media_kit_manage',
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
  'audit_log_view',
  'staff_create',
  'staff_view_details',
  'staff_edit_basic',
  'staff_change_email',
  'staff_edit',
  'staff_suspend',
  'staff_lock',
  'staff_reactivate',
  'staff_reset_password',
  'staff_generate_temp_password',
  'staff_email_change',
  'staff_archive',
  'staff_delete_permanently',
  'staff_force_password_change',
  'staff_logout_devices',
  'staff_extend_access',
  'role_create',
  'role_edit',
  'role_delete',
  'role_delete_system',
  'settings_change',
  'sensitive_settings_change',
  'safe_zone_access',
  'ai_engine_control',
  'emergency_lock',
  'founder_account_control',
  'grant_founder_only_rights',
  'grant_account_control_rights',
  'revoke_account_control_rights',
  'delete_founder_blocked',
  'finance_final_approval',
  'bank_payment_settings_change',
  'seo.run_audit',
  'seo.view_audits',
  'seo.manage_redirects',
  'seo.delete_redirects',
  'seo.view_sitemaps',
  'seo.check_sitemaps',
  'seo.view_meta_analysis',
  'view_marketing_performance',
  'view_campaign_performance',
  'view_promotion_performance',
  'view_growth_performance',
  'view_renewals',
  'manage_renewals',
  'create_campaign_report',
  'view_marketing_deal_values',
  'approve_campaign_report',
  'export_marketing_performance',
  'manage_renewal_settings',
  'delete_campaign_report',
  'delete_renewal_record',
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
  'role_delete_system',
  'sensitive_settings_change',
  'emergency_lock',
  'founder_account_control',
  'grant_founder_only_rights',
  'grant_account_control_rights',
  'revoke_account_control_rights',
  'delete_founder_blocked',
  'staff_delete_permanently',
  'live_tv_emergency_stop',
  'ai_engine_control',
  'finance_final_approval',
  'finance_delete_record',
  'bank_payment_settings_change',
]);

// Access states surfaced to the Founder Access Studio UI / effective-access API.
const ACCESS_STATES = Object.freeze(['enabled', 'disabled', 'temporary', 'founder_only', 'locked']);

// Live TV special rights (used by Founder Access Studio > Live TV Rights).
const LIVE_TV_RIGHT_KEYS = Object.freeze([
  'live_tv_prepare',
  'live_tv_edit_title',
  'live_tv_add_stream_link',
  'live_tv_update_ticker',
  'live_tv_schedule',
  'live_tv_start',
  'live_tv_stop',
  'live_tv_emergency_stop',
]);

// Grouped special rights for the Founder Access Studio UI.
const SPECIAL_RIGHT_GROUPS = Object.freeze([
  Object.freeze({ key: 'newsroom', label: 'Newsroom Rights', rights: Object.freeze(['news_create', 'news_edit', 'news_submit', 'news_approve', 'news_reject', 'news_publish', 'news_schedule', 'news_delete', 'news_pin_breaking', 'news_restore']) }),
  Object.freeze({ key: 'live_tv', label: 'Live TV Rights', rights: LIVE_TV_RIGHT_KEYS }),
  Object.freeze({ key: 'ads', label: 'Ads Rights', rights: Object.freeze(['ads_view', 'ads_manage_slots', 'ads_manage_sponsor_leads', 'ads_manage_campaigns', 'ads_view_analytics', 'media_kit_view', 'media_kit_manage', 'sponsor_submit_for_approval']) }),
  Object.freeze({ key: 'finance', label: 'Finance Rights', rights: Object.freeze(['finance_view', 'finance_create_invoice', 'finance_update_invoice_status', 'finance_add_revenue_entry', 'finance_add_expense_entry', 'finance_upload_receipt', 'finance_prepare_monthly_report', 'finance_export_summary', 'finance_view_sponsor_payment_status', 'finance_approve_payment', 'finance_delete_record', 'finance_change_bank_details', 'finance_change_payment_gateway', 'finance_approve_withdrawal', 'finance_final_report_approval']) }),
  Object.freeze({ key: 'staff_account_control', label: 'Staff Account Control Rights', rights: ACCOUNT_CONTROL_RIGHT_KEYS }),
  Object.freeze({ key: 'task', label: 'Task Rights', rights: TASK_RIGHT_KEYS }),
  Object.freeze({ key: 'security', label: 'Security Rights', rights: Object.freeze(['safe_zone_access', 'emergency_lock', 'founder_account_control']) }),
  Object.freeze({ key: 'settings', label: 'Settings Rights', rights: Object.freeze(['settings_change', 'sensitive_settings_change']) }),
  Object.freeze({ key: 'seo', label: 'SEO Rights', rights: Object.freeze(['seo.run_audit', 'seo.view_audits', 'seo.manage_redirects', 'seo.delete_redirects', 'seo.view_sitemaps', 'seo.check_sitemaps', 'seo.view_meta_analysis']) }),
  Object.freeze({ key: 'marketing', label: 'Marketing Rights', rights: Object.freeze(['view_marketing_performance', 'view_campaign_performance', 'view_promotion_performance', 'view_growth_performance', 'view_renewals', 'manage_renewals', 'create_campaign_report', 'view_marketing_deal_values', 'approve_campaign_report', 'export_marketing_performance', 'manage_renewal_settings', 'delete_campaign_report', 'delete_renewal_record']) }),
  Object.freeze({ key: 'ai_system', label: 'AI/System Rights', rights: Object.freeze(['ai_engine_control']) }),
  Object.freeze({ key: 'compliance', label: 'Compliance Rights', rights: Object.freeze(['compliance_view', 'audit_log_view']) }),
]);

const AUTH_PERMISSIONS = Object.freeze([
  'auth.create_user',
  'auth.reset_password',
  'auth.generate_temp_password',
  'auth.force_password_change',
  'auth.change_staff_email',
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
  'auth.generate_temp_password': 'staff_generate_temp_password',
  'auth.force_password_change': 'staff_reset_password',
  'auth.change_staff_email': 'staff_email_change',
  'auth.suspend_user': 'staff_suspend',
  'auth.lock_user': 'staff_lock',
  'auth.logout_user_sessions': 'staff_suspend',
  'auth.view_login_activity': 'audit_log_view',
  'team.manage': 'staff_create',
  'audit.read': 'audit_log_view',
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
  staff_lock: 'auth.lock_user',
  staff_generate_temp_password: 'auth.generate_temp_password',
  staff_reset_password: 'auth.reset_password',
  staff_email_change: 'auth.change_staff_email',
  role_create: 'team.manage',
  role_edit: 'team.manage',
  role_delete: 'team.manage',
  compliance_view: 'auth.view_login_activity',
  audit_log_view: 'audit.read',
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
  'live tv controller': Object.freeze({ moduleAccess: ['dashboard', 'broadcast_center', 'media', 'live_tv'], specialRights: ['live_tv_prepare', 'live_tv_edit_title', 'live_tv_add_stream_link', 'live_tv_update_ticker', 'live_tv_schedule', 'live_tv_stop'] }),
  'video editor': Object.freeze({ moduleAccess: ['dashboard', 'media', 'viral_videos', 'broadcast_center'], specialRights: [] }),
  'ads & revenue growth manager': Object.freeze({ moduleAccess: ['dashboard', 'ads_manager', 'analytics'], specialRights: ['ads_view', 'ads_manage_slots', 'ads_manage_sponsor_leads', 'ads_manage_campaigns', 'ads_view_analytics', 'media_kit_view', 'sponsor_submit_for_approval'] }),
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
const DEPARTMENT_ALIASES = new Map([
  ['administration', 'Management & Operations'],
  ['operations / newsroom management', 'Management & Operations'],
  ['copy desk / editorial desk', 'Editorial / Newsroom'],
  ['fact check / compliance', 'Compliance / Grievance'],
  ['field reporting / newsroom', 'Field Reporting'],
  ['broadcast / live tv', 'Broadcast / Video / Live TV'],
  ['video production', 'Broadcast / Video / Live TV'],
  ['growth / monetization', 'Growth / Revenue / Marketing'],
  ['social media', 'Growth / Revenue / Marketing'],
  ['technology / it', 'Technology / Support'],
  ['training / internship', 'Training / Internship'],
]);
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
  return canonicalLabel(raw, DEPARTMENT_LOOKUP) || DEPARTMENT_ALIASES.get(normalizeComparableLabel(raw)) || null;
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

function normalizeAccessKeyInput(value, allowedKeys, limit = 100) {
  if (Array.isArray(value)) return normalizeStringList(value, limit).filter((key) => allowedKeys.has(key));
  if (!value || typeof value !== 'object') return [];
  const out = [];
  for (const [key, state] of Object.entries(value)) {
    if (!allowedKeys.has(key)) continue;
    const normalizedState = String(state || '').trim().toLowerCase();
    const enabled = state === true || state === 1 || ['enabled', 'temporary', 'on', 'true', 'yes'].includes(normalizedState);
    if (!enabled) continue;
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeModuleAccess(value) {
  const allowed = new Set(ADMIN_MODULE_KEYS);
  return normalizeAccessKeyInput(value, allowed, ADMIN_MODULE_KEYS.length);
}

function normalizeSpecialRights(value) {
  const allowed = new Set(SPECIAL_RIGHT_KEYS);
  return normalizeAccessKeyInput(value, allowed, SPECIAL_RIGHT_KEYS.length);
}

function normalizeTaskRights(value) {
  const allowed = new Set(TASK_RIGHT_KEYS);
  return normalizeAccessKeyInput(value, allowed, TASK_RIGHT_KEYS.length);
}

function normalizeAccountControlRights(value) {
  const allowed = new Set(ACCOUNT_CONTROL_RIGHT_KEYS);
  return normalizeAccessKeyInput(value, allowed, ACCOUNT_CONTROL_RIGHT_KEYS.length);
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

function isTemporaryAccessActive(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return false;
  const expiresAt = entry.expiresAt ? new Date(entry.expiresAt).getTime() : null;
  if (expiresAt !== null && (Number.isNaN(expiresAt) || expiresAt <= now)) return false;
  return true;
}

function activeTemporaryAccess(user, now = Date.now()) {
  const list = Array.isArray(user?.temporaryAccess) ? user.temporaryAccess : [];
  return list.filter((entry) => isTemporaryAccessActive(entry, now));
}

// Build added/removed key sets from active temporary access entries for a given field.
function temporaryAccessSets(user, field, now = Date.now()) {
  const added = [];
  const removed = new Set();
  for (const entry of activeTemporaryAccess(user, now)) {
    const key = String(entry?.[field] || '').trim();
    if (!key) continue;
    if (entry.enabled === false) removed.add(key);
    else added.push(key);
  }
  return { added, removed };
}

function effectiveModuleAccess(user, roleDoc) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return ADMIN_MODULE_KEYS.slice();

  const roleModules = roleDoc && Array.isArray(roleDoc.moduleAccess)
    ? roleDoc.moduleAccess
    : (ROLE_DEFAULT_ACCESS[role]?.moduleAccess || []);
  const override = Array.isArray(user?.moduleAccessOverride) ? user.moduleAccessOverride : [];
  const { added, removed } = temporaryAccessSets(user, 'moduleKey');
  const base = mergeUnique([...roleModules, ...override, ...added]);
  return normalizeModuleAccess(base.filter((key) => !removed.has(key)));
}

function effectiveSpecialRights(user, roleDoc) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return SPECIAL_RIGHT_KEYS.slice();

  const roleRights = roleDoc && Array.isArray(roleDoc.specialRights)
    ? roleDoc.specialRights
    : (ROLE_DEFAULT_ACCESS[role]?.specialRights || []);
  const override = Array.isArray(user?.specialRightsOverride) ? user.specialRightsOverride : [];
  const legacyRights = legacyRightsFromPermissions(user?.permissions);
  const { added, removed } = temporaryAccessSets(user, 'rightKey');
  const base = mergeUnique([...roleRights, ...override, ...legacyRights, ...added]);
  return normalizeSpecialRights(base.filter((key) => !removed.has(key)));
}

function effectiveTaskRights(user) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return TASK_RIGHT_KEYS.slice();
  return normalizeTaskRights(user?.taskRightsOverride);
}

function effectiveAccountControlRights(user) {
  const role = normalizeRole(user && user.role);
  if (role === 'founder' || user?.isFounder) return ACCOUNT_CONTROL_RIGHT_KEYS.slice();
  return normalizeAccountControlRights(user?.accountControlRightsOverride).filter((key) => !FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS.includes(key));
}

function isUserAccessEligible(user, now = new Date()) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  const accountStatus = String(user.accountStatus || user.status || 'active').toLowerCase();
  const userStatus = String(user.status || accountStatus || 'active').toLowerCase();
  if (user.loginAllowed === false) return false;
  if (['suspended', 'locked', 'expired', 'archived', 'deleted', 'deleted_test'].includes(accountStatus)) return false;
  if (['suspended', 'locked', 'expired', 'archived', 'deleted', 'deleted_test'].includes(userStatus)) return false;
  if (user.isDeleted || user.deletedAt) return false;
  if (user.lockedUntil && new Date(user.lockedUntil) > now) return false;
  if (user.accessExpiresAt && new Date(user.accessExpiresAt) <= now) return false;
  return true;
}

function hasModuleAccess(user, moduleKey, roleDoc, safeZoneLocked = false) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (!isUserAccessEligible(user)) return false;
  if (safeZoneLocked) return false;
  return effectiveModuleAccess(user, roleDoc).includes(String(moduleKey || '').trim());
}

function hasSpecialRight(user, rightKey, roleDoc, safeZoneLocked = false) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (!isUserAccessEligible(user)) return false;
  if (safeZoneLocked) return false;
  return effectiveSpecialRights(user, roleDoc).includes(String(rightKey || '').trim());
}

function hasTaskRight(user, taskRightKey, roleDoc, safeZoneLocked = false) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (!isUserAccessEligible(user)) return false;
  if (safeZoneLocked) return false;
  return effectiveTaskRights(user, roleDoc).includes(String(taskRightKey || '').trim());
}

function hasAccountControlRight(user, accountRightKey, roleDoc, safeZoneLocked = false) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  if (!isUserAccessEligible(user)) return false;
  if (safeZoneLocked) return false;
  return effectiveAccountControlRights(user, roleDoc).includes(String(accountRightKey || '').trim());
}

function hasPermission(user, permission) {
  if (!user) return false;
  if (isFounderRole(user.role) || user.isFounder) return true;
  const normalized = String(permission || '').trim();
  if (effectivePermissions(user).includes(normalized)) return true;
  const mappedRight = LEGACY_PERMISSION_TO_RIGHT[normalized];
  return mappedRight ? effectiveSpecialRights(user).includes(mappedRight) : false;
}

function normalizeTemporaryAccessList(value) {
  if (!Array.isArray(value)) return [];
  const moduleSet = new Set(ADMIN_MODULE_KEYS);
  const rightSet = new Set(SPECIAL_RIGHT_KEYS);
  const out = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const moduleKey = raw.moduleKey && moduleSet.has(String(raw.moduleKey).trim()) ? String(raw.moduleKey).trim() : null;
    const rightKey = raw.rightKey && rightSet.has(String(raw.rightKey).trim()) ? String(raw.rightKey).trim() : null;
    if (!moduleKey && !rightKey) continue;
    out.push({
      _id: raw._id ? String(raw._id) : null,
      moduleKey,
      rightKey,
      enabled: raw.enabled !== false,
      expiresAt: raw.expiresAt || null,
      reason: raw.reason ? String(raw.reason).slice(0, 500) : null,
      grantedBy: raw.grantedBy ? String(raw.grantedBy) : null,
      grantedAt: raw.grantedAt || null,
    });
  }
  return out;
}

// Resolve the access state (enabled/disabled/locked/temporary/founder_only) for a single key.
function resolveAccessState(key, { isFounder, founderOnlySet, baseSet, temporaryAdded, temporaryRemoved, safeZoneLocked, accountLocked }) {
  if (isFounder) return 'enabled';
  if (founderOnlySet.has(key)) return 'founder_only';
  if (safeZoneLocked || accountLocked) return 'locked';
  if (temporaryRemoved.has(key)) return 'disabled';
  if (temporaryAdded.has(key) && !baseSet.has(key)) return 'temporary';
  return baseSet.has(key) ? 'enabled' : 'disabled';
}

// Detailed effective access used by the Founder Access Studio effective-access API.
function computeEffectiveAccess(user, roleDoc, safeZoneLocked = false) {
  const isFounder = Boolean(user?.isFounder || isFounderRole(user?.role));
  const role = normalizeRole(user && user.role);
  const roleModules = roleDoc && Array.isArray(roleDoc.moduleAccess)
    ? roleDoc.moduleAccess
    : (ROLE_DEFAULT_ACCESS[role]?.moduleAccess || []);
  const roleRights = roleDoc && Array.isArray(roleDoc.specialRights)
    ? roleDoc.specialRights
    : (ROLE_DEFAULT_ACCESS[role]?.specialRights || []);
  const moduleBase = new Set(normalizeModuleAccess(mergeUnique([...roleModules, ...(Array.isArray(user?.moduleAccessOverride) ? user.moduleAccessOverride : [])])));
  const rightBase = new Set(normalizeSpecialRights(mergeUnique([...roleRights, ...(Array.isArray(user?.specialRightsOverride) ? user.specialRightsOverride : []), ...legacyRightsFromPermissions(user?.permissions)])));
  const moduleTemp = temporaryAccessSets(user, 'moduleKey');
  const rightTemp = temporaryAccessSets(user, 'rightKey');
  const founderOnlyModuleSet = new Set(FOUNDER_ONLY_MODULES);
  const founderOnlyRightSet = new Set(FOUNDER_ONLY_RIGHTS);
  const accessEligible = isUserAccessEligible(user);

  const modules = ADMIN_MODULE_KEYS.map((key) => ({
    key,
    state: resolveAccessState(key, {
      isFounder,
      founderOnlySet: founderOnlyModuleSet,
      baseSet: moduleBase,
      temporaryAdded: new Set(moduleTemp.added),
      temporaryRemoved: moduleTemp.removed,
      safeZoneLocked,
      accountLocked: !accessEligible,
    }),
    allowed: isFounder || hasModuleAccess(user, key, roleDoc, safeZoneLocked),
    founderOnly: founderOnlyModuleSet.has(key),
  }));

  const rights = SPECIAL_RIGHT_KEYS.map((key) => ({
    key,
    state: resolveAccessState(key, {
      isFounder,
      founderOnlySet: founderOnlyRightSet,
      baseSet: rightBase,
      temporaryAdded: new Set(rightTemp.added),
      temporaryRemoved: rightTemp.removed,
      safeZoneLocked,
      accountLocked: !accessEligible,
    }),
    allowed: isFounder || hasSpecialRight(user, key, roleDoc, safeZoneLocked),
    founderOnly: founderOnlyRightSet.has(key),
  }));

  return {
    isFounder,
    role: role || user?.role || null,
    accountStatus: user?.accountStatus || user?.status || 'active',
    accessExpiresAt: user?.accessExpiresAt || null,
    safeZoneLocked: Boolean(safeZoneLocked),
    accessEligible,
    modules,
    specialRights: rights,
    taskRights: TASK_RIGHT_KEYS.map((key) => ({ key, allowed: isFounder || hasTaskRight(user, key, roleDoc, safeZoneLocked), founderOnly: false })),
    accountControlRights: ACCOUNT_CONTROL_RIGHT_KEYS.map((key) => ({ key, allowed: isFounder || hasAccountControlRight(user, key, roleDoc, safeZoneLocked), founderOnly: FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS.includes(key) })),
    moduleAccess: effectiveModuleAccess(user, roleDoc),
    effectiveSpecialRights: effectiveSpecialRights(user, roleDoc),
    effectiveTaskRights: effectiveTaskRights(user, roleDoc),
    effectiveAccountControlRights: effectiveAccountControlRights(user, roleDoc),
    temporaryAccess: normalizeTemporaryAccessList(user?.temporaryAccess),
  };
}

// Aggregated Roles & Workflow payload for GET /team/roles-workflow.
function buildRolesWorkflow(roleDocs = []) {
  const docs = Array.isArray(roleDocs) ? roleDocs : [];
  const systemRoles = SYSTEM_ROLE_DEFINITIONS.map((role) => ({
    name: role.name,
    slug: role.slug,
    description: role.description,
    sortOrder: role.sortOrder,
    isSystemRole: true,
    isProtected: role.isProtected,
    moduleAccess: role.moduleAccess.slice(),
    specialRights: role.specialRights.slice(),
  }));
  const customRoles = docs
    .filter((role) => role && !role.isSystemRole && role.slug !== 'founder')
    .map((role) => ({
      _id: role._id ? String(role._id) : null,
      name: role.name,
      slug: role.slug,
      description: role.description || '',
      sortOrder: typeof role.sortOrder === 'number' ? role.sortOrder : 100,
      isSystemRole: false,
      isProtected: Boolean(role.isProtected),
      moduleAccess: normalizeModuleAccess(role.moduleAccess),
      specialRights: normalizeSpecialRights(role.specialRights),
    }));

  const roleOverview = systemRoles.map((role) => ({
    name: role.name,
    slug: role.slug,
    moduleCount: role.moduleAccess.length,
    rightCount: role.specialRights.length,
    isProtected: role.isProtected,
  }));

  const accessMatrix = {
    modules: ADMIN_MODULE_KEYS.slice(),
    specialRights: SPECIAL_RIGHT_KEYS.slice(),
    founderOnlyModules: FOUNDER_ONLY_MODULES.slice(),
    founderOnlyRights: FOUNDER_ONLY_RIGHTS.slice(),
    specialRightGroups: SPECIAL_RIGHT_GROUPS.map((group) => ({ key: group.key, label: group.label, rights: group.rights.slice() })),
    roles: systemRoles.map((role) => ({ slug: role.slug, name: role.name, moduleAccess: role.moduleAccess, specialRights: role.specialRights })),
  };

  const editorialWorkflow = {
    label: 'Editorial Workflow',
    stages: ['draft', 'submitted_for_review', 'fact_check', 'copy_edit', 'approved', 'published', 'sent_back'],
    rights: ['news_submit', 'news_edit', 'news_publish', 'news_approve', 'news_reject_send_back', 'news_pin_breaking', 'news_delete'],
    defaultRoles: ['reporter', 'copy-editor', 'fact-checker', 'editor', 'manager', 'admin'],
  };

  const broadcastWorkflow = {
    label: 'Broadcast Workflow',
    stages: ['prepare', 'edit_title', 'add_stream_link', 'update_ticker', 'schedule', 'start', 'stop', 'emergency_stop'],
    rights: LIVE_TV_RIGHT_KEYS.slice(),
    defaultRoles: ['live-tv-controller', 'video-editor', 'admin'],
    founderOnlyRights: ['live_tv_start', 'live_tv_emergency_stop'],
  };

  return {
    staffControlCenter: { ...STAFF_CONTROL_CENTER, departments: STAFF_CONTROL_CENTER.departments.slice(), sections: STAFF_CONTROL_CENTER.sections.slice() },
    systemRoles,
    customRoles,
    defaultRoleTemplates: systemRoles,
    roleOverview,
    accessMatrix,
    editorialWorkflow,
    broadcastWorkflow,
  };
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
    recoveryEmail: user?.recoveryEmail || null,
    staffId: user?.staffId || null,
    staffIdGeneratedAt: user?.staffIdGeneratedAt || null,
    staffIdLocked: Boolean(user?.staffIdLocked),
    role: normalizeRole(user?.role) || user?.role || 'intern',
    accountGroup: user?.accountGroup || null,
    position: user?.position || null,
    department: organization.department || rawDepartment || defaultDepartmentForRole(user?.role) || null,
    officialTitle: user?.officialTitle || user?.designation || null,
    responsibility: user?.responsibility || null,
    sections: organization.sections,
    assignedSections: organization.assignedSections,
    coverageAreas: organization.coverageAreas,
    coverageArea: organization.coverageAreas.length === 1 ? organization.coverageAreas[0] : organization.coverageAreas,
    designation: user?.designation || null,
    reportingManager: user?.reportingManager || null,
    employmentType: user?.employmentType || null,
    defaultTasks: normalizeStringList(user?.defaultTasks, 100),
    customTasks: normalizeStringList(user?.customTasks, 100),
    roleId: user?.roleId || null,
    roleName: user?.roleName || normalizeRole(user?.role) || user?.role || 'intern',
    moduleAccessOverride: normalizeModuleAccess(user?.moduleAccessOverride),
    specialRightsOverride: normalizeSpecialRights(user?.specialRightsOverride),
    taskRightsOverride: normalizeTaskRights(user?.taskRightsOverride),
    accountControlRightsOverride: normalizeAccountControlRights(user?.accountControlRightsOverride),
    moduleAccess: effectiveModuleAccess(user),
    specialRights: effectiveSpecialRights(user),
    taskRights: effectiveTaskRights(user),
    accountControlRights: effectiveAccountControlRights(user),
    permissions: effectivePermissions(user),
    temporaryAccess: normalizeTemporaryAccessList(user?.temporaryAccess),
    status: user?.status || 'pending',
    accountStatus: user?.accountStatus || (['active', 'suspended', 'locked', 'expired', 'archived', 'deleted', 'deleted_test'].includes(String(user?.status || '').toLowerCase()) ? String(user.status).toLowerCase() : 'active'),
    isTestAccount: Boolean(user?.isTestAccount),
    testAccountReason: user?.testAccountReason || null,
    testAccountMarkedAt: user?.testAccountMarkedAt || null,
    testAccountMarkedBy: user?.testAccountMarkedBy || null,
    isArchived: Boolean(user?.isArchived || String(user?.accountStatus || user?.status || '').toLowerCase() === 'archived'),
    archivedAt: user?.archivedAt || null,
    archivedBy: user?.archivedBy || null,
    isDeleted: Boolean(user?.isDeleted || user?.deletedAt || ['deleted', 'deleted_test'].includes(String(user?.accountStatus || user?.status || '').toLowerCase())),
    deletedAt: user?.deletedAt || null,
    deletedBy: user?.deletedBy || null,
    deleteReason: user?.deleteReason || null,
    onlineStatus: user?.onlineStatus || 'offline',
    sessionStatus: user?.sessionStatus || (user?.currentSessionId ? 'active' : 'logged_out'),
    loginAllowed: user?.loginAllowed !== false,
    mustChangePassword: Boolean(user?.mustChangePassword || user?.mustResetPassword || user?.forceReset),
    forcePasswordChange: Boolean(user?.mustChangePassword || user?.mustResetPassword || user?.forceReset),
    passwordStatus: (user?.mustChangePassword || user?.mustResetPassword || user?.forceReset) ? 'force_change_required' : 'set',
    tempPasswordExpiresAt: user?.tempPasswordExpiresAt || null,
    createdBy: user?.createdBy || null,
    createdAt: user?.createdAt || null,
    updatedBy: user?.updatedBy || null,
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
    accountExpiresAt: user?.accessExpiresAt || null,
    noExpiry: Boolean(user?.noExpiry || (Boolean(user?.isFounder || isFounderRole(user?.role)) && !user?.accessExpiresAt) || user?.accessExpiresAt == null),
    suspendedAt: user?.suspendedAt || null,
    lockedAt: user?.lockedAt || null,
    archivedAt: user?.archivedAt || null,
    reactivatedAt: user?.reactivatedAt || null,
    activeSessionCount: typeof user?.activeSessionCount === 'number' ? user.activeSessionCount : (user?.currentSessionId ? 1 : 0),
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
  ACCOUNT_CONTROL_RIGHT_KEYS,
  ADMIN_MODULE_KEYS,
  ACCESS_STATES,
  AUTH_PERMISSIONS,
  DEFAULT_TASK_TEMPLATES,
  FOUNDER_ONLY_ACCOUNT_CONTROL_RIGHTS,
  FOUNDER_ONLY_MODULES,
  FOUNDER_ONLY_RIGHTS,
  FOUNDER_PERMISSIONS,
  LIVE_TV_RIGHT_KEYS,
  OWN_STAFF_PERMISSIONS,
  ROLE_DEPARTMENT_DEFAULTS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLE_DEFAULT_ACCESS,
  SPECIAL_RIGHT_GROUPS,
  SPECIAL_RIGHT_KEYS,
  STAFF_CONTROL_CENTER,
  TASK_CATEGORIES,
  TASK_LEVELS,
  TASK_RIGHT_KEYS,
  TASK_STATUSES,
  TEAM_ASSIGNED_SECTIONS,
  TEAM_COVERAGE_AREAS,
  TEAM_DEPARTMENTS,
  TEAM_MANAGEMENT_PERMISSIONS,
  SYSTEM_ROLE_DEFINITIONS,
  TEAM_ROLES,
  TEAM_STATUSES,
  activeTemporaryAccess,
  buildRolesWorkflow,
  computeEffectiveAccess,
  effectiveModuleAccess,
  effectiveAccountControlRights,
  effectivePermissions,
  effectiveSpecialRights,
  effectiveTaskRights,
  hasAccountControlRight,
  hasModuleAccess,
  hasPermission,
  hasSpecialRight,
  hasTaskRight,
  isAdminRole,
  isFounderRole,
  isProtectedFounderUser,
  isTemporaryAccessActive,
  legacyPermissionsFromRights,
  legacyRightsFromPermissions,
  defaultDepartmentForRole,
  normalizeAssignedSections,
  normalizeCoverageAreas,
  normalizeDepartment,
  normalizeAccountControlRights,
  normalizeModuleAccess,
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
};