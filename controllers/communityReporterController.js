const mongoose = require('mongoose');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const ReporterProfile = require('../models/ReporterProfile');
const ReporterContactMethod = require('../models/ReporterContactMethod');
const ReporterBeat = require('../models/ReporterBeat');
const ReporterCoverage = require('../models/ReporterCoverage');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const ReporterTask = require('../models/ReporterTask');
const ReporterActivityLog = require('../models/ReporterActivityLog');
const News = require('../models/News');
const Article = require('../models/Article');
const { logAudit } = require('../lib/audit');
const { normalizeEmail } = require('../lib/normalizeEmail');
let CommunityStory = null;
try { CommunityStory = require('../models/CommunityStory'); } catch (_) { /* optional model */ }
const CommunitySubmissionModel = require('../models/CommunitySubmission');
const { upsertReporterContact } = require('../services/reporterContactService');
const {
  findReporterContactByIdentifier,
  deriveReporterStatsFromSubmissionsByEmail,
} = require('../services/reporterLookup.service');
const {
  buildCommunitySubmissionAdminFilter,
  getSubmissionDeskMetadata,
} = require('../services/communitySubmissionWorkflow');

function _isMongoReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

function _isValidObjectId(id) {
  return !!id && mongoose.isValidObjectId(String(id));
}

function _actorLabel(req) {
  const admin = req && req.admin ? req.admin : null;
  return {
    id: admin && admin.id ? String(admin.id) : null,
    email: admin && admin.email ? String(admin.email) : null,
    role: admin && admin.role ? String(admin.role) : null,
  };
}

function _parseBool(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function _normalizeEmail(value) {
  const e = normalizeEmail(value);
  return e || null;
}

function _normalizePhone(value) {
  const p = String(value || '').trim();
  return p || null;
}

function _normalizePhoneValue(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, '');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (/^0+$/.test(digits)) return null;
  return trimmed;
}

function _normalizeKnownPhoneValue(value) {
  const normalized = _normalizePhoneValue(value);
  if (normalized) return normalized;
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  const hasMask = /[xX*]/.test(raw);
  if (hasMask && digits.length >= 2) return raw.replace(/\s+/g, '');
  return null;
}

function _firstNonEmptyString(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function _toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function _toIsoOrNull(value) {
  const date = _toDateOrNull(value);
  return date ? date.toISOString() : null;
}

function _normalizeStatusToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function _normalizeLocationText(value) {
  const text = _firstNonEmptyString(value);
  if (!text) return null;
  const token = _normalizeStatusToken(text);
  if (['na', 'n_a', 'n/a', 'null', 'undefined', 'unknown'].includes(token)) return null;
  return text;
}

function _normalizeBeatLabel(value) {
  return _firstNonEmptyString(value);
}

function _normalizeAreaType(value) {
  const token = _normalizeStatusToken(value);
  return token || null;
}

function _normalizeVerificationForDirectory(value) {
  const token = _normalizeStatusToken(value);
  if (!token) return null;
  if (['verified', 'verified_journalist', 'journalist_verified'].includes(token)) return 'verified';
  if (['pending', 'journalist_pending'].includes(token)) return 'pending';
  if (token === 'limited') return 'limited';
  if (['revoked', 'restricted'].includes(token)) return 'revoked';
  if (['community_default', 'unverified', 'new', 'contacted', 'active_contributor', 'trusted_local'].includes(token)) return 'community_default';
  return null;
}

function _normalizeVerificationInput(value) {
  const normalized = _normalizeVerificationForDirectory(value);
  return normalized || null;
}

function _normalizeReporterTypeForDirectory(value) {
  const token = _normalizeStatusToken(value);
  if (!token) return null;
  if (['journalist', 'professional'].includes(token)) return 'journalist';
  if (token === 'community') return 'community';
  return null;
}

function _normalizeDirectoryStatus(value) {
  const token = _normalizeStatusToken(value);
  if (!token) return null;
  if (['hidden', 'hide', 'soft_deleted', 'removed_from_view'].includes(token)) return 'archived';
  if (['banned', 'archived', 'deleted', 'removed'].includes(token)) return 'archived';
  if (['blocked', 'suspended', 'watchlist', 'revoked'].includes(token)) return 'blocked';
  if (['active', 'verified', 'approved', 'community_default', 'pending', 'new'].includes(token)) return 'active';
  return null;
}

function _isArchivedLikeReporterStatus(value) {
  return _normalizeDirectoryStatus(value) === 'archived';
}

function _hasPermanentDeleteConfirmation(req) {
  if (_parseBool(req?.query?.confirm) === true) return true;
  if (_parseBool(req?.body?.confirm) === true) return true;
  if (_parseBool(req?.body?.confirmed) === true) return true;
  const confirmationText = _firstNonEmptyString(req?.body?.confirmation, req?.body?.confirmationText, req?.body?.confirmText);
  return String(confirmationText || '').trim().toUpperCase() === 'DELETE';
}

function _canPermanentlyDeleteReporterStatus(value, { allowActive = false } = {}) {
  if (allowActive === true) return true;
  return _isArchivedLikeReporterStatus(value);
}

function _buildBulkReporterContactMutationResponse(removedIds, skipped) {
  const normalizedRemovedIds = Array.isArray(removedIds) ? removedIds.filter(Boolean).map((id) => String(id)) : [];
  const normalizedSkipped = Array.isArray(skipped) ? skipped : [];

  return {
    success: true,
    message: 'Bulk remove from directory completed',
    mode: 'soft',
    hidden: true,
    removed: true,
    removedCount: normalizedRemovedIds.length,
    removedIds: normalizedRemovedIds,
    deletedCount: normalizedRemovedIds.length,
    deletedIds: normalizedRemovedIds,
    skipped: normalizedSkipped,
  };
}

function _buildDirectoryVisibilityState(status) {
  const normalizedStatus = _normalizeDirectoryStatus(status) || 'active';
  const isRemovedFromDirectory = _isArchivedLikeReporterStatus(normalizedStatus);

  return {
    status: normalizedStatus,
    directoryState: isRemovedFromDirectory ? 'removed' : 'active',
    isRemovedFromDirectory,
    isVisibleInDirectory: !isRemovedFromDirectory,
  };
}

function _resolveReporterContactIdFromRequest(req) {
  const candidates = [
    req?.params?.id,
    req?.body?.contactId,
    req?.body?.id,
    req?.body?.reporterContactId,
    req?.query?.contactId,
    req?.query?.id,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value) {
      return {
        id: value,
        source: candidate === req?.params?.id
          ? 'params.id'
          : candidate === req?.body?.contactId
            ? 'body.contactId'
            : candidate === req?.body?.id
              ? 'body.id'
              : candidate === req?.body?.reporterContactId
                ? 'body.reporterContactId'
                : candidate === req?.query?.contactId
                  ? 'query.contactId'
                  : 'query.id',
      };
    }
  }
  return { id: '', source: null };
}

function _logHideReporterContactDiagnostics(req, payload) {
  if (!_shouldLogAdminProfilePhoneDiagnostics(req)) return;
  console.log('[reporter-contact-hide]', {
    receivedId: payload?.receivedId || null,
    idSource: payload?.idSource || null,
    isValidObjectId: payload?.isValidObjectId === true,
    foundContact: payload?.foundContact === true,
    action: payload?.action || null,
  });
}

function _maskPhoneForDirectory(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length <= 4) return raw;
  return `xxxxxx${digits.slice(-4)}`;
}

function _firstDirectoryPhoneValue(...values) {
  for (const value of values) {
    const normalized = _normalizePhoneValue(value);
    if (normalized) return normalized;
  }
  return null;
}

function _extractMethodValue(methods, wantedType) {
  const rows = Array.isArray(methods) ? methods : [];
  const normalizedType = _normalizeStatusToken(wantedType || '');
  const matches = rows
    .filter((method) => _normalizeStatusToken(method?.type || '') === normalizedType && _normalizeStatusToken(method?.status || 'active') === 'active')
    .sort((a, b) => Number(b?.isPrimary === true) - Number(a?.isPrimary === true));
  for (const method of matches) {
    const value = _firstNonEmptyString(method?.normalized, method?.value);
    if (value) return value;
  }
  return null;
}

function _buildDirectoryQualityFlags(input) {
  const fullPhone = _normalizePhoneValue(input?.phoneFull || input?.phone || null);
  const missingPhone = !fullPhone;
  const missingLocation = ![
    input?.city,
    input?.district,
    input?.state,
    input?.country,
    input?.area,
  ].some((value) => _firstNonEmptyString(value));
  const verification = _normalizeVerificationForDirectory(input?.verification || input?.verificationLevel || null) || 'community_default';
  const needsVerification = verification !== 'verified' && verification !== 'limited';

  return {
    missingPhone,
    missingLocation,
    needsVerification,
  };
}

function _parseBooleanQuery(value) {
  if (value === undefined || value === null || value === '') return null;
  const token = _normalizeStatusToken(value);
  if (['1', 'true', 'yes', 'y', 'on'].includes(token)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(token)) return false;
  return null;
}

function _parsePositiveIntQuery(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return fallback;
  return Math.min(parsed, max);
}

function _normalizeOptionalFilterValue(value) {
  const token = _normalizeStatusToken(value);
  if (!token) return null;
  if (['all', 'any', 'default', 'none', 'null', 'undefined', 'select', 'select_state', 'select_district', 'select_city', 'all_states', 'all_districts', 'all_cities', 'all_countries'].includes(token)) {
    return null;
  }
  return token;
}

function _summarizeManualOverrideState(overrides) {
  if (!overrides || typeof overrides !== 'object') return null;
  const rows = Object.values(overrides).filter((row) => row && row.enabled === true && row.updatedAt);
  if (!rows.length) return null;
  rows.sort((a, b) => new Date(String(b.updatedAt || 0)).getTime() - new Date(String(a.updatedAt || 0)).getTime());
  return {
    updatedAt: _toIsoOrNull(rows[0].updatedAt),
  };
}

function _isLocalDiagnosticsRequest(req) {
  const host = String(req?.headers?.host || req?.get?.('host') || '').toLowerCase();
  const origin = String(req?.headers?.origin || '').toLowerCase();
  const forwardedFor = String(req?.headers?.['x-forwarded-for'] || '').toLowerCase();
  return [host, origin, forwardedFor].some((value) => value.includes('localhost') || value.includes('127.0.0.1'));
}

function _logLocalDirectoryDiagnostics(req, payload) {
  if (!_isLocalDiagnosticsRequest(req)) return;
  const safePayload = {
    routePath: payload?.routePath || null,
    dbName: payload?.dbName || null,
    queryParamsReceived: payload?.queryParamsReceived || {},
    defaultLimit: payload?.defaultLimit ?? null,
    defaultPage: payload?.defaultPage ?? null,
    normalizedPagination: payload?.normalizedPagination || {},
    usedFirstPageFallback: payload?.usedFirstPageFallback === true,
    filtersReceived: payload?.filtersReceived || {},
    effectiveFilters: payload?.effectiveFilters || {},
    totalRowsReturned: payload?.totalRowsReturned ?? null,
    skippedRows: payload?.skippedRows || { total: 0, reasons: {} },
  };
  console.log('[LOCALHOST][reporter-directory]', JSON.stringify(safePayload));
}

function _shouldLogAdminProfilePhoneDiagnostics(req) {
  if (_isLocalDiagnosticsRequest(req)) return true;
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
    && String(process.env.REPORTER_CONTACTS_DEBUG || '').trim() === '1';
}

function _logAdminProfilePhoneDiagnostics(req, payload) {
  if (!_shouldLogAdminProfilePhoneDiagnostics(req)) return;
  console.log('[reporter-contact-backend-phone]', {
    reporterId: payload?.reporterId || null,
    email: payload?.email || null,
    dbPhone: payload?.dbPhone || null,
    dbPhoneNumber: payload?.dbPhoneNumber || null,
    dbMobile: payload?.dbMobile || null,
    dbContactNumber: payload?.dbContactNumber || null,
    dbWhatsapp: payload?.dbWhatsapp || null,
    dbAlternatePhone: payload?.dbAlternatePhone || null,
    dbMethodPhone: payload?.dbMethodPhone || null,
    dbMethodWhatsapp: payload?.dbMethodWhatsapp || null,
    dbPrimaryPhone: payload?.dbPrimaryPhone || null,
    dbMaskedPhone: payload?.dbMaskedPhone || null,
    dbPhonePreview: payload?.dbPhonePreview || null,
    listPhonePreview: payload?.listPhonePreview || null,
    responsePhone: payload?.responsePhone || null,
    responseWhatsapp: payload?.responseWhatsapp || null,
    responseMaskedPhone: payload?.responseMaskedPhone || null,
    responsePhonePreview: payload?.responsePhonePreview || null,
    phoneDropped: payload?.phoneDropped === true,
    whatsappDropped: payload?.whatsappDropped === true,
  });
}

function _logAdminDrawerDiagnostics(req, payload) {
  if (!_shouldLogAdminProfilePhoneDiagnostics(req)) return;
  console.log('[reporter-contact][admin-drawer]', {
    reporterId: payload?.reporterId || null,
    email: payload?.email || null,
    hasPhone: payload?.hasPhone === true,
    hasWhatsapp: payload?.hasWhatsapp === true,
    city: payload?.city || null,
    state: payload?.state || null,
    coverageScope: payload?.coverageScope || null,
    storiesCount: Number(payload?.storiesCount || 0),
    approvedCount: Number(payload?.approvedCount || 0),
    pendingCount: Number(payload?.pendingCount || 0),
    notesCount: Number(payload?.notesCount || 0),
    tasksCount: Number(payload?.tasksCount || 0),
    activityCount: Number(payload?.activityCount || 0),
    fieldPresence: payload?.fieldPresence || {},
  });
}

function _logCompareListVsProfileDiagnostics(req, payload) {
  if (!_shouldLogAdminProfilePhoneDiagnostics(req)) return;
  console.log('[reporter-contact][compare-list-vs-profile]', {
    reporterId: payload?.reporterId || null,
    email: payload?.email || null,
    dbPhone: payload?.dbPhone || null,
    dbMaskedPhone: payload?.dbMaskedPhone || null,
    listPhonePreview: payload?.listPhonePreview || null,
    profilePhone: payload?.profilePhone || null,
    profileMaskedPhone: payload?.profileMaskedPhone || null,
  });
}

function _logReporterContactListShapeDiagnostics(req, rows) {
  if (!_shouldLogAdminProfilePhoneDiagnostics(req)) return;
  for (const row of Array.isArray(rows) ? rows : []) {
    console.log('[reporter-contact-list-shape]', {
      email: row?.email || null,
      reporterContactId: row?.reporterContactId || row?.contactId || row?.id || null,
      responseId: row?.id || null,
      response_id: row?._id || null,
      responseContactId: row?.contactId || null,
    });
  }
}

function _buildFieldPresenceMap(profileContract) {
  return {
    phone: !!_normalizeKnownPhoneValue(profileContract?.phone || profileContract?.maskedPhone || profileContract?.phonePreview || null),
    whatsapp: !!_normalizePhoneValue(profileContract?.whatsappNumber || null),
    email: !!_normalizeEmail(profileContract?.email || null),
    city: !!_firstNonEmptyString(profileContract?.location?.city),
    state: !!_firstNonEmptyString(profileContract?.location?.state),
    coverageScope: !!_firstNonEmptyString(profileContract?.coverage?.scope),
    coverageAreas: Array.isArray(profileContract?.coverage?.areas) && profileContract.coverage.areas.length > 0,
    beats: Array.isArray(profileContract?.coverage?.beats) && profileContract.coverage.beats.length > 0,
    stories: Number(profileContract?.tabCounts?.stories || 0) > 0,
    notes: Number(profileContract?.tabCounts?.notes || 0) > 0,
    tasks: Number(profileContract?.tabCounts?.tasks || 0) > 0,
    activity: Number(profileContract?.tabCounts?.activity || 0) > 0,
  };
}

function _shouldLogReporterDirectorySourceCounts(req) {
  if (_isLocalDiagnosticsRequest(req)) return true;
  return String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
    && String(process.env.REPORTER_CONTACTS_DEBUG || '').trim() === '1';
}

async function _getReporterDirectorySourceCounts(contactCount, returnedCount) {
  const sourceCounts = {
    reporterContact: Number(contactCount || 0),
    communitySubmission: 0,
    communityReport: 0,
    communityStorySourceCommunity: 0,
    returned: Number(returnedCount || 0),
  };

  try {
    sourceCounts.communitySubmission = await CommunitySubmission.countDocuments({
      isDeleted: { $ne: true },
      $or: [
        { sourceType: { $in: ['community', 'journalist'] } },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    });
  } catch (_) {}

  try {
    sourceCounts.communityReport = await CommunityReport.countDocuments({});
  } catch (_) {}

  try {
    const db = mongoose?.connection?.db;
    if (db) {
      const collections = await db.listCollections({ name: 'communityreporterstories' }).toArray();
      if (Array.isArray(collections) && collections.length) {
        sourceCounts.communityStorySourceCommunity = await db.collection('communityreporterstories').countDocuments({ source: 'community' });
      }
    }
  } catch (_) {}

  return sourceCounts;
}

function _buildReporterDirectoryStatsPayload(summary) {
  return {
    totalReporters: Number(summary?.total || 0),
    verified: Number(summary?.verified || 0),
    missingPhone: Number(summary?.missingPhone || 0),
    missingLocation: Number(summary?.missingLocation || 0),
    activeThisMonth: Number(summary?.activeThisMonth || 0),
    newThisMonth: Number(summary?.newThisMonth || 0),
    lastSubmission: summary?.lastSubmissionAt || null,
  };
}

function _hasRealReporterDirectoryFilters(effectiveFilters) {
  if (!effectiveFilters || typeof effectiveFilters !== 'object') return false;
  const entries = Object.entries(effectiveFilters);
  return entries.some(([key, value]) => {
    if (value === null || value === undefined) return false;
    if (key === 'includeArchived') return value === true;
    return true;
  });
}

function _deriveApprovalState(statusValue) {
  const s = String(statusValue || '').trim().toLowerCase();
  if (!s) return 'pending';
  if (['approved', 'published'].includes(s)) return 'approved';
  if (['rejected', 'trash', 'deleted'].includes(s)) return 'rejected';
  if (['new', 'pending', 'under_review', 'ai_reviewed', 'pending_founder', 'pendingfounder', 'pending_founder_review'].includes(s)) return 'pending';
  if (s.includes('approve')) return 'approved';
  if (s.includes('reject')) return 'rejected';
  return 'pending';
}

function _buildSubmissionMatchForContact(contact) {
  const contactId = contact && contact._id ? String(contact._id) : null;
  const email = _normalizeEmail(contact && contact.email);
  const phoneFull = _normalizePhone(contact && (contact.phoneFull || contact.phoneNumber));
  const userId = contact && contact.userId ? String(contact.userId) : null;

  const or = [];
  if (contactId && _isValidObjectId(contactId)) {
    or.push({ reporterId: contactId });
  }
  if (userId) {
    or.push({ reporterUserId: userId });
  }
  if (email) {
    or.push({ reporterEmailNorm: email });
    or.push({ reporterEmail: email });
    or.push({ email });
    or.push({ 'contact.email': email });
  }
  if (phoneFull) {
    or.push({ 'contact.phone': phoneFull });
  }
  return or;
}

async function _countLinkedSubmissionsForContact(contact) {
  const or = _buildSubmissionMatchForContact(contact);
  if (!or.length) return 0;
  return CommunitySubmission.countDocuments({ $or: or, isDeleted: { $ne: true } });
}

async function _countLinkedProfilesForContact(contact) {
  const id = contact && contact._id ? String(contact._id) : null;
  if (!id || !_isValidObjectId(id)) return 0;
  try {
    return await ReporterProfile.countDocuments({ reporterContactId: id, mergedIntoProfileId: null });
  } catch (_) {
    return 0;
  }
}

function _isProtectedContact(contact) {
  const verification = String(contact?.verificationLevel || '').trim().toLowerCase();
  // Treat verified directory entries as protected from hard delete.
  return verification === 'verified';
}

function _jsonError(res, status, { code, message, details }) {
  return res.status(status).json({
    success: false,
    ok: false,
    code,
    message,
    details: details || undefined,
  });
}

function _requireFounderOrAdminRole(req, res) {
  const role = String(req?.admin?.role || '').trim().toLowerCase();
  if (role === 'founder' || role === 'admin') return true;
  _jsonError(res, 403, { code: 'PERMISSION_DENIED', message: 'Permission denied' });
  return false;
}

function _isSubmissionInDeletedState(doc) {
  if (!doc) return false;
  if (doc.isDeleted === true) return true;
  if (doc.deletedAt) return true;
  const s = String(doc.status || '').trim().toLowerCase();
  return ['deleted', 'trash', 'archived', 'deactivated'].includes(s);
}

function _isNewsDocPubliclyVisible(newsDoc, now = new Date()) {
  if (!newsDoc) return false;
  const nowDt = now instanceof Date ? now : new Date(now);
  const status = String(newsDoc.status || '').trim().toLowerCase();
  if (status !== 'published') return false;

  const deletedAt = newsDoc.deletedAt ?? null;
  if (deletedAt) return false;
  if (newsDoc.locked === true) return false;

  const embargoUntil = newsDoc.embargoUntil ?? null;
  if (embargoUntil instanceof Date && embargoUntil.getTime() > nowDt.getTime()) return false;

  const publishAt = newsDoc.publishAt ?? null;
  if (publishAt instanceof Date && publishAt.getTime() > nowDt.getTime()) return false;

  if (newsDoc.workflow && typeof newsDoc.workflow === 'object') {
    if (newsDoc.workflow.locked === true) return false;
    const wEmbargo = newsDoc.workflow.embargoUntil ?? null;
    if (wEmbargo instanceof Date && wEmbargo.getTime() > nowDt.getTime()) return false;
  }

  return true;
}

function _isPublicArticleDocPubliclyVisible(articleDoc, now = new Date()) {
  if (!articleDoc) return false;
  const nowDt = now instanceof Date ? now : new Date(now);
  const status = String(articleDoc.status || '').trim().toLowerCase();
  if (status !== 'published') return false;
  const publishedAt = articleDoc.publishedAt ?? null;
  if (publishedAt instanceof Date && publishedAt.getTime() > nowDt.getTime()) return false;
  return true;
}

async function _aggregateSubmissionStatsByContactKey(contactKeys) {
  if (!Array.isArray(contactKeys) || contactKeys.length === 0) return new Map();

  const keys = contactKeys.map(k => String(k || '').trim()).filter(Boolean);
  if (keys.length === 0) return new Map();

  const approvedStatuses = ['approved', 'published', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app'];
  const publishedStatuses = ['published', 'publish', 'published_final'];
  const pendingStatuses = ['new', 'pending', 'under_review', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'underreview', 'review'];
  const rejectedStatuses = ['rejected', 'reject', 'trash', 'discarded', 'archived'];
  const withdrawnStatuses = ['withdrawn'];

  const pipeline = [
    { $match: { isDeleted: { $ne: true } } },
    {
      $addFields: {
        _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
      },
    },
    {
      $addFields: {
        _emailNorm: {
          $cond: [
            { $or: [{ $eq: ['$_emailRaw', null] }, { $eq: ['$_emailRaw', ''] }] },
            null,
            { $toLower: { $trim: { input: { $toString: '$_emailRaw' } } } },
          ],
        },
      },
    },
    {
      $addFields: {
        _statusNorm: {
          $cond: [
            { $or: [{ $eq: ['$status', null] }, { $eq: ['$status', ''] }] },
            '',
            { $toLower: { $trim: { input: { $toString: '$status' } } } },
          ],
        },
        contactKey: {
          $cond: [
            { $and: [{ $ne: ['$reporterId', null] }, { $ne: ['$reporterId', ''] }] },
            { $toString: '$reporterId' },
            {
              $cond: [
                { $and: [{ $ne: ['$_emailNorm', null] }, { $ne: ['$_emailNorm', ''] }] },
                '$_emailNorm',
                {
                  $cond: [
                    { $and: [{ $ne: ['$contact.phone', null] }, { $ne: ['$contact.phone', ''] }] },
                    { $toString: '$contact.phone' },
                    null,
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    { $match: { contactKey: { $in: keys } } },
    {
      $group: {
        _id: '$contactKey',
        totalStories: { $sum: 1 },
        approvedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', approvedStatuses] }, 1, 0] } },
        pendingStories: { $sum: { $cond: [{ $in: ['$_statusNorm', pendingStatuses] }, 1, 0] } },
        rejectedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', rejectedStatuses] }, 1, 0] } },
        withdrawnStories: { $sum: { $cond: [{ $in: ['$_statusNorm', withdrawnStatuses] }, 1, 0] } },
        publishedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', publishedStatuses] }, 1, 0] } },
        lastStoryAt: { $max: '$createdAt' },
      },
    },
  ];

  const rows = await CommunitySubmission.aggregate(pipeline);
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = row && row._id !== undefined && row._id !== null ? String(row._id) : '';
    if (!k) continue;
    map.set(k, {
      totalStories: Number(row.totalStories || 0),
      approvedStories: Number(row.approvedStories || 0),
      pendingStories: Number(row.pendingStories || 0),
      rejectedStories: Number(row.rejectedStories || 0),
      withdrawnStories: Number(row.withdrawnStories || 0),
      publishedStories: Number(row.publishedStories || 0),
      lastStoryAt: row.lastStoryAt || null,
    });
  }
  return map;
}

// GET /api/community-reporter/queue
// Returns real queue items from CommunitySubmission with status mapping
async function getCommunityReporterQueue(req, res) {
  try {
    // In local/test runs without MongoDB, avoid Mongoose command buffering delays.
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      const status = (req.query.status || 'pending').toString();
      return res.status(200).json({
        ok: true,
        success: true,
        status: 200,
        data: [],
        meta: { statusFilter: status, total: 0, page: 1, limit: 0 },
        message: 'Community reporter queue',
      });
    }

    const status = (req.query.status || 'pending').toString();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const filter = buildCommunitySubmissionAdminFilter(req.query, { defaultStatus: status });

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    const data = docs.map(d => ({
      id: d._id.toString(),
      headline: d.headline || '',
      category: d.category || null,
      desk: getSubmissionDeskMetadata(d).desk || null,
      track: getSubmissionDeskMetadata(d).track || null,
      reporter: (d.contact && d.contact.name) || d.reporterName || d.name || 'Unknown',
      reporterName: (d.contact && d.contact.name) || d.reporterName || d.name || null,
      reporterEmail: d.reporterEmailNorm || d.reporterEmail || d.email || (d.contact && d.contact.email) || null,
      reporterPhone: (d.contact && d.contact.phone) || null,
      location: d.reporterLocation || (d.location && d.location.city) || d.city || null,
      locationObj: d.location || d.locationDetail || null,
      attachments: Array.isArray(d.attachments) ? d.attachments : [],
      priority: d.priority || 'normal',
      aiRisk: typeof d.riskScore === 'number' ? d.riskScore : null,
      status: d.status || 'under_review',
      createdAt: d.createdAt || null,
    }));

    return res.status(200).json({ ok: true, success: true, status: 200, data, meta: { statusFilter: status, total, page, limit }, message: 'Community reporter queue' });
  } catch (err) {
    console.error('Error in GET /api/community-reporter/queue:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
  }
}

// DELETE /api/community-reporter/contacts/:id
// Founder/admin default remove flow: soft-hide only.
async function deleteReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();

    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id);
    if (!contact) {
      return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
    }

    await ReporterContact.updateOne(
      { _id: id },
      {
        $set: {
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: actor,
          deletedAt: null,
          deletedBy: null,
        },
      }
    );

    console.log('[ADMIN_DELETE][reporter-contact] archived', { actor, deletedId: id, hard: false });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DELETE', id, { entity: 'ReporterContact', hard: false, hidden: true, removed: true });

    return res.status(200).json({
      success: true,
      message: 'Reporter contact removed from directory successfully',
      mode: 'soft',
      hidden: true,
      removed: true,
      deletedId: id,
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to delete reporter contact' });
  }
}

// POST /api/admin/community-reporter/contacts/:id/deactivate
// Safely disables the contact without deleting the record.
async function deactivateReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_isValidObjectId(id)) return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });

    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    await ReporterContact.updateOne(
      { _id: id },
      {
        $set: {
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedBy: actor,
          ...(reason ? { suspendedReason: reason } : {}),
        },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DEACTIVATE', id, { entity: 'ReporterContact', reason });
    return res.status(200).json({ success: true, id, status: 'suspended' });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][deactivate] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to deactivate reporter contact' });
  }
}

async function archiveReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_isValidObjectId(id)) return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });

    const reason = _firstNonEmptyString(req.body?.reason, req.body?.archiveReason);
    await ReporterContact.updateOne(
      { _id: id },
      {
        $set: {
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: actor,
          ...(reason ? { archivedReason: reason } : {}),
        },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_ARCHIVE', id, { entity: 'ReporterContact', reason });
    return res.status(200).json({ success: true, id, status: 'archived' });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][archive] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to archive reporter contact' });
  }
}

async function hideReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const { id, source } = _resolveReporterContactIdFromRequest(req);
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    const isValidObjectId = _isValidObjectId(id);
    if (!isValidObjectId) {
      _logHideReporterContactDiagnostics(req, {
        receivedId: id,
        idSource: source,
        isValidObjectId: false,
        foundContact: false,
        action: 'hide.invalid_id',
      });
      return _jsonError(res, 400, {
        code: 'INVALID_CONTACT_ID',
        message: 'Invalid ReporterContact id',
        details: { receivedId: id || null, idSource: source || null, expected: 'ReporterContact ObjectId' },
      });
    }

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) {
      _logHideReporterContactDiagnostics(req, {
        receivedId: id,
        idSource: source,
        isValidObjectId: true,
        foundContact: false,
        action: 'hide.not_found',
      });
      return _jsonError(res, 404, {
        code: 'CONTACT_NOT_FOUND',
        message: 'ReporterContact not found for provided id',
        details: { receivedId: id, idSource: source || null },
      });
    }

    const reason = _firstNonEmptyString(req.body?.reason, req.body?.hideReason, req.body?.archiveReason);
    await ReporterContact.updateOne(
      { _id: id },
      {
        $set: {
          status: 'archived',
          archivedAt: new Date(),
          archivedBy: actor,
          ...(reason ? { archivedReason: reason } : {}),
        },
      }
    );

    _logHideReporterContactDiagnostics(req, {
      receivedId: id,
      idSource: source,
      isValidObjectId: true,
      foundContact: true,
      action: 'hide.success',
    });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_HIDE', id, { entity: 'ReporterContact', reason });
    const removalRequest = /\/remove(?:-from-directory)?(?:\/|$)/i.test(String(req.originalUrl || req.path || ''));
    return res.status(200).json({
      success: true,
      id,
      status: 'archived',
      hidden: true,
      removed: removalRequest,
      message: removalRequest
        ? 'Reporter contact removed from directory successfully'
        : 'Reporter contact hidden successfully',
    });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][hide] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to hide reporter contact' });
  }
}

async function listHiddenReporterContacts(req, res) {
  req.query = {
    ...(req.query || {}),
    status: 'archived',
    includeArchived: 'true',
  };
  return adminListReporterContacts(req, res);
}

async function restoreReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_isValidObjectId(id)) return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });

    await ReporterContact.updateOne(
      { _id: id },
      {
        $set: { status: 'active', restoredAt: new Date(), restoredBy: actor },
        $unset: {
          archivedAt: 1,
          archivedBy: 1,
          archivedReason: 1,
          deletedAt: 1,
          deletedBy: 1,
          suspendedAt: 1,
          suspendedBy: 1,
          suspendedReason: 1,
        },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_RESTORE', id, { entity: 'ReporterContact' });
    return res.status(200).json({ success: true, id, status: 'active' });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][restore] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to restore reporter contact' });
  }
}

async function _executePermanentDeleteReporterContact(req, res, { allowActive = false } = {}) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();

    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id);
    if (!contact) {
      return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
    }

    if (!_canPermanentlyDeleteReporterStatus(contact.status, { allowActive })) {
      return _jsonError(res, 409, {
        code: 'CONTACT_NOT_HIDDEN',
        message: allowActive
          ? 'Permanent delete is not allowed for this contact state.'
          : 'Permanent delete is only allowed for hidden/archive contacts.',
        details: allowActive ? { allowedActions: [] } : { allowedActions: ['hide', 'archive'] },
      });
    }

    if (!_hasPermanentDeleteConfirmation(req)) {
      return _jsonError(res, 400, {
        code: 'DELETE_CONFIRMATION_REQUIRED',
        message: 'Permanent delete requires explicit confirmation.',
        details: { confirmation: 'Set confirm=true or confirmationText=DELETE' },
      });
    }

    if (_isProtectedContact(contact)) {
      return _jsonError(res, 403, {
        code: 'CONTACT_IS_PROTECTED',
        message: 'This contact is protected and cannot be permanently deleted.',
        details: { allowedActions: ['restore', 'deactivate'] },
      });
    }

    const linkedCount = await _countLinkedSubmissionsForContact(contact);
    if (linkedCount > 0) {
      return _jsonError(res, 409, {
        code: 'CONTACT_HAS_LINKED_STORIES',
        message: 'Cannot permanently delete reporter contact while linked stories exist.',
        details: { linkedStories: linkedCount, allowedActions: ['restore', 'reassign_stories'] },
      });
    }

    const linkedProfiles = await _countLinkedProfilesForContact(contact);
    if (linkedProfiles > 0) {
      return _jsonError(res, 409, {
        code: 'CONTACT_HAS_DEPENDENCIES',
        message: 'Cannot permanently delete reporter contact while contributor profiles depend on it.',
        details: { linkedProfiles, allowedActions: ['restore'] },
      });
    }

    await ReporterContact.deleteOne({ _id: id });

    console.log('[ADMIN_DELETE][reporter-contact] permanently deleted', { actor, deletedId: id, hard: true, allowActive });
    await logAudit(req, allowActive ? 'COMMUNITY_REPORTER_CONTACT_FORCE_PERMANENT_DELETE' : 'COMMUNITY_REPORTER_CONTACT_PERMANENT_DELETE', id, { entity: 'ReporterContact', hard: true, confirmed: true, allowActive });

    return res.status(200).json({
      success: true,
      message: 'Reporter contact permanently deleted successfully',
      mode: 'hard',
      bypassedHiddenRequirement: allowActive === true,
      deletedId: id,
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact][permanent] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to permanently delete reporter contact' });
  }
}

async function permanentlyDeleteReporterContact(req, res) {
  return _executePermanentDeleteReporterContact(req, res, { allowActive: false });
}

async function forcePermanentlyDeleteReporterContact(req, res) {
  return _executePermanentDeleteReporterContact(req, res, { allowActive: true });
}

// POST /api/admin/community-reporter/contacts/:id/reassign-stories
// Moves stories from one ReporterContact to another (safe alternative to delete).
async function reassignReporterContactStories(req, res) {
  const actor = _actorLabel(req);
  try {
    const fromId = String(req.params.id || '').trim();
    const toId = String(req.body?.toContactId || '').trim();
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_isValidObjectId(fromId)) return _jsonError(res, 400, { code: 'INVALID_FROM_CONTACT_ID', message: 'Invalid from contact id' });
    if (!_isValidObjectId(toId)) return _jsonError(res, 400, { code: 'INVALID_TO_CONTACT_ID', message: 'Invalid to contact id' });
    if (fromId === toId) return _jsonError(res, 400, { code: 'SAME_CONTACT', message: 'from and to contacts must be different' });

    const [from, to] = await Promise.all([
      ReporterContact.findById(fromId).lean(),
      ReporterContact.findById(toId).lean(),
    ]);
    if (!from) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'From contact not found' });
    if (!to) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'To contact not found' });

    const fromEmail = _normalizeEmail(from.email);

    // Primary: move direct reporterId links.
    const direct = await CommunitySubmission.updateMany(
      { reporterId: fromId },
      { $set: { reporterId: toId } }
    );

    // Secondary: for older submissions without reporterId, optionally link by email.
    // Only set reporterId when currently null/missing to reduce risk of stealing stories.
    let emailLinked = { modifiedCount: 0 };
    if (fromEmail) {
      emailLinked = await CommunitySubmission.updateMany(
        {
          reporterId: { $in: [null, undefined] },
          $or: [
            { reporterEmailNorm: fromEmail },
            { reporterEmail: fromEmail },
            { email: fromEmail },
            { 'contact.email': fromEmail },
          ],
          isDeleted: { $ne: true },
        },
        { $set: { reporterId: toId } }
      );
    }

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_REASSIGN_STORIES', fromId, { entity: 'ReporterContact', toContactId: toId });
    console.log('[ADMIN][reporter-contact][reassign-stories]', { actor, fromId, toId });

    const directModified = typeof direct?.modifiedCount === 'number' ? direct.modifiedCount : (direct?.nModified || 0);
    const emailModified = typeof emailLinked?.modifiedCount === 'number' ? emailLinked.modifiedCount : (emailLinked?.nModified || 0);

    return res.status(200).json({
      success: true,
      fromId,
      toId,
      reassigned: {
        reporterIdMatches: directModified,
        emailMatches: emailModified,
      },
    });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][reassign-stories] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to reassign stories' });
  }
}

// POST /api/community-reporter/contacts/bulk-delete
// Body: { ids: string[] }
async function bulkDeleteReporterContacts(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }

    const receivedCount = ids.length;
    const validIds = ids
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .filter(mongoose.Types.ObjectId.isValid);

    if (validIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid ids provided', receivedCount });
    }

    const hard = _parseBool(req.query?.hard);
    if (hard) {
      return _jsonError(res, 409, {
        code: 'BULK_PERMANENT_DELETE_NOT_SUPPORTED',
        message: 'Bulk permanent delete is not supported. Use the Profile drawer to permanently delete individual contacts.',
        details: { allowedActions: ['bulk_remove', 'restore', 'permanent_delete_individual'] },
      });
    }

    console.log('Bulk remove contacts ids:', validIds.length);

    const deletedIds = [];
    const skipped = [];

    for (const id of validIds) {
      const contact = await ReporterContact.findById(id);
      if (!contact) {
        skipped.push({ id, code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
        continue;
      }

      await ReporterContact.updateOne(
        { _id: id },
        {
          $set: { status: 'archived', archivedAt: new Date(), archivedBy: actor, deletedAt: null, deletedBy: null },
        }
      );

      deletedIds.push(id);
    }

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_BULK_REMOVE', null, {
      entity: 'ReporterContact',
      receivedCount,
      validCount: validIds.length,
      removedCount: deletedIds.length,
      skippedCount: skipped.length,
    });

    return res.status(200).json(_buildBulkReporterContactMutationResponse(deletedIds, skipped));
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact][bulk] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to bulk remove reporter contacts' });
  }
}

function _escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _contactKeyForContact(contact) {
  const contactId = contact && contact._id ? String(contact._id) : null;
  if (contactId && _isValidObjectId(contactId)) return contactId;
  const email = _normalizeEmail(contact && contact.email);
  if (email) return email;
  const phone = _normalizePhone(contact && (contact.phoneFull || contact.phoneNumber));
  if (phone) return phone;
  return null;
}

function _contactKeysForContact(contact) {
  const out = [];
  const contactId = contact && contact._id ? String(contact._id) : null;
  if (contactId && _isValidObjectId(contactId)) out.push(contactId);
  const email = _normalizeEmail(contact && contact.email);
  if (email) out.push(email);
  const phone = _normalizePhone(contact && (contact.phoneFull || contact.phoneNumber));
  if (phone) out.push(phone);
  return Array.from(new Set(out));
}

function _mergeDirectoryStats(contact, aggregatedStats) {
  const stats = contact?.stats && typeof contact.stats === 'object' ? contact.stats : {};
  const merged = {
    totalStories: Number(aggregatedStats?.totalStories ?? stats.totalStories ?? 0),
    approvedStories: Number(aggregatedStats?.approvedStories ?? stats.approvedStories ?? 0),
    pendingStories: Number(aggregatedStats?.pendingStories ?? stats.pendingStories ?? 0),
    rejectedStories: Number(aggregatedStats?.rejectedStories ?? stats.rejectedStories ?? 0),
    withdrawnStories: Number(aggregatedStats?.withdrawnStories ?? stats.withdrawnStories ?? 0),
    publishedStories: Number(aggregatedStats?.publishedStories ?? stats.publishedStories ?? 0),
    firstStoryAt: _toIsoOrNull(stats.firstStoryAt || null),
    lastStoryAt: _toIsoOrNull(aggregatedStats?.lastStoryAt || stats.lastStoryAt || null),
    lastSubmissionAt: _toIsoOrNull(stats.lastSubmissionAt || aggregatedStats?.lastStoryAt || null),
    lastStoryTitle: _firstNonEmptyString(stats.lastStoryTitle),
  };
  return merged;
}

function _buildCompactDirectoryRow(contact, aggregatedStats) {
  const reporterContactId = contact?._id ? String(contact._id) : null;
  const mergedStats = _mergeDirectoryStats(contact, aggregatedStats);
  const phoneFull = _normalizePhoneValue(contact?.phoneFull || contact?.phoneNumber || null);
  const whatsappNumber = _normalizePhoneValue(contact?.whatsappNumber || null);
  const alternatePhone = _normalizePhoneValue(contact?.alternatePhone || null);
  const city = _normalizeLocationText(contact?.cityTownVillage || contact?.location?.city || null);
  const district = _normalizeLocationText(contact?.districtName || contact?.location?.district || null);
  const state = _normalizeLocationText(contact?.stateName || contact?.location?.state || null);
  const country = _normalizeLocationText(contact?.country || contact?.location?.country || null);
  const area = _normalizeLocationText(contact?.areaName || null);
  const beat = _normalizeBeatLabel(contact?.primaryBeat || contact?.beat || null);
  const verification = _normalizeVerificationForDirectory(contact?.verificationLevel || null) || 'community_default';
  const reporterType = _normalizeReporterTypeForDirectory(contact?.reporterType || null) || 'community';
  const status = _normalizeDirectoryStatus(contact?.status || null) || 'active';
  const flags = _buildDirectoryQualityFlags({
    phoneFull,
    verification,
    city,
    district,
    state,
    country,
    area,
  });
  const lastActivityAt = _toIsoOrNull(contact?.lastActivityAt || mergedStats.lastSubmissionAt || mergedStats.lastStoryAt || contact?.updatedAt || null);
  const manualOverride = _summarizeManualOverrideState(contact?.directoryManualOverrides || null);
  const maskedPhone = _maskPhoneForDirectory(phoneFull);
  const type = reporterType;
  const canArchive = !['archived', 'banned', 'deleted'].includes(_normalizeStatusToken(status));
  const directoryVisibility = _buildDirectoryVisibilityState(status);

  return {
    id: reporterContactId,
    _id: reporterContactId,
    contactId: reporterContactId,
    reporterContactId,
    name: _firstNonEmptyString(contact?.fullName, contact?.name),
    email: _normalizeEmail(contact?.email || null),
    phone: maskedPhone,
    maskedPhone,
    fullPhone: phoneFull,
    whatsappNumber,
    alternatePhone,
    city,
    district,
    state,
    country,
    area,
    primaryBeat: beat,
    reporterType,
    type,
    verification,
    status,
    directoryState: directoryVisibility.directoryState,
    isRemovedFromDirectory: directoryVisibility.isRemovedFromDirectory,
    isVisibleInDirectory: directoryVisibility.isVisibleInDirectory,
    directory: {
      state: directoryVisibility.directoryState,
      status,
      isRemovedFromDirectory: directoryVisibility.isRemovedFromDirectory,
      isVisibleInDirectory: directoryVisibility.isVisibleInDirectory,
      removedAt: _toIsoOrNull(contact?.archivedAt || null),
      removedBy: _firstNonEmptyString(contact?.archivedBy),
      canRemoveFromDirectory: canArchive,
      canRestore: directoryVisibility.isRemovedFromDirectory,
      canDeletePermanently: directoryVisibility.isRemovedFromDirectory,
    },
    storiesCount: mergedStats.totalStories,
    totalStories: mergedStats.totalStories,
    approvedCount: mergedStats.approvedStories,
    approvedStories: mergedStats.approvedStories,
    pendingCount: mergedStats.pendingStories,
    pendingStories: mergedStats.pendingStories,
    rejectedStories: mergedStats.rejectedStories,
    withdrawnStories: mergedStats.withdrawnStories,
    publishedStories: mergedStats.publishedStories,
    firstStoryAt: mergedStats.firstStoryAt,
    lastStoryAt: mergedStats.lastStoryAt,
    lastSubmissionAt: mergedStats.lastSubmissionAt,
    lastStoryTitle: mergedStats.lastStoryTitle,
    lastActivityAt,
    missingPhone: flags.missingPhone,
    missingLocation: flags.missingLocation,
    needsVerification: flags.needsVerification,
    manualOverrideUpdatedAt: manualOverride?.updatedAt || null,
    actions: {
      email: !!_normalizeEmail(contact?.email || null),
      viewStories: true,
      profile: true,
      archive: false,
      removeFromDirectory: canArchive,
      restore: directoryVisibility.isRemovedFromDirectory,
      deletePermanently: directoryVisibility.isRemovedFromDirectory,
    },
    deleteMode: canArchive ? 'archive_only' : 'restore_or_permanent_delete',
    availableActions: canArchive
      ? ['email', 'view_stories', 'profile', 'remove_from_directory']
      : ['email', 'view_stories', 'profile', 'restore', 'delete_permanently'],
    createdAt: _toIsoOrNull(contact?.createdAt || null),
    updatedAt: _toIsoOrNull(contact?.updatedAt || null),
  };
}

function _buildReporterDirectorySummaryPayload(rows) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const summary = {
    total: 0,
    verified: 0,
    missingPhone: 0,
    missingLocation: 0,
    activeThisMonth: 0,
    newThisMonth: 0,
    lastSubmissionAt: null,
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    summary.total += 1;
    if (row.verification === 'verified') summary.verified += 1;
    if (row.missingPhone) summary.missingPhone += 1;
    if (row.missingLocation) summary.missingLocation += 1;
    const lastActivity = _toDateOrNull(row.lastActivityAt || row.lastSubmissionAt || row.lastStoryAt || null);
    if (lastActivity && lastActivity >= monthStart) summary.activeThisMonth += 1;
    const createdAt = _toDateOrNull(row.createdAt || null);
    if (createdAt && createdAt >= monthStart) summary.newThisMonth += 1;
    const lastSubmission = _toDateOrNull(row.lastSubmissionAt || row.lastStoryAt || row.lastActivityAt || null);
    if (lastSubmission && (!summary.lastSubmissionAt || lastSubmission > new Date(summary.lastSubmissionAt))) {
      summary.lastSubmissionAt = lastSubmission.toISOString();
    }
  }

  return summary;
}

function _buildReporterDirectoryFilters(req) {
  const q = String(req.query.q || '').trim();
  const filter = {};
  if (q) {
    const rx = new RegExp(_escapeRegExp(q), 'i');
    filter.$or = [
      { fullName: rx },
      { email: rx },
      { phoneFull: rx },
      { phoneNumber: rx },
      { whatsappNumber: rx },
      { cityTownVillage: rx },
      { districtName: rx },
      { stateName: rx },
      { country: rx },
      { areaName: rx },
      { primaryBeat: rx },
    ];
  }

  const status = _normalizeDirectoryStatus(req.query.status);
  if (status === 'archived') {
    filter.status = { $in: ['archived', 'banned', 'deleted'] };
  } else if (status === 'blocked') {
    filter.status = { $in: ['blocked', 'suspended', 'revoked'] };
  } else if (status === 'active') {
    filter.status = { $nin: ['archived', 'banned', 'deleted'] };
  }

  const verification = _normalizeVerificationForDirectory(req.query.verification);
  if (verification) filter.verificationLevel = verification;

  const reporterType = _normalizeReporterTypeForDirectory(req.query.reporterType || req.query.type);
  if (reporterType) filter.reporterType = reporterType;

  const includeArchived = _parseBooleanQuery(req.query.includeArchived ?? req.query.includeHidden ?? req.query.showHidden);
  if (includeArchived !== true && !filter.status) {
    filter.status = { $nin: ['archived', 'banned', 'deleted'] };
  }

  return filter;
}

function _mapSubmissionVerificationToDirectory(value, reporterType) {
  const token = _normalizeStatusToken(value);
  if (!token) return reporterType === 'journalist' ? 'pending' : 'community_default';
  if (['journalist_verified', 'verified_journalist', 'verified'].includes(token)) return 'verified';
  if (['journalist_pending', 'pending'].includes(token)) return 'pending';
  if (['unverified', 'community_default', 'new'].includes(token)) return 'community_default';
  return _normalizeVerificationForDirectory(token) || (reporterType === 'journalist' ? 'pending' : 'community_default');
}

async function _aggregateReporterDirectorySubmissionSources() {
  const rows = await CommunitySubmission.aggregate([
    {
      $match: {
        isDeleted: { $ne: true },
        $or: [
          { sourceType: { $in: ['community', 'journalist'] } },
          { sourceType: { $exists: false } },
          { sourceType: null },
          { sourceType: '' },
        ],
      },
    },
    { $sort: { createdAt: 1 } },
    {
      $addFields: {
        _reporterId: {
          $cond: [
            { $and: [{ $ne: ['$reporterId', null] }, { $ne: ['$reporterId', ''] }] },
            { $toString: '$reporterId' },
            null,
          ],
        },
        _profileId: {
          $cond: [
            { $and: [{ $ne: ['$reporterProfileId', null] }, { $ne: ['$reporterProfileId', ''] }] },
            { $toString: '$reporterProfileId' },
            null,
          ],
        },
        _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
        _nameRaw: { $ifNull: ['$reporterName', { $ifNull: ['$name', '$contact.name'] }] },
        _phoneRaw: {
          $ifNull: [
            '$contact.phone',
            { $ifNull: ['$phone', { $ifNull: ['$mobile', { $ifNull: ['$mobileNumber', { $ifNull: ['$contactNumber', { $ifNull: ['$reporterPhone', '$reporterMobile'] }] }] }] }] },
          ],
        },
        _whatsappRaw: { $ifNull: ['$contact.whatsappNumber', { $ifNull: ['$whatsappNumber', '$whatsapp'] }] },
        _cityRaw: { $ifNull: ['$location.city', { $ifNull: ['$locationDetail.city', '$city'] }] },
        _districtRaw: { $ifNull: ['$locationDetail.district', '$district'] },
        _stateRaw: { $ifNull: ['$location.state', { $ifNull: ['$locationDetail.state', '$state'] }] },
        _countryRaw: { $ifNull: ['$location.country', { $ifNull: ['$locationDetail.country', '$country'] }] },
        _statusNorm: {
          $cond: [
            { $or: [{ $eq: ['$status', null] }, { $eq: ['$status', ''] }] },
            '',
            { $toLower: { $trim: { input: { $toString: '$status' } } } },
          ],
        },
      },
    },
    {
      $addFields: {
        _emailNorm: {
          $cond: [
            { $or: [{ $eq: ['$_emailRaw', null] }, { $eq: ['$_emailRaw', ''] }] },
            null,
            { $toLower: { $trim: { input: { $toString: '$_emailRaw' } } } },
          ],
        },
        _groupKey: {
          $ifNull: [
            '$_reporterId',
            { $ifNull: ['$_emailNorm', { $ifNull: ['$_phoneRaw', { $ifNull: ['$_profileId', { $toString: '$_id' }] }] }] },
          ],
        },
      },
    },
    { $match: { _groupKey: { $exists: true, $ne: null, $ne: '' } } },
    {
      $group: {
        _id: '$_groupKey',
        reporterId: { $last: '$_reporterId' },
        reporterProfileId: { $last: '$_profileId' },
        email: { $last: '$_emailNorm' },
        name: { $last: '$_nameRaw' },
        phone: { $last: '$_phoneRaw' },
        whatsappNumber: { $last: '$_whatsappRaw' },
        city: { $last: '$_cityRaw' },
        district: { $last: '$_districtRaw' },
        state: { $last: '$_stateRaw' },
        country: { $last: '$_countryRaw' },
        reporterType: { $last: '$sourceType' },
        verificationLevel: { $last: '$reporterVerificationLevel' },
        totalStories: { $sum: 1 },
        approvedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', ['approved', 'published', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app']] }, 1, 0] } },
        pendingStories: { $sum: { $cond: [{ $in: ['$_statusNorm', ['new', 'pending', 'under_review', 'underreview', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'pendingfounder']] }, 1, 0] } },
        rejectedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', ['rejected', 'reject', 'trash', 'discarded', 'archived']] }, 1, 0] } },
        withdrawnStories: { $sum: { $cond: [{ $eq: ['$_statusNorm', 'withdrawn'] }, 1, 0] } },
        publishedStories: { $sum: { $cond: [{ $or: [{ $ne: ['$linkedArticleId', null] }, { $in: ['$_statusNorm', ['published', 'publish', 'published_final']] }] }, 1, 0] } },
        firstStoryAt: { $min: '$createdAt' },
        lastStoryAt: { $max: '$createdAt' },
        lastStoryTitle: { $last: '$headline' },
      },
    },
  ]);

  return Array.isArray(rows) ? rows : [];
}

function _buildInferredDirectoryContact(sourceRow) {
  const reporterType = _normalizeReporterTypeForDirectory(sourceRow?.reporterType || null) || 'community';
  return {
    _id: sourceRow?.reporterId || sourceRow?._id,
    fullName: _firstNonEmptyString(sourceRow?.name, 'Unknown'),
    email: _normalizeEmail(sourceRow?.email || null),
    emailLower: _normalizeEmail(sourceRow?.email || null),
    phoneFull: _normalizePhoneValue(sourceRow?.phone || null),
    phoneNumber: _normalizePhoneValue(sourceRow?.phone || null),
    whatsappNumber: _normalizePhoneValue(sourceRow?.whatsappNumber || null),
    cityTownVillage: _normalizeLocationText(sourceRow?.city || null),
    districtName: _normalizeLocationText(sourceRow?.district || null),
    stateName: _normalizeLocationText(sourceRow?.state || null),
    country: _normalizeLocationText(sourceRow?.country || null),
    reporterType,
    verificationLevel: _mapSubmissionVerificationToDirectory(sourceRow?.verificationLevel || null, reporterType),
    status: 'active',
    stats: {
      totalStories: Number(sourceRow?.totalStories || 0),
      approvedStories: Number(sourceRow?.approvedStories || 0),
      pendingStories: Number(sourceRow?.pendingStories || 0),
      rejectedStories: Number(sourceRow?.rejectedStories || 0),
      withdrawnStories: Number(sourceRow?.withdrawnStories || 0),
      publishedStories: Number(sourceRow?.publishedStories || 0),
      firstStoryAt: sourceRow?.firstStoryAt || null,
      lastStoryAt: sourceRow?.lastStoryAt || null,
      lastStoryTitle: _firstNonEmptyString(sourceRow?.lastStoryTitle),
    },
    createdAt: sourceRow?.firstStoryAt || sourceRow?.lastStoryAt || null,
    updatedAt: sourceRow?.lastStoryAt || null,
    _inferred: true,
    _inferredFrom: ['community_submissions', 'reporter_portal_submissions', 'published_community_linked_stories'],
  };
}

function _filterReporterDirectoryRows(rows, req, diagnostics) {
  const q = _normalizeOptionalFilterValue(req.query.q || req.query.search || '');
  const wantedStatus = _normalizeDirectoryStatus(_normalizeOptionalFilterValue(req.query.status));
  const wantedVerification = _normalizeVerificationForDirectory(_normalizeOptionalFilterValue(req.query.verification));
  const wantedType = _normalizeReporterTypeForDirectory(_normalizeOptionalFilterValue(req.query.reporterType || req.query.type));
  const includeArchived = _parseBooleanQuery(req.query.includeArchived ?? req.query.includeHidden ?? req.query.showHidden) === true;
  const wantedState = _normalizeOptionalFilterValue(req.query.state || '');
  const wantedDistrict = _normalizeOptionalFilterValue(req.query.district || '');
  const wantedCity = _normalizeOptionalFilterValue(req.query.city || '');
  const wantedCountry = _normalizeOptionalFilterValue(req.query.country || '');
  const missingPhone = _parseBooleanQuery(req.query.missingPhone);
  const missingLocation = _parseBooleanQuery(req.query.missingLocation);

  if (diagnostics) {
    diagnostics.effectiveFilters = {
      q,
      status: wantedStatus,
      verification: wantedVerification,
      reporterType: wantedType,
      state: wantedState,
      district: wantedDistrict,
      city: wantedCity,
      country: wantedCountry,
      includeArchived,
      missingPhone,
      missingLocation,
    };
  }

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const rowStatus = _normalizeStatusToken(row.status);
    const markSkipped = (reason) => {
      if (!diagnostics) return false;
      diagnostics.skipped.total += 1;
      diagnostics.skipped.reasons[reason] = Number(diagnostics.skipped.reasons[reason] || 0) + 1;
      return false;
    };
    if (!includeArchived && ['archived', 'banned', 'deleted'].includes(rowStatus)) return markSkipped('archived_hidden_by_default');
    if (wantedStatus === 'active' && ['archived', 'banned', 'deleted'].includes(rowStatus)) return markSkipped('status_active_excludes_archived');
    if (wantedStatus === 'archived' && !['archived', 'banned', 'deleted'].includes(rowStatus)) return markSkipped('status_archived_only');
    if (wantedStatus === 'blocked' && !['blocked', 'suspended', 'revoked'].includes(rowStatus)) return markSkipped('status_blocked_only');
    if (wantedVerification && row.verification !== wantedVerification) return markSkipped('verification_filter');
    if (wantedType && row.type !== wantedType && row.reporterType !== wantedType) return markSkipped('type_filter');
    if (wantedState && _normalizeStatusToken(row.state || '') !== wantedState) return markSkipped('state_filter');
    if (wantedDistrict && _normalizeStatusToken(row.district || '') !== wantedDistrict) return markSkipped('district_filter');
    if (wantedCity && _normalizeStatusToken(row.city || '') !== wantedCity) return markSkipped('city_filter');
    if (wantedCountry && _normalizeStatusToken(row.country || '') !== wantedCountry) return markSkipped('country_filter');
    if (missingPhone === true && row.missingPhone !== true) return markSkipped('missing_phone_filter');
    if (missingPhone === false && row.missingPhone === true) return markSkipped('has_phone_filter');
    if (missingLocation === true && row.missingLocation !== true) return markSkipped('missing_location_filter');
    if (missingLocation === false && row.missingLocation === true) return markSkipped('has_location_filter');
    if (q) {
      const haystack = [row.name, row.email, row.fullPhone, row.city, row.district, row.state, row.country, row.area, row.primaryBeat]
        .map((value) => _normalizeStatusToken(value || ''))
        .join(' ');
      if (!haystack.includes(q)) return markSkipped('search_filter');
    }
    return true;
  });
}

function _sortReporterDirectoryRows(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const aLast = _toDateOrNull(a.lastActivityAt || a.lastStoryAt || a.lastSubmissionAt || a.updatedAt || null);
    const bLast = _toDateOrNull(b.lastActivityAt || b.lastStoryAt || b.lastSubmissionAt || b.updatedAt || null);
    const aTime = aLast ? aLast.getTime() : 0;
    const bTime = bLast ? bLast.getTime() : 0;
    if (bTime !== aTime) return bTime - aTime;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

async function _loadReporterDirectoryRows(req) {
  const diagnostics = {
    skipped: { total: 0, reasons: {} },
    effectiveFilters: {},
  };
  const contacts = await ReporterContact.find({}).lean();
  const allKeys = contacts.flatMap(_contactKeysForContact).filter(Boolean);
  const statsMap = await _aggregateSubmissionStatsByContactKey(allKeys);
  const contactRows = contacts.map((contact) => {
    const keys = _contactKeysForContact(contact);
    const mergedStats = keys.reduce((acc, key) => {
      if (!key || !statsMap.has(key)) return acc;
      const row = statsMap.get(key);
      acc.totalStories += Number(row.totalStories || 0);
      acc.approvedStories += Number(row.approvedStories || 0);
      acc.pendingStories += Number(row.pendingStories || 0);
      acc.rejectedStories += Number(row.rejectedStories || 0);
      acc.withdrawnStories += Number(row.withdrawnStories || 0);
      acc.publishedStories += Number(row.publishedStories || 0);
      const last = _toDateOrNull(row.lastStoryAt || null);
      const current = _toDateOrNull(acc.lastStoryAt || null);
      if (last && (!current || last > current)) acc.lastStoryAt = last.toISOString();
      return acc;
    }, { totalStories: 0, approvedStories: 0, pendingStories: 0, rejectedStories: 0, withdrawnStories: 0, publishedStories: 0, lastStoryAt: null });
    return _buildCompactDirectoryRow(contact, mergedStats);
  });

  const existingKeys = new Set();
  for (const contact of contacts) {
    for (const key of _contactKeysForContact(contact)) existingKeys.add(String(key));
  }

  const inferredSources = await _aggregateReporterDirectorySubmissionSources();
  const inferredRows = inferredSources
    .filter((row) => {
      const rowKeys = [row?._id, row?.reporterId, _normalizeEmail(row?.email || null), _normalizePhoneValue(row?.phone || null)]
        .filter(Boolean)
        .map((value) => String(value));
      return rowKeys.every((key) => !existingKeys.has(key));
    })
    .map((row) => _buildCompactDirectoryRow(_buildInferredDirectoryContact(row), row));

  const mergedRows = _sortReporterDirectoryRows(_filterReporterDirectoryRows([...contactRows, ...inferredRows], req, diagnostics));
  return {
    sourceContactCount: contacts.length,
    rows: mergedRows,
    summary: _buildReporterDirectorySummaryPayload(mergedRows),
    diagnostics,
  };
}

// GET /api/admin/community-reporter/contacts
async function adminListReporterContacts(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const page = _parsePositiveIntQuery(req.query.page, 1, { min: 1 });
    const limit = _parsePositiveIntQuery(req.query.limit, 50, { min: 1, max: 200 });
    const skip = (page - 1) * limit;

    const { rows, summary, diagnostics, sourceContactCount } = await _loadReporterDirectoryRows(req);
    const total = rows.length;
    const hasRealFilters = _hasRealReporterDirectoryFilters(diagnostics?.effectiveFilters);
    const shouldFallbackToFirstPage = !hasRealFilters && total > 0 && skip >= total;
    const effectivePage = shouldFallbackToFirstPage ? 1 : page;
    const effectiveSkip = shouldFallbackToFirstPage ? 0 : skip;
    const items = rows.slice(effectiveSkip, effectiveSkip + limit);
    const stats = _buildReporterDirectoryStatsPayload(summary);

    _logReporterContactListShapeDiagnostics(req, items);

    if (_shouldLogReporterDirectorySourceCounts(req)) {
      const sourceCounts = await _getReporterDirectorySourceCounts(sourceContactCount, total);
      console.log('[reporter-contacts] source counts', sourceCounts);
    }

    _logLocalDirectoryDiagnostics(req, {
      routePath: req.originalUrl || `${req.baseUrl || ''}${req.path || ''}` || '/api/admin/community-reporter/contacts',
      dbName: mongoose?.connection?.name || null,
      queryParamsReceived: req.query || {},
      defaultLimit: 50,
      defaultPage: 1,
      normalizedPagination: {
        page,
        limit,
        effectivePage,
        effectiveSkip,
      },
      usedFirstPageFallback: shouldFallbackToFirstPage,
      filtersReceived: {
        q: req.query?.q || req.query?.search || null,
        status: req.query?.status || null,
        verification: req.query?.verification || null,
        reporterType: req.query?.reporterType || req.query?.type || null,
        state: req.query?.state || null,
        district: req.query?.district || null,
        city: req.query?.city || null,
        country: req.query?.country || null,
        includeArchived: req.query?.includeArchived || null,
        missingPhone: req.query?.missingPhone || null,
        missingLocation: req.query?.missingLocation || null,
      },
      effectiveFilters: diagnostics?.effectiveFilters,
      totalRowsReturned: total,
      skippedRows: diagnostics?.skipped,
    });
    return res.status(200).json({ ok: true, success: true, items, total, page: effectivePage, limit, summary, stats });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contacts] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load reporter contacts' });
  }
}

async function getReporterContactDirectorySummary(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const { summary } = await _loadReporterDirectoryRows(req);
    const stats = _buildReporterDirectoryStatsPayload(summary);
    return res.status(200).json({ ok: true, success: true, summary, stats });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contacts-summary] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load reporter contact summary' });
  }
}

async function _loadReporterDirectoryContact(identifier) {
  if (!_isMongoReady()) return null;
  const lookup = await findReporterContactByIdentifier(identifier);
  if (lookup?.contact) {
    return lookup.contact.toObject ? lookup.contact.toObject() : lookup.contact;
  }
  if (_isValidObjectId(identifier)) {
    return ReporterContact.findById(identifier).lean();
  }
  return null;
}

function _buildReporterProfileContract(contact, profile, methods, tasks, activity, row, submissionStats, coverageAreas, beats) {
  const location = {
    city: _normalizeLocationText(contact?.cityTownVillage || profile?.location?.city || null),
    district: _normalizeLocationText(contact?.districtName || profile?.location?.districtCounty || null),
    state: _normalizeLocationText(contact?.stateName || profile?.location?.stateProvince || null),
    country: _normalizeLocationText(contact?.country || profile?.location?.country || null),
    area: _normalizeLocationText(contact?.areaName || profile?.location?.areaLocality || null),
  };
  const methodPhone = _extractMethodValue(methods, 'phone');
  const methodWhatsapp = _extractMethodValue(methods, 'whatsapp');
  const fullPhone = _firstDirectoryPhoneValue(contact?.phoneFull, contact?.phoneNumber, profile?.primaryPhone, methodPhone);
  const maskedPreview = _firstNonEmptyString(row?.phonePreview, row?.maskedPhone, _maskPhoneForDirectory(fullPhone));
  const phonePreview = _firstNonEmptyString(fullPhone, maskedPreview);
  const maskedPhone = fullPhone ? null : phonePreview;
  const resolvedPhone = _firstNonEmptyString(fullPhone, maskedPhone);
  const whatsappNumber = _firstDirectoryPhoneValue(contact?.whatsappNumber, methodWhatsapp);
  const alternatePhone = _normalizePhoneValue(contact?.alternatePhone || null);
  const verification = _normalizeVerificationForDirectory(contact?.verificationLevel || profile?.verificationTier || null) || 'community_default';
  const reporterType = _normalizeReporterTypeForDirectory(contact?.reporterType || null) || 'community';
  const status = _normalizeDirectoryStatus(contact?.status || profile?.status || null) || 'active';
  const directoryVisibility = _buildDirectoryVisibilityState(status);
  const flags = _buildDirectoryQualityFlags({
    phoneFull: fullPhone,
    verification,
    city: location.city,
    district: location.district,
    state: location.state,
    country: location.country,
    area: location.area,
  });
  const taskItems = Array.isArray(tasks) ? tasks.map((task) => ({
    id: String(task._id),
    title: _firstNonEmptyString(task.title),
    description: _firstNonEmptyString(task.description),
    status: _normalizeStatusToken(task.status) || 'open',
    dueAt: _toIsoOrNull(task.dueAt || null),
    nextFollowUpAt: _toIsoOrNull(task.nextFollowUpAt || null),
    assignedTo: _firstNonEmptyString(task.assignedTo),
    labels: Array.isArray(task.labels) ? task.labels.filter(Boolean) : [],
    archived: task.archived === true,
    createdAt: _toIsoOrNull(task.createdAt || null),
    updatedAt: _toIsoOrNull(task.updatedAt || null),
  })) : [];
  const activityItems = Array.isArray(activity) ? activity.map((item) => ({
    id: String(item._id),
    type: _normalizeStatusToken(item.type) || 'note',
    message: _firstNonEmptyString(item.message),
    actor: {
      kind: _firstNonEmptyString(item.actor?.kind) || 'system',
      email: _normalizeEmail(item.actor?.email || null),
      role: _firstNonEmptyString(item.actor?.role),
    },
    createdAt: _toIsoOrNull(item.createdAt || null),
  })) : [];
  const contactMethods = Array.isArray(methods) ? methods.map((method) => ({
    id: String(method._id),
    type: _normalizeStatusToken(method.type) || 'phone',
    value: _firstNonEmptyString(method.value),
    normalized: _firstNonEmptyString(method.normalized),
    isPrimary: method.isPrimary === true,
    status: _normalizeStatusToken(method.status) || 'active',
    source: _normalizeStatusToken(method.source) || 'system',
    verifiedAt: _toIsoOrNull(method.verifiedAt || null),
  })) : [];
  const coverageItems = Array.isArray(coverageAreas) ? coverageAreas.map((area) => ({
    id: area?._id ? String(area._id) : null,
    scope: _firstNonEmptyString(area?.coverageScope) || null,
    country: _normalizeLocationText(area?.country || null),
    state: _normalizeLocationText(area?.stateProvince || null),
    district: _normalizeLocationText(area?.districtCounty || null),
    city: _normalizeLocationText(area?.city || null),
    area: _normalizeLocationText(area?.areaLocality || null),
    isPrimary: area?.isPrimary === true,
    updatedAt: _toIsoOrNull(area?.updatedAt || null),
  })) : [];
  const beatItems = Array.isArray(beats)
    ? Array.from(new Set(beats.map((beat) => _normalizeBeatLabel(beat?.beat || beat)).filter(Boolean)))
    : [];
  const noteItems = activityItems.filter((item) => item.type === 'note');
  const profileStats = submissionStats?.stats || profile?.stats || {};
  const lastActivityAt = _toIsoOrNull(
    row?.lastActivityAt ||
    taskItems[0]?.updatedAt ||
    activityItems[0]?.createdAt ||
    profileStats.lastStoryAt ||
    contact?.updatedAt ||
    null
  );
  const resolvedCoverageScope = _firstNonEmptyString(profile?.coverageScope, coverageItems.find((area) => area && area.isPrimary)?.scope) || null;
  const primaryCoverage = coverageItems.find((area) => area && area.isPrimary) || {
    scope: resolvedCoverageScope,
    country: location.country,
    state: location.state,
    district: location.district,
    city: location.city,
    area: location.area,
    isPrimary: true,
  };
  const portal = {
    accessEnabled: contact?.portalAccessEnabled !== false,
    authVersion: typeof contact?.portalAuthVersion === 'number' ? contact.portalAuthVersion : 0,
    lastLoginAt: _toIsoOrNull(contact?.lastPortalLoginAt || null),
    pendingEmail: _normalizeEmail(contact?.pendingPortalEmail || null),
    pendingEmailRequestedAt: _toIsoOrNull(contact?.pendingPortalEmailRequestedAt || null),
  };
  const tabCounts = {
    stories: Number(row?.totalStories ?? profileStats.totalStories ?? 0),
    notes: noteItems.length + (_firstNonEmptyString(contact?.notes) ? 1 : 0),
    tasks: taskItems.length,
    activity: activityItems.length,
  };
  const overview = {
    reporterKey: _firstNonEmptyString(contact?.reporterKey, _normalizeEmail(contact?.email || profile?.primaryEmail || null)),
    reporterType,
    verification,
    status,
    directoryState: directoryVisibility.directoryState,
    isRemovedFromDirectory: directoryVisibility.isRemovedFromDirectory,
    isVisibleInDirectory: directoryVisibility.isVisibleInDirectory,
    portalAccessEnabled: portal.accessEnabled,
    primaryLocation: {
      city: location.city,
      district: location.district,
      state: location.state,
      country: location.country,
      area: location.area,
    },
    storyCounts: {
      total: Number(row?.totalStories ?? profileStats.totalStories ?? 0),
      approved: Number(row?.approvedStories ?? profileStats.approvedStories ?? 0),
      pending: Number(row?.pendingStories ?? profileStats.pendingStories ?? 0),
      rejected: Number(row?.rejectedStories ?? profileStats.rejectedStories ?? 0),
      withdrawn: Number(row?.withdrawnStories ?? profileStats.withdrawnStories ?? 0),
      published: Number(row?.publishedStories ?? profileStats.publishedStories ?? 0),
    },
    latestStoryAt: _toIsoOrNull(row?.lastStoryAt || profileStats.lastStoryAt || null),
    lastActivityAt,
  };
  const contactBlock = {
    name: _firstNonEmptyString(contact?.fullName, profile?.displayName, contact?.name),
    email: _normalizeEmail(contact?.email || profile?.primaryEmail || null),
    phone: resolvedPhone,
    fullPhone,
    maskedPhone,
    phonePreview,
    whatsapp: whatsappNumber,
    whatsappNumber,
    alternatePhone,
    notes: _firstNonEmptyString(contact?.notes),
    portal,
    portalAuth: portal.accessEnabled,
    authProvider: portal.authVersion > 0 ? 'reporter_portal' : null,
    lastPortalLogin: portal.lastLoginAt,
  };
  const coverage = {
    scope: resolvedCoverageScope,
    coverageScope: resolvedCoverageScope,
    coverageLanguage: Array.isArray(contact?.languages) && contact.languages.length ? contact.languages[0] : null,
    coverageLanguages: Array.isArray(contact?.languages) ? contact.languages.filter(Boolean) : [],
    areaType: _firstNonEmptyString(contact?.areaType) || null,
    primaryBeat: _normalizeBeatLabel(contact?.primaryBeat || null),
    beats: beatItems,
    primary: primaryCoverage,
    areas: coverageItems,
    organization: _firstNonEmptyString(contact?.organisationName),
    organisationName: _firstNonEmptyString(contact?.organisationName),
    position: _firstNonEmptyString(contact?.positionTitle, contact?.roleOrTitle),
    positionTitle: _firstNonEmptyString(contact?.positionTitle),
    specialization: Array.isArray(contact?.interests) ? contact.interests.filter(Boolean) : [],
    assignments: Array.isArray(profile?.labels) ? profile.labels.filter(Boolean) : [],
  };

  return {
    id: String(contact?._id),
    displayName: _firstNonEmptyString(contact?.fullName, profile?.displayName, contact?.name),
    name: _firstNonEmptyString(contact?.fullName, profile?.displayName, contact?.name),
    email: _normalizeEmail(contact?.email || profile?.primaryEmail || null),
    reporterKey: _firstNonEmptyString(contact?.reporterKey, _normalizeEmail(contact?.email || profile?.primaryEmail || null)),
    phone: resolvedPhone,
    maskedPhone,
    phonePreview,
    fullPhone,
    whatsapp: whatsappNumber,
    whatsappNumber,
    alternatePhone,
    contact: contactBlock,
    location,
    area: location.area,
    areaType: _firstNonEmptyString(contact?.areaType) || null,
    primaryBeat: _normalizeBeatLabel(contact?.primaryBeat || null),
    beats: beatItems,
    reporterType,
    verification,
    status,
    directoryState: directoryVisibility.directoryState,
    isRemovedFromDirectory: directoryVisibility.isRemovedFromDirectory,
    isVisibleInDirectory: directoryVisibility.isVisibleInDirectory,
    directory: {
      state: directoryVisibility.directoryState,
      status,
      isRemovedFromDirectory: directoryVisibility.isRemovedFromDirectory,
      isVisibleInDirectory: directoryVisibility.isVisibleInDirectory,
      removedAt: _toIsoOrNull(contact?.archivedAt || null),
      removedBy: _firstNonEmptyString(contact?.archivedBy),
      canRemoveFromDirectory: directoryVisibility.isRemovedFromDirectory !== true,
      canRestore: directoryVisibility.isRemovedFromDirectory,
      canDeletePermanently: directoryVisibility.isRemovedFromDirectory,
      softRemoveRoute: contact?._id ? `/api/admin/community-reporter/contacts/${String(contact._id)}/remove-from-directory` : null,
      restoreRoute: contact?._id ? `/api/admin/community-reporter/contacts/${String(contact._id)}/restore` : null,
      permanentDeleteRoute: contact?._id ? `/api/admin/community-reporter/contacts/${String(contact._id)}/permanent-delete` : null,
    },
    portal,
    organisationName: _firstNonEmptyString(contact?.organisationName),
    organisationType: _firstNonEmptyString(contact?.organisationType),
    positionTitle: _firstNonEmptyString(contact?.positionTitle),
    roleOrTitle: _firstNonEmptyString(contact?.roleOrTitle),
    languages: Array.isArray(contact?.languages) ? contact.languages.filter(Boolean) : [],
    interests: Array.isArray(contact?.interests) ? contact.interests.filter(Boolean) : [],
    websiteOrPortfolio: _firstNonEmptyString(contact?.websiteOrPortfolio),
    overview,
    coverage,
    flags: {
      missingPhone: flags.missingPhone,
      missingLocation: flags.missingLocation,
      needsVerification: flags.needsVerification,
    },
    stats: {
      totalStories: Number(row?.totalStories ?? profileStats.totalStories ?? 0),
      approvedStories: Number(row?.approvedStories ?? profileStats.approvedStories ?? 0),
      pendingStories: Number(row?.pendingStories ?? profileStats.pendingStories ?? 0),
      rejectedStories: Number(row?.rejectedStories ?? profileStats.rejectedStories ?? 0),
      withdrawnStories: Number(row?.withdrawnStories ?? profileStats.withdrawnStories ?? 0),
      publishedStories: Number(row?.publishedStories ?? profileStats.publishedStories ?? 0),
      firstStoryAt: _toIsoOrNull(contact?.stats?.firstStoryAt || null),
      lastStoryAt: _toIsoOrNull(row?.lastStoryAt || profileStats.lastStoryAt || null),
      lastSubmissionAt: _toIsoOrNull(row?.lastSubmissionAt || contact?.stats?.lastSubmissionAt || profileStats.lastStoryAt || null),
      lastStoryTitle: _firstNonEmptyString(row?.lastStoryTitle, contact?.stats?.lastStoryTitle, profileStats.lastStoryTitle),
    },
    profile: profile ? {
      id: String(profile._id),
      status: _normalizeStatusToken(profile.status) || 'active',
      verificationTier: _normalizeStatusToken(profile.verificationTier) || null,
      coverageScope: _normalizeStatusToken(profile.coverageScope) || null,
      labels: Array.isArray(profile.labels) ? profile.labels.filter(Boolean) : [],
      flags: Array.isArray(profile.flags) ? profile.flags.filter(Boolean) : [],
      mergedIntoProfileId: profile.mergedIntoProfileId ? String(profile.mergedIntoProfileId) : null,
      createdAt: _toIsoOrNull(profile.createdAt || null),
      updatedAt: _toIsoOrNull(profile.updatedAt || null),
    } : null,
    contactMethods,
    noteItems,
    tasks: taskItems,
    activity: activityItems,
    tabCounts,
    tabs: {
      overview: true,
      contact: true,
      coverage: true,
      stories: true,
      notes: true,
      tasks: true,
      activity: true,
    },
    links: {
      stories: contact?._id ? `/api/admin/community-reporter/contacts/${String(contact._id)}/stories` : null,
    },
    lastActivityAt,
    manualOverrideUpdatedAt: _summarizeManualOverrideState(contact?.directoryManualOverrides || null)?.updatedAt || null,
    createdAt: _toIsoOrNull(contact?.createdAt || null),
    updatedAt: _toIsoOrNull(contact?.updatedAt || null),
  };
}

async function _buildReporterDrawerPayload(contact) {
  const profileQuery = ReporterProfile.findOne({ $or: [{ reporterContactId: contact._id }, { primaryEmail: _normalizeEmail(contact.email || null) }] }).lean();
  const submissionStatsPromise = deriveReporterStatsFromSubmissionsByEmail(contact.email || null).catch(() => null);
  const profile = await profileQuery;

  const [methods, tasks, activity, submissionStats, coverageAreas, beats] = await Promise.all([
    profile ? ReporterContactMethod.find({ profileId: profile._id }).sort({ isPrimary: -1, createdAt: -1 }).lean() : Promise.resolve([]),
    profile ? ReporterTask.find({ profileId: profile._id, archived: { $ne: true } }).sort({ updatedAt: -1 }).limit(20).lean() : Promise.resolve([]),
    profile ? ReporterActivityLog.find({ profileId: profile._id }).sort({ createdAt: -1 }).limit(20).lean() : Promise.resolve([]),
    submissionStatsPromise,
    profile ? ReporterCoverage.find({ profileId: profile._id }).sort({ isPrimary: -1, updatedAt: -1 }).lean() : Promise.resolve([]),
    profile ? ReporterBeat.find({ profileId: profile._id }).sort({ createdAt: -1 }).lean() : Promise.resolve([]),
  ]);

  const row = _buildCompactDirectoryRow(contact, submissionStats?.stats || null);
  if (row) {
    row.id = row.id || (contact?._id ? String(contact._id) : null);
    row._id = row._id || row.id || null;
    row.contactId = row.contactId || row.id || null;
    row.reporterContactId = row.reporterContactId || row.id || null;
    row.phone = row.fullPhone || null;
    row.phonePreview = row.fullPhone || row.maskedPhone || _maskPhoneForDirectory(row.fullPhone || null);
    row.maskedPhone = row.fullPhone ? null : (row.maskedPhone || _maskPhoneForDirectory(row.fullPhone || null));
  }
  const profileContract = _buildReporterProfileContract(contact, profile, methods, tasks, activity, row, submissionStats, coverageAreas, beats);
  return { row, profile: profileContract };
}

async function getReporterContactDetail(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const contact = await _loadReporterDirectoryContact(String(req.params.id || '').trim());
    if (!contact) {
      return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
    }

    const payload = await _buildReporterDrawerPayload(contact);
    const methodPhone = _extractMethodValue(payload?.profile?.contactMethods, 'phone');
    const methodWhatsapp = _extractMethodValue(payload?.profile?.contactMethods, 'whatsapp');
    _logAdminProfilePhoneDiagnostics(req, {
      reporterId: payload?.row?.id || String(contact?._id || ''),
      email: payload?.row?.email || _normalizeEmail(contact?.email || null),
      dbPhone: _normalizePhoneValue(contact?.phoneFull || null),
      dbPhoneNumber: _normalizePhoneValue(contact?.phoneNumber || null),
      dbMobile: _normalizePhoneValue(contact?.mobile || contact?.mobileNumber || contact?.contactNumber || contact?.reporterPhone || contact?.reporterMobile || null),
      dbContactNumber: _normalizePhoneValue(contact?.contactNumber || null),
      dbWhatsapp: _normalizePhoneValue(contact?.whatsapp || contact?.whatsappNumber || null),
      dbAlternatePhone: _normalizePhoneValue(contact?.alternatePhone || null),
      dbMethodPhone: _normalizePhoneValue(methodPhone || null),
      dbMethodWhatsapp: _normalizePhoneValue(methodWhatsapp || null),
      dbPrimaryPhone: _normalizePhoneValue(payload?.profile?.profile?.primaryPhone || null),
      dbMaskedPhone: _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null),
      dbPhonePreview: _firstNonEmptyString(payload?.row?.phonePreview, payload?.row?.maskedPhone, _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null)),
      listPhonePreview: _firstNonEmptyString(payload?.row?.phonePreview, payload?.row?.maskedPhone),
      responsePhone: _normalizeKnownPhoneValue(payload?.profile?.contact?.phone || payload?.profile?.phone || payload?.row?.phone || null),
      responseWhatsapp: _normalizePhoneValue(payload?.profile?.contact?.whatsapp || payload?.profile?.whatsapp || payload?.profile?.whatsappNumber || null),
      responseMaskedPhone: _firstNonEmptyString(payload?.profile?.contact?.maskedPhone, payload?.profile?.maskedPhone, payload?.row?.maskedPhone),
      responsePhonePreview: _firstNonEmptyString(payload?.profile?.contact?.phonePreview, payload?.profile?.phonePreview, payload?.profile?.contact?.maskedPhone, payload?.profile?.maskedPhone),
      phoneDropped: !!_firstNonEmptyString(_firstDirectoryPhoneValue(contact?.phoneFull, contact?.phoneNumber, contact?.mobile, contact?.mobileNumber, contact?.contactNumber, contact?.reporterPhone, contact?.reporterMobile, payload?.profile?.profile?.primaryPhone, methodPhone), _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null), payload?.row?.maskedPhone, payload?.row?.phone) && !_normalizeKnownPhoneValue(payload?.profile?.contact?.phone || payload?.profile?.phone || payload?.profile?.contact?.maskedPhone || payload?.profile?.maskedPhone || payload?.profile?.contact?.phonePreview || payload?.profile?.phonePreview || null),
      whatsappDropped: !!_firstDirectoryPhoneValue(contact?.whatsapp, contact?.whatsappNumber, methodWhatsapp) && !_normalizePhoneValue(payload?.profile?.contact?.whatsapp || payload?.profile?.whatsapp || payload?.profile?.whatsappNumber || null),
    });
    _logCompareListVsProfileDiagnostics(req, {
      reporterId: payload?.row?.id || payload?.profile?.id || String(contact?._id || ''),
      email: payload?.profile?.email || payload?.row?.email || _normalizeEmail(contact?.email || null),
      dbPhone: _normalizePhoneValue(contact?.phoneFull || contact?.phoneNumber || null),
      dbMaskedPhone: _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null),
      listPhonePreview: _firstNonEmptyString(payload?.row?.maskedPhone, payload?.row?.phone),
      profilePhone: _firstNonEmptyString(payload?.profile?.contact?.phone, payload?.profile?.phone),
      profileMaskedPhone: _firstNonEmptyString(payload?.profile?.contact?.maskedPhone, payload?.profile?.maskedPhone),
    });
    _logAdminDrawerDiagnostics(req, {
      reporterId: payload?.profile?.id || payload?.row?.id || String(contact?._id || ''),
      email: payload?.profile?.email || payload?.row?.email || _normalizeEmail(contact?.email || null),
      hasPhone: !!_normalizeKnownPhoneValue(payload?.profile?.contact?.phone || payload?.profile?.phone || payload?.profile?.contact?.maskedPhone || payload?.profile?.maskedPhone || payload?.profile?.contact?.phonePreview || payload?.profile?.phonePreview || null),
      hasWhatsapp: !!_normalizePhoneValue(payload?.profile?.contact?.whatsapp || payload?.profile?.whatsappNumber || null),
      city: payload?.profile?.location?.city || null,
      state: payload?.profile?.location?.state || null,
      coverageScope: payload?.profile?.coverage?.scope || null,
      storiesCount: payload?.profile?.tabCounts?.stories || 0,
      approvedCount: payload?.profile?.overview?.storyCounts?.approved || payload?.profile?.stats?.approvedStories || 0,
      pendingCount: payload?.profile?.overview?.storyCounts?.pending || payload?.profile?.stats?.pendingStories || 0,
      notesCount: payload?.profile?.tabCounts?.notes || 0,
      tasksCount: payload?.profile?.tabCounts?.tasks || 0,
      activityCount: payload?.profile?.tabCounts?.activity || 0,
      fieldPresence: _buildFieldPresenceMap(payload?.profile),
    });
    return res.status(200).json({ success: true, item: payload.row, profile: payload.profile });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contact-detail] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load reporter contact detail' });
  }
}

async function getReporterContactProfile(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const contact = await _loadReporterDirectoryContact(String(req.params.id || '').trim());
    if (!contact) {
      return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
    }

    const payload = await _buildReporterDrawerPayload(contact);
    const methodPhone = _extractMethodValue(payload?.profile?.contactMethods, 'phone');
    const methodWhatsapp = _extractMethodValue(payload?.profile?.contactMethods, 'whatsapp');
    _logAdminProfilePhoneDiagnostics(req, {
      reporterId: payload?.profile?.id || String(contact?._id || ''),
      email: payload?.profile?.email || _normalizeEmail(contact?.email || null),
      dbPhone: _normalizePhoneValue(contact?.phoneFull || null),
      dbPhoneNumber: _normalizePhoneValue(contact?.phoneNumber || null),
      dbMobile: _normalizePhoneValue(contact?.mobile || contact?.mobileNumber || contact?.contactNumber || contact?.reporterPhone || contact?.reporterMobile || null),
      dbContactNumber: _normalizePhoneValue(contact?.contactNumber || null),
      dbWhatsapp: _normalizePhoneValue(contact?.whatsapp || contact?.whatsappNumber || null),
      dbAlternatePhone: _normalizePhoneValue(contact?.alternatePhone || null),
      dbMethodPhone: _normalizePhoneValue(methodPhone || null),
      dbMethodWhatsapp: _normalizePhoneValue(methodWhatsapp || null),
      dbPrimaryPhone: _normalizePhoneValue(payload?.profile?.profile?.primaryPhone || null),
      dbMaskedPhone: _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null),
      dbPhonePreview: _firstNonEmptyString(payload?.row?.phonePreview, payload?.row?.maskedPhone, _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null)),
      listPhonePreview: _firstNonEmptyString(payload?.row?.phonePreview, payload?.row?.maskedPhone),
      responsePhone: _normalizeKnownPhoneValue(payload?.profile?.contact?.phone || payload?.profile?.phone || null),
      responseWhatsapp: _normalizePhoneValue(payload?.profile?.contact?.whatsapp || payload?.profile?.whatsapp || payload?.profile?.whatsappNumber || null),
      responseMaskedPhone: _firstNonEmptyString(payload?.profile?.contact?.maskedPhone, payload?.profile?.maskedPhone),
      responsePhonePreview: _firstNonEmptyString(payload?.profile?.contact?.phonePreview, payload?.profile?.phonePreview, payload?.profile?.contact?.maskedPhone, payload?.profile?.maskedPhone),
      phoneDropped: !!_firstNonEmptyString(_firstDirectoryPhoneValue(contact?.phoneFull, contact?.phoneNumber, contact?.mobile, contact?.mobileNumber, contact?.contactNumber, contact?.reporterPhone, contact?.reporterMobile, payload?.profile?.profile?.primaryPhone, methodPhone), _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null), payload?.row?.maskedPhone, payload?.row?.phone) && !_normalizeKnownPhoneValue(payload?.profile?.contact?.phone || payload?.profile?.phone || payload?.profile?.contact?.maskedPhone || payload?.profile?.maskedPhone || payload?.profile?.contact?.phonePreview || payload?.profile?.phonePreview || null),
      whatsappDropped: !!_firstDirectoryPhoneValue(contact?.whatsapp, contact?.whatsappNumber, methodWhatsapp) && !_normalizePhoneValue(payload?.profile?.contact?.whatsapp || payload?.profile?.whatsapp || payload?.profile?.whatsappNumber || null),
    });
    _logCompareListVsProfileDiagnostics(req, {
      reporterId: payload?.row?.id || payload?.profile?.id || String(contact?._id || ''),
      email: payload?.profile?.email || payload?.row?.email || _normalizeEmail(contact?.email || null),
      dbPhone: _normalizePhoneValue(contact?.phoneFull || contact?.phoneNumber || null),
      dbMaskedPhone: _maskPhoneForDirectory(contact?.phoneFull || contact?.phoneNumber || null),
      listPhonePreview: _firstNonEmptyString(payload?.row?.maskedPhone, payload?.row?.phone),
      profilePhone: _firstNonEmptyString(payload?.profile?.contact?.phone, payload?.profile?.phone),
      profileMaskedPhone: _firstNonEmptyString(payload?.profile?.contact?.maskedPhone, payload?.profile?.maskedPhone),
    });
    _logAdminDrawerDiagnostics(req, {
      reporterId: payload?.profile?.id || String(contact?._id || ''),
      email: payload?.profile?.email || _normalizeEmail(contact?.email || null),
      hasPhone: !!_normalizeKnownPhoneValue(payload?.profile?.contact?.phone || payload?.profile?.phone || payload?.profile?.contact?.maskedPhone || payload?.profile?.maskedPhone || payload?.profile?.contact?.phonePreview || payload?.profile?.phonePreview || null),
      hasWhatsapp: !!_normalizePhoneValue(payload?.profile?.contact?.whatsapp || payload?.profile?.whatsappNumber || null),
      city: payload?.profile?.location?.city || null,
      state: payload?.profile?.location?.state || null,
      coverageScope: payload?.profile?.coverage?.scope || null,
      storiesCount: payload?.profile?.tabCounts?.stories || 0,
      approvedCount: payload?.profile?.overview?.storyCounts?.approved || payload?.profile?.stats?.approvedStories || 0,
      pendingCount: payload?.profile?.overview?.storyCounts?.pending || payload?.profile?.stats?.pendingStories || 0,
      notesCount: payload?.profile?.tabCounts?.notes || 0,
      tasksCount: payload?.profile?.tabCounts?.tasks || 0,
      activityCount: payload?.profile?.tabCounts?.activity || 0,
      fieldPresence: _buildFieldPresenceMap(payload?.profile),
    });
    return res.status(200).json({ success: true, profile: payload.profile });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contact-profile] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load reporter contact profile' });
  }
}

function _applyDirectoryManualUpdateToContact(contact, payload, actor) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const overrideReason = _firstNonEmptyString(body.overrideReason, body.reason, 'admin_update');
  const now = new Date();
  const next = contact || {};
  const nextOverrides = next.directoryManualOverrides && typeof next.directoryManualOverrides === 'object'
    ? { ...next.directoryManualOverrides }
    : {};

  const specs = [
    { keys: ['name', 'fullName'], target: 'fullName', normalize: _firstNonEmptyString, overrideKey: 'fullName' },
    { keys: ['email'], target: 'email', normalize: _normalizeEmail, after: (target, value) => { target.emailLower = value; }, overrideKey: 'email' },
    { keys: ['phone', 'fullPhone', 'phoneFull'], target: 'phoneFull', normalize: _normalizePhoneValue, after: (target, value) => { target.phoneNumber = value; }, overrideKey: 'phoneFull' },
    { keys: ['whatsapp', 'whatsappNumber'], target: 'whatsappNumber', normalize: _normalizePhoneValue, overrideKey: 'whatsappNumber' },
    { keys: ['alternatePhone'], target: 'alternatePhone', normalize: _normalizePhoneValue, overrideKey: 'alternatePhone' },
    { keys: ['city'], target: 'cityTownVillage', normalize: _normalizeLocationText, overrideKey: 'cityTownVillage' },
    { keys: ['district'], target: 'districtName', normalize: _normalizeLocationText, overrideKey: 'districtName' },
    { keys: ['state'], target: 'stateName', normalize: _normalizeLocationText, overrideKey: 'stateName' },
    { keys: ['country'], target: 'country', normalize: _normalizeLocationText, overrideKey: 'country' },
    { keys: ['area', 'areaName'], target: 'areaName', normalize: _normalizeLocationText, overrideKey: 'areaName' },
    { keys: ['beat', 'primaryBeat'], target: 'primaryBeat', normalize: _normalizeBeatLabel, overrideKey: 'primaryBeat' },
    { keys: ['verification', 'verificationLevel'], target: 'verificationLevel', normalize: _normalizeVerificationInput, overrideKey: 'verificationLevel' },
    { keys: ['reporterType', 'type'], target: 'reporterType', normalize: _normalizeReporterTypeForDirectory, overrideKey: 'reporterType' },
    { keys: ['status'], target: 'status', normalize: _normalizeDirectoryStatus, overrideKey: 'status' },
    { keys: ['notes'], target: 'notes', normalize: _firstNonEmptyString, overrideKey: 'notes' },
  ];

  for (const spec of specs) {
    const raw = spec.keys.map((key) => body[key]).find((value) => value !== undefined);
    if (raw === undefined) continue;
    const normalized = spec.normalize(raw);
    next[spec.target] = normalized;
    if (typeof spec.after === 'function') spec.after(next, normalized);
    nextOverrides[spec.overrideKey] = {
      enabled: true,
      source: 'admin',
      reason: overrideReason,
      updatedAt: now,
      updatedBy: _firstNonEmptyString(actor?.email, actor?.id, actor?.name, 'admin'),
    };
  }

  next.directoryManualOverrides = nextOverrides;
  return next;
}

async function updateReporterContactDirectoryProfile(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const id = String(req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) {
      return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
    }

    const nextContact = _applyDirectoryManualUpdateToContact({ ...contact }, req.body, req.admin || { email: actor });
    const set = {
      fullName: nextContact.fullName,
      email: nextContact.email,
      emailLower: nextContact.emailLower,
      phoneFull: nextContact.phoneFull,
      phoneNumber: nextContact.phoneNumber,
      whatsappNumber: nextContact.whatsappNumber,
      alternatePhone: nextContact.alternatePhone,
      cityTownVillage: nextContact.cityTownVillage,
      districtName: nextContact.districtName,
      stateName: nextContact.stateName,
      country: nextContact.country,
      areaName: nextContact.areaName,
      primaryBeat: nextContact.primaryBeat,
      verificationLevel: nextContact.verificationLevel,
      reporterType: nextContact.reporterType,
      status: nextContact.status,
      notes: nextContact.notes,
      directoryManualOverrides: nextContact.directoryManualOverrides,
      updatedAt: new Date(),
    };

    Object.keys(set).forEach((key) => set[key] === undefined && delete set[key]);

    if (!Object.keys(set).length) {
      return _jsonError(res, 400, { code: 'NO_UPDATES', message: 'No supported fields supplied for update' });
    }

    await ReporterContact.updateOne({ _id: id }, { $set: set });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DIRECTORY_UPDATE', id, { entity: 'ReporterContact', fields: Object.keys(set), overrideReason: _firstNonEmptyString(req.body?.overrideReason, req.body?.reason, 'admin_update') });

    const fresh = await ReporterContact.findById(id).lean();
    const payload = await _buildReporterDrawerPayload(fresh);
    return res.status(200).json({ success: true, item: payload.row, profile: payload.profile });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contact-update] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to update reporter contact' });
  }
}

// GET /api/admin/community-reporter/contacts/:id/stories
async function adminListReporterContactStories(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const id = String(req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Reporter contact not found' });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const or = _buildSubmissionMatchForContact(contact);
    if (!or.length) {
      return res.status(200).json({ success: true, items: [], total: 0, page, limit });
    }

    const safetyFilter = {
      $or: [
        { sourceType: { $in: ['community', 'journalist'] } },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };

    const filter = { $and: [{ $or: or }, { isDeleted: { $ne: true } }, safetyFilter] };

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    const items = docs.map(d => ({
      id: String(d._id),
      referenceId: d.referenceId || null,
      headline: d.headline || '',
      category: d.category || null,
      status: d.status || null,
      approvalState: _deriveApprovalState(d.status),
      location: d.location || d.locationDetail || null,
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
      reporterId: d.reporterId ? String(d.reporterId) : null,
      reporterEmail: d.reporterEmailNorm || d.reporterEmail || d.email || (d.contact && d.contact.email) || null,
      reporterName: d.reporterName || d.name || (d.contact && d.contact.name) || null,
    }));

    return res.status(200).json({ success: true, items, total, page, limit });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contact-stories] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
}

// POST /api/admin/community-reporter/contacts/backfill
// Founder/Admin only: backfill ReporterContact directory from existing CommunitySubmission docs.
async function backfillReporterContactsFromSubmissions(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const limitRaw = parseInt((req.body && req.body.limit) || req.query.limit || '5000', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50000) : 5000;
    const dryRun = _parseBool((req.body && req.body.dryRun) || req.query.dryRun);

    // Match community submissions (older docs may not have sourceType)
    const matchCommunity = {
      isDeleted: { $ne: true },
      $or: [
        { sourceType: 'community' },
        { source: 'community' },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };

    const approvedNorm = ['approved', 'published', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app', 'approvedok'];
    const pendingNorm = ['new', 'pending', 'under_review', 'underreview', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'pendingfounder', 'under-review'];

    // One aggregation to get scan counts + reporter groups
    const epoch = new Date(0);
    const facetPipeline = [
      { $match: matchCommunity },
      {
        $addFields: {
          _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
          _nameRaw: { $ifNull: ['$reporterName', { $ifNull: ['$name', '$contact.name'] }] },
          _headlineRaw: { $ifNull: ['$headline', ''] },
          _phoneRaw: {
            $ifNull: [
              '$contact.phone',
              { $ifNull: ['$phone', { $ifNull: ['$phoneNumber', { $ifNull: ['$mobile', { $ifNull: ['$mobileNumber', { $ifNull: ['$contactNumber', { $ifNull: ['$reporterPhone', '$reporterMobile'] }] }] }] }] }] },
            ],
          },
          _mobileRaw: { $ifNull: ['$mobile', { $ifNull: ['$mobileNumber', { $ifNull: ['$reporterMobile', '$contactNumber'] }] }] },
          _whatsappRaw: { $ifNull: ['$contact.whatsappNumber', { $ifNull: ['$whatsappNumber', '$whatsapp'] }] },
          _cityRaw: { $ifNull: ['$location.city', { $ifNull: ['$locationDetail.city', '$city'] }] },
          _districtRaw: { $ifNull: ['$locationDetail.district', '$district'] },
          _stateRaw: { $ifNull: ['$location.state', { $ifNull: ['$locationDetail.state', '$state'] }] },
          _countryRaw: { $ifNull: ['$location.country', { $ifNull: ['$locationDetail.country', '$country'] }] },
          _statusRaw: { $ifNull: ['$status', ''] },
        },
      },
      {
        $addFields: {
          emailNorm: {
            $cond: [
              { $or: [{ $eq: ['$_emailRaw', null] }, { $eq: ['$_emailRaw', ''] }] },
              null,
              { $toLower: { $trim: { input: { $toString: '$_emailRaw' } } } },
            ],
          },
          nameNorm: {
            $cond: [
              { $or: [{ $eq: ['$_nameRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_nameRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_nameRaw' } } },
            ],
          },
          headlineNorm: {
            $cond: [
              { $or: [{ $eq: ['$_headlineRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_headlineRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_headlineRaw' } } },
            ],
          },
          phoneNorm: {
            $cond: [
              { $or: [{ $eq: ['$_phoneRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_phoneRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_phoneRaw' } } },
            ],
          },
          cityNorm: {
            $cond: [
              { $or: [{ $eq: ['$_cityRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_cityRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_cityRaw' } } },
            ],
          },
          districtNorm: {
            $cond: [
              { $or: [{ $eq: ['$_districtRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_districtRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_districtRaw' } } },
            ],
          },
          stateNorm: {
            $cond: [
              { $or: [{ $eq: ['$_stateRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_stateRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_stateRaw' } } },
            ],
          },
          countryNorm: {
            $cond: [
              { $or: [{ $eq: ['$_countryRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_countryRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_countryRaw' } } },
            ],
          },
          statusNorm: { $toLower: { $trim: { input: { $toString: '$_statusRaw' } } } },
        },
      },
      {
        $facet: {
          scanned: [{ $count: 'scannedSubmissions' }],
          skippedNoEmail: [
            { $match: { emailNorm: null } },
            { $count: 'skippedNoEmail' },
          ],
          reporters: [
            { $match: { emailNorm: { $ne: null } } },
            {
              $group: {
                _id: '$emailNorm',
                totalStories: { $sum: 1 },
                approvedStories: { $sum: { $cond: [{ $in: ['$statusNorm', approvedNorm] }, 1, 0] } },
                pendingStories: { $sum: { $cond: [{ $in: ['$statusNorm', pendingNorm] }, 1, 0] } },
                lastStoryAt: { $max: '$createdAt' },

                // Latest non-empty values
                namePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$nameNorm', null] },
                      { ts: '$createdAt', v: '$nameNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                phonePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$phoneNorm', null] },
                      { ts: '$createdAt', v: '$phoneNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                mobilePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$_mobileRaw', null] },
                      { ts: '$createdAt', v: '$_mobileRaw' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                whatsappPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$_whatsappRaw', null] },
                      { ts: '$createdAt', v: '$_whatsappRaw' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                cityPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$cityNorm', null] },
                      { ts: '$createdAt', v: '$cityNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                districtPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$districtNorm', null] },
                      { ts: '$createdAt', v: '$districtNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                statePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$stateNorm', null] },
                      { ts: '$createdAt', v: '$stateNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                countryPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$countryNorm', null] },
                      { ts: '$createdAt', v: '$countryNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                headlinePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$headlineNorm', null] },
                      { ts: '$createdAt', v: '$headlineNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
              },
            },
            { $sort: { totalStories: -1 } },
            { $limit: limit },
          ],
        },
      },
    ];

    const facetResArr = await CommunitySubmissionModel.aggregate(facetPipeline);
    const facetRes = Array.isArray(facetResArr) && facetResArr.length ? facetResArr[0] : {};
    const scannedSubmissions = Number(facetRes?.scanned?.[0]?.scannedSubmissions || 0);
    const skippedNoEmail = Number(facetRes?.skippedNoEmail?.[0]?.skippedNoEmail || 0);
    const reporters = Array.isArray(facetRes?.reporters) ? facetRes.reporters : [];
    const uniqueReporters = reporters.length;

    let upserted = 0;
    if (!dryRun && reporters.length) {
      for (const r of reporters) {
        const email = String(r._id || '').trim().toLowerCase();
        const headline = r.headlinePick && r.headlinePick.v ? String(r.headlinePick.v).trim() : '';
        const name = r.namePick && r.namePick.v ? String(r.namePick.v).trim() : '';
        const phone = r.phonePick && r.phonePick.v ? String(r.phonePick.v).trim() : '';
        const mobile = r.mobilePick && r.mobilePick.v ? String(r.mobilePick.v).trim() : '';
        const whatsapp = r.whatsappPick && r.whatsappPick.v ? String(r.whatsappPick.v).trim() : '';
        const city = r.cityPick && r.cityPick.v ? String(r.cityPick.v).trim() : '';
        const district = r.districtPick && r.districtPick.v ? String(r.districtPick.v).trim() : '';
        let state = r.statePick && r.statePick.v ? String(r.statePick.v).trim() : '';
        let country = r.countryPick && r.countryPick.v ? String(r.countryPick.v).trim() : '';

        // If older docs stored "City, State" into city, split it.
        let cityOut = city;
        if (cityOut && cityOut.includes(',') && !state) {
          const parts = cityOut.split(',').map(s => s.trim()).filter(Boolean);
          cityOut = parts[0] || cityOut;
          state = parts[1] || state;
          if (!country) country = parts[2] || country;
        }

        await upsertReporterContact({
          name: name || 'Unknown',
          email,
          phone: phone || mobile || null,
          whatsapp: whatsapp || null,
          city: cityOut || null,
          district: district || null,
          state: state || null,
          country: country || null,
          reporterType: 'community',
          verificationLevel: 'community_default',
          stats: {
            totalStories: Number(r.totalStories || 0),
            approvedStories: Number(r.approvedStories || 0),
            pendingStories: Number(r.pendingStories || 0),
            lastStoryAt: r.lastStoryAt || null,
            lastStoryTitle: headline || null,
          },
        });
        upserted += 1;
      }
    }

    const profileDocs = await ReporterProfile.find({
      mergedIntoProfileId: null,
      $or: [
        { primaryEmail: { $exists: true, $ne: null } },
        { reporterContactId: { $exists: true, $ne: null } },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    let profileEnriched = 0;
    if (!dryRun && profileDocs.length) {
      for (const profile of profileDocs) {
        const email = _normalizeEmail(profile.primaryEmail || null);
        const existingContact = profile.reporterContactId ? await ReporterContact.findById(profile.reporterContactId).lean() : null;
        const sourceContact = existingContact || (email ? await ReporterContact.findOne({ $or: [{ emailLower: email }, { email }] }).lean() : null);

        if (!email && !sourceContact) continue;

        await upsertReporterContact({
          name: _firstNonEmptyString(sourceContact?.fullName, profile.displayName),
          email: email || sourceContact?.email || null,
          phone: sourceContact?.phoneFull || sourceContact?.phoneNumber || profile.primaryPhone || null,
          whatsapp: sourceContact?.whatsappNumber || null,
          alternatePhone: sourceContact?.alternatePhone || null,
          city: _firstNonEmptyString(sourceContact?.cityTownVillage, profile.location?.city),
          district: _firstNonEmptyString(sourceContact?.districtName, profile.location?.districtCounty),
          state: _firstNonEmptyString(sourceContact?.stateName, profile.location?.stateProvince),
          country: _firstNonEmptyString(sourceContact?.country, profile.location?.country),
          area: _firstNonEmptyString(sourceContact?.areaName, profile.location?.areaLocality),
          beat: sourceContact?.primaryBeat || null,
          reporterType: _normalizeReporterTypeForDirectory(sourceContact?.reporterType || null) || 'community',
          verificationLevel: _normalizeVerificationInput(sourceContact?.verificationLevel || profile.verificationTier || null) || undefined,
          stats: {
            totalStories: Number(sourceContact?.stats?.totalStories ?? profile.stats?.totalStories ?? 0),
            approvedStories: Number(sourceContact?.stats?.approvedStories ?? profile.stats?.approvedStories ?? 0),
            pendingStories: Number(sourceContact?.stats?.pendingStories ?? profile.stats?.pendingStories ?? 0),
            rejectedStories: Number(sourceContact?.stats?.rejectedStories ?? profile.stats?.rejectedStories ?? 0),
            withdrawnStories: Number(sourceContact?.stats?.withdrawnStories ?? profile.stats?.withdrawnStories ?? 0),
            publishedStories: Number(sourceContact?.stats?.publishedStories ?? profile.stats?.publishedStories ?? 0),
            lastStoryAt: sourceContact?.stats?.lastStoryAt || profile.stats?.lastStoryAt || null,
            lastStoryTitle: _firstNonEmptyString(sourceContact?.stats?.lastStoryTitle, profile.stats?.lastStoryTitle),
          },
        });
        profileEnriched += 1;
      }
    }

    const summaryDocs = await ReporterContact.find({ status: { $nin: ['archived', 'banned', 'deleted'] } })
      .select({
        fullName: 1,
        email: 1,
        phoneFull: 1,
        phoneNumber: 1,
        cityTownVillage: 1,
        districtName: 1,
        stateName: 1,
        country: 1,
        areaName: 1,
        primaryBeat: 1,
        reporterType: 1,
        verificationLevel: 1,
        status: 1,
        stats: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .lean();
    const summaryRows = summaryDocs.map((contact) => _buildCompactDirectoryRow(contact, null));
    const summary = _buildReporterDirectorySummaryPayload(summaryRows);

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_BACKFILL', null, {
      actor,
      limit,
      dryRun,
      scannedSubmissions,
      uniqueReporters,
      upserted,
      profileEnriched,
      skippedNoEmail,
    });

    return res.status(200).json({
      success: true,
      message: 'Backfill completed',
      processed: uniqueReporters,
      contactsCreatedOrUpdated: upserted,
      scannedSubmissions,
      uniqueReporters,
      upserted,
      profileEnriched,
      skippedNoEmail,
      summary,
      mergePriority: ['manual_override', 'reporter_profile', 'latest_valid_submission', 'older_fallback'],
    });
  } catch (e) {
    console.error('[ADMIN][backfillReporterContactsFromSubmissions] failed', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to backfill reporter contacts' });
  }
}

// DELETE /api/admin/community-reporter/stories/:storyId
async function deleteCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    }

    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) {
      return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });
    }

    // Safety: only allow deletes for community reporter submissions (sourceType community|journalist, or missing for legacy).
    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (_isSubmissionInDeletedState(doc)) {
      return res.status(200).json({
        ok: true,
        success: true,
        action: 'soft_delete',
        message: 'Story is already in Deleted',
        id,
        alreadyDeleted: true,
        isDeleted: true,
        affectsLiveSite: false,
        linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
        row: {
          id,
          isDeleted: true,
          canSoftDelete: false,
          canRestore: true,
          canPermanentDelete: true,
        },
      });
    }

    const now = new Date();
    const prev = doc.previousStatus || (doc.status && String(doc.status).trim().toLowerCase() !== 'deleted' && String(doc.status).trim().toLowerCase() !== 'trash' ? String(doc.status) : null);
    await CommunitySubmission.updateOne(
      { _id: id },
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
          deletedBy: actor,
          restoredAt: null,
          restoredBy: null,
          status: 'DELETED',
          ...(prev ? { previousStatus: prev } : {}),
        },
      }
    );

    console.log('[ADMIN_DELETE][community-story] soft-deleted', { actor, id, reporterId: doc.reporterId ? String(doc.reporterId) : null, email: doc.reporterEmailNorm || doc.reporterEmail || doc.email || null });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_SOFT_DELETE', id, { entity: 'CommunitySubmission' });

    return res.status(200).json({
      ok: true,
      success: true,
      action: 'soft_delete',
      message: 'Story moved to Deleted',
      id,
      isDeleted: true,
      deletedAt: now.toISOString(),
      affectsLiveSite: false,
      linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
      row: {
        id,
        isDeleted: true,
        canSoftDelete: false,
        canRestore: true,
        canPermanentDelete: true,
      },
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'SOFT_DELETE_FAILED', message: 'Failed to move story to Deleted' });
  }
}

// POST /api/admin/community-reporter/stories/:storyId/restore
async function restoreCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });

    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (!_isSubmissionInDeletedState(doc)) {
      return _jsonError(res, 409, { code: 'STORY_NOT_DELETED_YET', message: 'Story must be deleted before it can be restored' });
    }

    const now = new Date();
    const prev = doc.previousStatus && String(doc.previousStatus).trim() ? String(doc.previousStatus).trim() : null;
    const restoreStatus = prev && prev.toLowerCase() !== 'deleted' && prev.toLowerCase() !== 'trash' ? prev : 'NEW';

    await CommunitySubmission.updateOne(
      { _id: id },
      {
        $set: {
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          restoredAt: now,
          restoredBy: actor,
          status: restoreStatus,
        },
        $unset: { previousStatus: 1 },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_STORY_RESTORE', id, { entity: 'CommunitySubmission', restoredStatus: restoreStatus });
    return res.status(200).json({
      ok: true,
      success: true,
      action: 'restore',
      message: 'Story restored',
      id,
      isDeleted: false,
      restoredAt: now.toISOString(),
      status: restoreStatus,
      affectsLiveSite: false,
      linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
      row: {
        id,
        isDeleted: false,
        canSoftDelete: true,
        canRestore: false,
        canPermanentDelete: false,
      },
    });
  } catch (e) {
    console.error('[ADMIN][community-story][restore] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'RESTORE_FAILED', message: 'Failed to restore story' });
  }
}

// POST /api/admin/community-reporter/stories/:storyId/withdraw
// Withdraw is a workflow action (not delete): it removes a story from the active review flow
// without setting isDeleted=true. Soft delete/restore/permanent-delete remain separate.
async function withdrawCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });

    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (_isSubmissionInDeletedState(doc)) {
      return _jsonError(res, 409, { code: 'STORY_DELETED', message: 'Withdraw is not allowed for deleted stories (restore or permanent delete instead)' });
    }

    const current = String(doc.status || '').trim();
    if (current && current.toLowerCase() === 'withdrawn') {
      return res.status(200).json({ ok: true, success: true, action: 'withdraw', id, alreadyWithdrawn: true, isDeleted: false, status: 'WITHDRAWN', withdrawnAt: doc.withdrawnAt ? new Date(doc.withdrawnAt).toISOString() : null, affectsLiveSite: false });
    }

    const now = new Date();
    const prev = doc.previousStatus || (current && !['deleted', 'trash', 'withdrawn'].includes(current.toLowerCase()) ? current : null);
    await CommunitySubmission.updateOne(
      { _id: id },
      {
        $set: {
          status: 'WITHDRAWN',
          withdrawnAt: now,
          decisionBy: actor,
          ...(prev ? { previousStatus: prev } : {}),
        },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_STORY_WITHDRAW', id, { entity: 'CommunitySubmission', previousStatus: prev || null });
    return res.status(200).json({ ok: true, success: true, action: 'withdraw', id, isDeleted: false, status: 'WITHDRAWN', withdrawnAt: now.toISOString(), previousStatus: prev || null, affectsLiveSite: false });
  } catch (e) {
    console.error('[ADMIN][community-story][withdraw] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'WITHDRAW_FAILED', message: 'Failed to withdraw story' });
  }
}

// DELETE /api/admin/community-reporter/stories/:storyId/permanent
async function permanentDeleteCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });

    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (!_isSubmissionInDeletedState(doc)) {
      return _jsonError(res, 409, { code: 'STORY_NOT_DELETED_YET', message: 'Story must be deleted before permanent delete' });
    }

    // Strict separation rule:
    // Community Story Desk permanent delete MUST delete only the CommunitySubmission record.
    // It must NOT unpublish/archive/delete any linked News/Article (Manage News controls live site).
    const linkedNewsId = doc.linkedArticleId ? String(doc.linkedArticleId) : null;
    const linkedArticleId = doc.articleId ? String(doc.articleId) : null;

    // Best-effort cleanup: avoid leaving News.communityReportId pointing at a deleted submission.
    // This does not affect live visibility (no status changes).
    let newsDoc = null;
    if (linkedNewsId && _isValidObjectId(linkedNewsId)) {
      try {
        newsDoc = await News.findById(linkedNewsId)
          .select('communityReportId')
          .lean();
      } catch (_) {
        newsDoc = null;
      }
    }

    // Cleanup: avoid leaving broken references.
    if (linkedNewsId && newsDoc && newsDoc.communityReportId && String(newsDoc.communityReportId) === String(doc._id)) {
      await News.updateOne({ _id: linkedNewsId }, { $set: { communityReportId: null } });
    }

    await ReporterStoryLink.deleteMany({ submissionId: id });
    await CommunitySubmission.deleteOne({ _id: id });

    await logAudit(req, 'COMMUNITY_REPORTER_STORY_PERMANENT_DELETE', id, {
      entity: 'CommunitySubmission',
      linkedNewsId,
      linkedArticleId,
      affectsLiveSite: false,
    });
    return res.status(200).json({
      ok: true,
      success: true,
      action: 'permanent_delete',
      message: 'Story permanently deleted',
      id,
      isDeleted: true,
      linkedArticleId: linkedNewsId,
      articleId: linkedArticleId,
      affectsLiveSite: false,
      row: null,
    });
  } catch (e) {
    console.error('[ADMIN][community-story][permanent-delete] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'PERMANENT_DELETE_FAILED', message: 'Failed to permanently delete story' });
  }
}

// POST /api/community-reporter/stories/bulk-delete
// Body: { ids: string[] }
async function bulkDeleteCommunityReporterStories(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    if (!_requireFounderOrAdminRole(req, res)) return;

    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }
    if (ids.length > 5000) {
      return res.status(400).json({ success: false, message: 'Too many ids (max 5000)' });
    }

    const normalizedIds = ids.map(x => String(x || '').trim()).filter(Boolean);
    const invalidIds = normalizedIds.filter(x => !_isValidObjectId(x));
    if (invalidIds.length) {
      return res.status(400).json({ success: false, message: 'Invalid story id(s)', invalidIds });
    }

    // Safety filter: restrict to community reporter submissions.
    const filter = {
      _id: { $in: normalizedIds },
      $or: [
        { sourceType: { $in: ['community', 'journalist'] } },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };

    // Soft-delete in bulk (permanent delete is intentionally NOT supported in bulk).
    const now = new Date();
    let modifiedCount = 0;
    try {
      // Prefer update pipeline to preserve previousStatus where absent.
      const resUpd = await CommunitySubmission.updateMany(
        filter,
        [
          {
            $set: {
              isDeleted: true,
              deletedAt: now,
              deletedBy: actor,
              restoredAt: null,
              restoredBy: null,
              previousStatus: { $ifNull: ['$previousStatus', '$status'] },
              status: 'DELETED',
            },
          },
        ]
      );
      modifiedCount = typeof resUpd?.modifiedCount === 'number' ? resUpd.modifiedCount : (resUpd?.nModified || 0);
    } catch (e) {
      const resUpd = await CommunitySubmission.updateMany(
        filter,
        {
          $set: {
            isDeleted: true,
            deletedAt: now,
            deletedBy: actor,
            restoredAt: null,
            restoredBy: null,
            status: 'DELETED',
          },
        }
      );
      modifiedCount = typeof resUpd?.modifiedCount === 'number' ? resUpd.modifiedCount : (resUpd?.nModified || 0);
    }

    console.log('[ADMIN_DELETE][community-story][bulk] soft-deleted', { actor, requested: normalizedIds.length, modifiedCount, ids: normalizedIds });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_BULK_SOFT_DELETE', null, { entity: 'CommunitySubmission', requested: normalizedIds.length, modifiedCount, ids: normalizedIds });

    return res.status(200).json({ ok: true, success: true, action: 'bulk_soft_delete', modifiedCount, ids: normalizedIds });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story][bulk] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to bulk delete stories' });
  }
}

// GET /api/community-reporter/contacts
async function listReporterContacts(req, res) {
  try {
    const q = req.query || {};
    const filter = {};
    if (q.country) filter.country = String(q.country);
    if (q.state) filter.stateName = String(q.state);
    if (q.district) filter.districtName = String(q.district);
    if (q.city) filter.cityTownVillage = String(q.city);
    if (q.type) filter.reporterType = String(q.type);
    if (q.status) filter.status = String(q.status);

    const contacts = await ReporterContact.find(filter).sort({ fullName: 1 }).lean();
    const items = contacts.map(c => ({
      id: c._id.toString(),
      name: c.fullName,
      email: c.email,
      phone: _maskPhoneForDirectory(c.phoneFull || c.phoneNumber || null),
      maskedPhone: _maskPhoneForDirectory(c.phoneFull || c.phoneNumber || null),
      city: c.cityTownVillage,
      state: c.stateName,
      country: c.country,
      district: c.districtName,
      type: c.reporterType,
      verification: c.verificationLevel,
      status: c.status,
      stats: c.stats || {},
      lastStoryAt: c.stats && c.stats.lastStoryAt ? c.stats.lastStoryAt : null,
    }));
    return res.status(200).json({ ok: true, success: true, status: 200, items, total: items.length, message: 'Reporter contacts directory' });
  } catch (err) {
    console.error('Error in listReporterContacts:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load reporter contacts' });
  }
}

// Admin: Reporter Directory list
async function listReporters(req, res) {
  try {
    // Accept common admin panel filters; default to 'all' and ignore when 'all'
    const {
      district = 'all',
      areaType = 'all',
      beat = 'all',
      activity = 'all',
    } = req.query || {};

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const q = {};
    if (district && String(district).toLowerCase() !== 'all') {
      q.districtName = new RegExp(String(district).trim(), 'i');
    }
    if (areaType && String(areaType).toLowerCase() !== 'all') {
      q.areaType = String(areaType).trim().toUpperCase();
    }
    if (beat && String(beat).toLowerCase() !== 'all') {
      // beats is an array; match by value equality
      q.beats = String(beat).trim().toUpperCase();
    }
    if (activity && String(activity).toLowerCase() !== 'all') {
      // Map activity to status field if present
      q.status = String(activity).trim().toUpperCase();
    }

    const sort = { fullName: 1 };
    const [itemsRaw, total] = await Promise.all([
      ReporterContact.find(q).sort(sort).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(q),
    ]);

    const items = itemsRaw.map(c => ({
      id: c._id.toString(),
      name: c.fullName,
      email: c.email,
      phone: c.phoneFull || c.phoneNumber || null,
      city: c.cityTownVillage,
      state: c.stateName,
      country: c.country,
      district: c.districtName,
      type: c.reporterType,
      status: c.status,
    }));

    return res.json({ ok: true, items, total, page, limit });
  } catch (e) {
    console.error('[ADMIN][listReporters] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
}

// Admin: Community summary stats
async function getCommunityStats(req, res) {
  try {
    const pendingStatuses = ['pending', 'under_review', 'PENDING_FOUNDER', 'UNDER_REVIEW', 'NEW'];
    const [pendingStories, totalReporters, verifiedJournalists] = await Promise.all([
      CommunitySubmission.countDocuments({ status: { $in: pendingStatuses } }),
      ReporterContact.countDocuments({}),
      ReporterContact.countDocuments({ $or: [ { verificationLevel: 'verified' }, { status: 'verified' } ] }),
    ]);
    return res.json({
      pendingStories,
      totalReporters,
      verifiedJournalists,
    });
  } catch (e) {
    console.error('[ADMIN][getCommunityStats] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load community stats' });
  }
}

// Admin: Community Reporter Analytics
// GET /api/admin/community/reporters
async function getCommunityReporterAnalytics(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const approvedStatuses = ['approved', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app', 'published', 'publish', 'published_final'];
    const publishedStatuses = ['published', 'publish', 'published_final'];
    const pendingStatuses = ['new', 'pending', 'under_review', 'underreview', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'pendingfounder', 'pendingfounderreview', 'review'];
    const rejectedStatuses = ['rejected', 'reject', 'trash', 'discarded', 'archived'];
    const withdrawnStatuses = ['withdrawn'];

    const pipeline = [
      { $match: { sourceType: 'community', isDeleted: { $ne: true } } },
      {
        $addFields: {
          _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
          _nameRaw: { $ifNull: ['$reporterName', { $ifNull: ['$name', '$contact.name'] }] },
        },
      },
      {
        $addFields: {
          _emailNorm: {
            $cond: [
              { $or: [{ $eq: ['$_emailRaw', null] }, { $eq: ['$_emailRaw', ''] }] },
              null,
              { $toLower: { $trim: { input: { $toString: '$_emailRaw' } } } },
            ],
          },
          _statusNorm: {
            $cond: [
              { $or: [{ $eq: ['$status', null] }, { $eq: ['$status', ''] }] },
              '',
              { $toLower: { $trim: { input: { $toString: '$status' } } } },
            ],
          },
          reporterKey: {
            $cond: [
              { $and: [{ $ne: ['$reporterProfileId', null] }, { $ne: ['$reporterProfileId', ''] }] },
              { $toString: '$reporterProfileId' },
              {
                $cond: [
                  { $and: [{ $ne: ['$reporterId', null] }, { $ne: ['$reporterId', ''] }] },
                  { $toString: '$reporterId' },
                  {
                    $cond: [
                      { $and: [{ $ne: ['$_emailNorm', null] }, { $ne: ['$_emailNorm', ''] }] },
                      '$_emailNorm',
                      {
                        $cond: [
                          { $and: [{ $ne: ['$contact.phone', null] }, { $ne: ['$contact.phone', ''] }] },
                          { $toString: '$contact.phone' },
                          null,
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      { $match: { reporterKey: { $ne: null } } },
      {
        $group: {
          _id: '$reporterKey',
          name: { $first: '$_nameRaw' },
          email: { $first: '$_emailNorm' },
          totalStories: { $sum: 1 },
          approvedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', approvedStatuses] }, 1, 0] } },
          pendingStories: { $sum: { $cond: [{ $in: ['$_statusNorm', pendingStatuses] }, 1, 0] } },
          rejectedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', rejectedStatuses] }, 1, 0] } },
          withdrawnStories: { $sum: { $cond: [{ $in: ['$_statusNorm', withdrawnStatuses] }, 1, 0] } },
          publishedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', publishedStatuses] }, 1, 0] } },
          lastStoryAt: { $max: '$createdAt' },
        },
      },
      { $sort: { totalStories: -1, lastStoryAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const items = await CommunitySubmissionModel.aggregate(pipeline);
    return res.json({ items, page, limit });
  } catch (err) {
    return next ? next(err) : res.status(500).json({ ok: false, message: 'Failed to load reporter analytics' });
  }
}

// POST /api/community-reporter/submit
async function submitCommunityReport(req, res) {
  try {
    const body = req.body || {};
    if (process.env.COMMUNITY_REPORTER_DEBUG_SUBMIT === '1') {
      console.log('[COMMUNITY_REPORTER][submit] incoming body', body);
    }

    // Support both nested payload ({ reporter, story }) and flat Phase-1 fields
    const reporter = body.reporter || {};
    const story = body.story || {};

    const name = String(
      body.name ||
      reporter.fullName ||
      reporter.name ||
      body.fullName ||
      body.reporterName ||
      ''
    ).trim();

    const email = String(
      body.email ||
      reporter.email ||
      body.reporterEmail ||
      ''
    ).trim().toLowerCase();

    const location = body.location ?? reporter.location ?? undefined;

    const headline = String(
      body.headline ||
      story.headline ||
      ''
    ).trim();

    const storyText = String(
      body.story ||
      body.storyText ||
      story.body ||
      story.storyText ||
      ''
    ).trim();

    const ageGroup = String(body.ageGroup || story.ageGroup || '').trim();

    if (!name || !email || !headline || !storyText || !ageGroup) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const locationObj = (location && typeof location === 'object') ? location : null;
    const locationText = (typeof location === 'string') ? location.trim() : undefined;

    const submission = await CommunitySubmissionModel.create({
      name,
      email,
      reporterName: name,
      reporterEmail: email,
      reporterLocation: locationText,
      location: locationObj ? {
        city: locationObj.city ?? null,
        state: locationObj.state ?? null,
        country: locationObj.country ?? null,
      } : { city: null, state: null, country: null },
      headline,
      body: storyText,
      ageGroup,
      status: 'NEW',
      sourceType: 'community',
      reporterVerificationLevel: 'unverified',
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
    });

    // Auto-upsert into Reporter Contact Directory (email is primary key)
    try {
      const phone = String(
        body.phone ||
        body.phoneNumber ||
        (body.contact && body.contact.phone) ||
        (reporter && (reporter.phone || reporter.phoneNumber)) ||
        ''
      ).trim();

      const city = locationObj ? (locationObj.city ?? null) : null;
      const state = locationObj ? (locationObj.state ?? null) : null;
      const country = locationObj ? (locationObj.country ?? null) : null;

      const { contactId } = await upsertReporterContact({
        name,
        email,
        phone: phone || undefined,
        city: city || undefined,
        state: state || undefined,
        country: country || undefined,
        reporterType: 'community',
        stats: {
          lastStoryAt: submission.createdAt || new Date(),
          lastStoryTitle: headline,
        },
      });

      if (contactId && !submission.reporterId) {
        await CommunitySubmissionModel.updateOne(
          { _id: submission._id },
          { $set: { reporterId: contactId } }
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[COMMUNITY_REPORTER][submit] contact upsert failed', e?.message || e);
    }

    return res.status(201).json({ success: true, id: submission._id });
  } catch (e) {
    console.error('CommunityReporterSubmit error:', e && e.stack ? e.stack : e);
    return res.status(500).json({ message: 'Internal error in Community Reporter submit' });
  }
}

// GET /api/community-reporter/my-stories?email=...
async function listMyCommunityReports(req, res) {
  try {
    const email = String(req.query.email || req.body?.email || '').trim().toLowerCase();
    // Log email used to search my stories
    console.log('[COMMUNITY_REPORT][my-stories] lookup email:', email);
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    // Case-insensitive match on reporterEmail in CommunitySubmission
    const emailRegex = new RegExp(`^${email}$`, 'i');
    const submissions = await CommunitySubmissionModel.find({ reporterEmail: emailRegex })
      .sort({ createdAt: -1 })
      .lean();

    // Also include legacy CommunityReport docs for completeness
    const legacyReports = await CommunityReport.find({ reporterEmail: emailRegex })
      .sort({ createdAt: -1 })
      .lean();

    const mappedSubs = submissions.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: (function () {
        const s = String(i.status || '').toLowerCase();
        if (['approved', 'rejected', 'withdrawn'].includes(s)) return s;
        return 'under_review';
      })(),
      createdAt: i.createdAt,
    }));

    const mappedLegacy = legacyReports.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: i.status || 'under_review',
      createdAt: i.createdAt,
    }));

    const items = [...mappedSubs, ...mappedLegacy].sort((a, b) => (new Date(b.createdAt)) - (new Date(a.createdAt)));
    return res.json({ success: true, items, total: items.length });
  } catch (e) {
    console.error('[COMMUNITY_REPORT][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
}

module.exports = {
  submitCommunityReport,
  listMyCommunityReports,
  getCommunityReporterQueue,
  adminListReporterContacts,
  getReporterContactDirectorySummary,
  getReporterContactDetail,
  getReporterContactProfile,
  updateReporterContactDirectoryProfile,
  adminListReporterContactStories,
  backfillReporterContactsFromSubmissions,
  listReporterContacts,
  listReporters,
  getCommunityStats,
  getCommunityReporterAnalytics,
  deleteReporterContact,
  deactivateReporterContact,
  hideReporterContact,
  listHiddenReporterContacts,
  archiveReporterContact,
  restoreReporterContact,
  permanentlyDeleteReporterContact,
  forcePermanentlyDeleteReporterContact,
  reassignReporterContactStories,
  bulkDeleteReporterContacts,
  deleteCommunityReporterStory,
  restoreCommunityReporterStory,
  withdrawCommunityReporterStory,
  permanentDeleteCommunityReporterStory,
  bulkDeleteCommunityReporterStories,
  __test: {
    _applyDirectoryManualUpdateToContact,
    _buildBulkReporterContactMutationResponse,
    _buildCompactDirectoryRow,
    _buildReporterDirectoryFilters,
    _buildReporterDirectorySummaryPayload,
    _buildReporterProfileContract,
    _filterReporterDirectoryRows,
    _hasPermanentDeleteConfirmation,
    _canPermanentlyDeleteReporterStatus,
    _isArchivedLikeReporterStatus,
    _resolveReporterContactIdFromRequest,
  },
};
