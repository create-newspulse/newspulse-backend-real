const mongoose = require('mongoose');

const AdInquiry = require('../models/AdInquiry');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const News = require('../models/News');
const ReporterProfile = require('../models/ReporterProfile');
const ReporterContact = require('../models/ReporterContact');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const User = require('../models/User');

const BLOCKED_SOURCE_NAMES = Object.freeze([
  'news',
  'articles',
  'staff_accounts',
  'admin_accounts',
  'founder_accounts',
  'audit_logs',
  'security_logs',
  'legal_records',
  'payment_records',
]);

const KNOWN_SOURCE_NAMES = Object.freeze([
  'advertise_business_inquiries',
  'community_reporter_requests',
  'journalist_desk_requests',
  'user_accounts',
]);
const MANUAL_REVIEW_BLOCKED_REASON = 'Manual review only. This source cannot be deleted from DPDP quick action.';

function canQueryModels() {
  return mongoose?.connection?.readyState === 1 || String(process.env.NODE_ENV || '').toLowerCase() === 'test';
}

function createServiceError(message, statusCode = 400, code = 'DPDP_DATA_ACTION_INVALID') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  return digits || null;
}

function buildPhoneVariants(value) {
  const raw = String(value || '').trim();
  const normalized = normalizePhone(value);
  return Array.from(new Set([raw, normalized, raw.replace(/\s+/g, '')].filter(Boolean)));
}

function getNestedValue(input, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), input);
}

function stringifyId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toString === 'function') return value.toString();
  return String(value);
}

function isValidRecordId(value) {
  return mongoose.isValidObjectId(String(value || '').trim());
}

function maskEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return 'hidden';
  const atIndex = email.indexOf('@');
  if (atIndex <= 1) return `***${email.slice(Math.max(0, atIndex))}`;
  const local = email.slice(0, atIndex);
  const domain = email.slice(atIndex);
  return `${local.slice(0, 2)}***${domain}`;
}

function maskPhone(value) {
  const phone = normalizePhone(value);
  if (!phone) return 'hidden';
  const suffix = phone.slice(-4);
  return `***${suffix}`;
}

function buildPreview(prefix, record, emailPaths = [], phonePaths = []) {
  const email = emailPaths.map((path) => getNestedValue(record, path)).find(Boolean);
  if (email) return `${prefix} ${maskEmail(email)}`;
  const phone = phonePaths.map((path) => getNestedValue(record, path)).find(Boolean);
  if (phone) return `${prefix} ${maskPhone(phone)}`;
  return prefix;
}

function buildSyntheticEmail(sourceName, recordId) {
  const safeSource = String(sourceName || 'record').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'record';
  const safeId = String(recordId || Date.now()).replace(/[^a-z0-9]+/gi, '').toLowerCase() || String(Date.now());
  return `deleted+${safeSource}-${safeId}@privacy.local`;
}

function buildIdentityCriteria(request) {
  return {
    email: normalizeEmail(request && request.email),
    mobile: normalizePhone(request && request.mobile),
  };
}

function buildMongoIdentityFilter(criteria, emailPaths = [], phonePaths = []) {
  const or = [];
  if (criteria.email) {
    for (const path of emailPaths) {
      or.push({ [path]: criteria.email });
    }
  }
  if (criteria.mobile) {
    const variants = buildPhoneVariants(criteria.mobile);
    for (const path of phonePaths) {
      or.push({ [path]: { $in: variants } });
    }
  }
  return or.length ? { $or: or } : null;
}

function collectMatchedBy(record, criteria, emailPaths = [], phonePaths = []) {
  const matchedBy = [];

  if (criteria.email) {
    const emailMatch = emailPaths.some((path) => normalizeEmail(getNestedValue(record, path)) === criteria.email);
    if (emailMatch) matchedBy.push('email');
  }

  if (criteria.mobile) {
    const phoneMatch = phonePaths.some((path) => normalizePhone(getNestedValue(record, path)) === criteria.mobile);
    if (phoneMatch) matchedBy.push('mobile');
  }

  return matchedBy;
}

function normalizeRecords(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  return [];
}

async function resolveQueryResult(result) {
  if (!result) return result;
  if (typeof result.lean === 'function') return result.lean();
  return result;
}

async function findMany(Model, filter, limit = 50) {
  if (!canQueryModels() || !filter) return [];
  let query = Model.find(filter);
  if (query && typeof query.limit === 'function') query = query.limit(limit);
  const result = await resolveQueryResult(query);
  return normalizeRecords(result).slice(0, limit);
}

async function findById(Model, id) {
  if (!canQueryModels()) return null;
  if (!isValidRecordId(id)) return null;
  const result = await resolveQueryResult(Model.findById(id));
  return result || null;
}

async function deleteById(Model, id) {
  if (!canQueryModels()) throw createServiceError('Data source is unavailable', 503, 'DPDP_SOURCE_UNAVAILABLE');
  if (!isValidRecordId(id)) throw createServiceError('Invalid record ID for selected item.', 400, 'DPDP_INVALID_RECORD_ID');
  const result = await Model.deleteOne({ _id: id });
  return Number(result && result.deletedCount) > 0;
}

async function updateById(Model, id, update) {
  if (!canQueryModels()) throw createServiceError('Data source is unavailable', 503, 'DPDP_SOURCE_UNAVAILABLE');
  if (!isValidRecordId(id)) throw createServiceError('Invalid record ID for selected item.', 400, 'DPDP_INVALID_RECORD_ID');
  await Model.updateOne({ _id: id }, { $set: update });
}

async function hardDeleteById(Model, id) {
  if (!canQueryModels()) throw createServiceError('Data source is unavailable', 503, 'DPDP_SOURCE_UNAVAILABLE');
  if (!isValidRecordId(id)) throw createServiceError('Invalid record ID for selected item.', 400, 'DPDP_INVALID_RECORD_ID');
  const result = await Model.deleteOne({ _id: id });
  return Number(result && result.deletedCount) > 0;
}

async function detachReporterContactDependencies(contact) {
  const contactId = stringifyId(contact && contact._id);
  if (!contactId || !isValidRecordId(contactId)) {
    return {
      detachedSubmissionReporterIds: 0,
      detachedSubmissionEmailLinks: 0,
      detachedProfiles: 0,
    };
  }

  const normalizedEmail = normalizeEmail(contact && contact.email);

  const directSubmissionResult = await CommunitySubmission.updateMany(
    { reporterId: contactId },
    { $set: { reporterId: null } }
  );

  let emailLinkedSubmissionResult = { modifiedCount: 0 };
  if (normalizedEmail) {
    emailLinkedSubmissionResult = await CommunitySubmission.updateMany(
      {
        reporterId: { $in: [contactId, null, undefined] },
        $or: [
          { reporterEmailNorm: normalizedEmail },
          { reporterEmail: normalizedEmail },
          { email: normalizedEmail },
          { 'contact.email': normalizedEmail },
        ],
      },
      { $set: { reporterId: null } }
    );
  }

  const profileDetachResult = await ReporterProfile.updateMany(
    { reporterContactId: contactId },
    { $set: { reporterContactId: null } }
  );

  return {
    detachedSubmissionReporterIds: typeof directSubmissionResult?.modifiedCount === 'number'
      ? directSubmissionResult.modifiedCount
      : (directSubmissionResult?.nModified || 0),
    detachedSubmissionEmailLinks: typeof emailLinkedSubmissionResult?.modifiedCount === 'number'
      ? emailLinkedSubmissionResult.modifiedCount
      : (emailLinkedSubmissionResult?.nModified || 0),
    detachedProfiles: typeof profileDetachResult?.modifiedCount === 'number'
      ? profileDetachResult.modifiedCount
      : (profileDetachResult?.nModified || 0),
  };
}

async function deleteCommunitySubmissionRecord(recordId, doc) {
  const linkedNewsId = stringifyId(doc && doc.linkedArticleId);
  let newsDoc = null;

  if (linkedNewsId && isValidRecordId(linkedNewsId)) {
    try {
      const raw = await News.findById(linkedNewsId);
      newsDoc = await resolveQueryResult(raw);
    } catch (_) {
      newsDoc = null;
    }
  }

  if (linkedNewsId && newsDoc && newsDoc.communityReportId && String(newsDoc.communityReportId) === String(doc && doc._id)) {
    await News.updateOne({ _id: linkedNewsId }, { $set: { communityReportId: null } });
  }

  await ReporterStoryLink.deleteMany({ submissionId: recordId });
  const deleted = await hardDeleteById(CommunitySubmission, recordId);
  if (!deleted) throw createServiceError('Selected record could not be deleted', 404, 'DPDP_RECORD_NOT_FOUND');
}

function dedupeById(records) {
  const seen = new Set();
  const items = [];
  for (const record of records || []) {
    const id = record && record.recordId ? String(record.recordId) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(record);
  }
  return items;
}

function toSearchRecord({ source, label, record, matchedBy, recommendedAction, deletable, anonymizable, preview, blockedReason = null }) {
  const recordId = stringifyId(record && record._id);
  return {
    source,
    recordId,
    id: recordId,
    preview,
    recommendedAction,
    deletable,
    anonymizable,
    blockedReason,
    matchedBy,
    label,
  };
}

const SOURCE_HANDLERS = {
  advertise_business_inquiries: {
    source: 'advertise_business_inquiries',
    label: 'Advertise / Business Inquiries',
    recommendedAction: 'delete',
    deletable: true,
    anonymizable: true,
    async search(criteria) {
      const filter = buildMongoIdentityFilter(criteria, ['email'], ['phone']);
      const docs = await findMany(AdInquiry, filter);
      return docs
        .map((record) => {
          const matchedBy = collectMatchedBy(record, criteria, ['email'], ['phone']);
          if (!matchedBy.length) return null;
          return toSearchRecord({
            source: this.source,
            label: this.label,
            record,
            matchedBy,
            recommendedAction: this.recommendedAction,
            deletable: this.deletable,
            anonymizable: this.anonymizable,
            preview: buildPreview('Business inquiry from', record, ['email'], ['phone']),
          });
        })
        .filter(Boolean);
    },
    async load(recordId) {
      const record = await findById(AdInquiry, recordId);
      return record ? { model: AdInquiry, record } : null;
    },
    matchesRequest(record, criteria) {
      const candidate = record && record.record ? record.record : record;
      return collectMatchedBy(candidate, criteria, ['email'], ['phone']);
    },
    async runAction(action, recordId) {
      if (action === 'delete') {
        const deleted = await deleteById(AdInquiry, recordId);
        if (!deleted) throw createServiceError('Selected record could not be deleted', 404, 'DPDP_RECORD_NOT_FOUND');
        return;
      }

      const syntheticEmail = buildSyntheticEmail(this.source, recordId);
      await updateById(AdInquiry, recordId, {
        advertiserName: 'Deleted User',
        companyName: null,
        email: syntheticEmail,
        phone: null,
        message: '[Personal data removed]',
        name: 'Deleted User',
        updatedAt: new Date(),
      });
    },
  },
  community_reporter_requests: {
    source: 'community_reporter_requests',
    label: 'Community Reporter Requests',
    recommendedAction: 'delete',
    deletable: true,
    anonymizable: true,
    async search(criteria) {
      const [submissions, legacyReports] = await Promise.all([
        findMany(
          CommunitySubmission,
          buildMongoIdentityFilter(
            criteria,
            ['reporterEmail', 'reporterEmailNorm', 'email', 'contact.email'],
            ['phone', 'phoneNumber', 'mobile', 'mobileNumber', 'contactNumber', 'whatsapp', 'whatsappNumber', 'contact.phone', 'contact.whatsappNumber']
          )
        ),
        findMany(CommunityReport, buildMongoIdentityFilter(criteria, ['reporterEmail'], ['reporterPhone'])),
      ]);

      const submissionRecords = submissions
        .filter((record) => String(record && record.sourceType || 'community') !== 'journalist')
        .map((record) => {
          const matchedBy = collectMatchedBy(
            record,
            criteria,
            ['reporterEmail', 'reporterEmailNorm', 'email', 'contact.email'],
            ['phone', 'phoneNumber', 'mobile', 'mobileNumber', 'contactNumber', 'whatsapp', 'whatsappNumber', 'contact.phone', 'contact.whatsappNumber']
          );
          if (!matchedBy.length) return null;
          return toSearchRecord({
            source: this.source,
            label: this.label,
            record,
            matchedBy,
            recommendedAction: this.recommendedAction,
            deletable: this.deletable,
            anonymizable: this.anonymizable,
            preview: buildPreview('Community request by', record, ['reporterEmail', 'email', 'contact.email'], ['phone', 'contact.phone']),
          });
        })
        .filter(Boolean);

      const reportRecords = legacyReports
        .map((record) => {
          const matchedBy = collectMatchedBy(record, criteria, ['reporterEmail'], ['reporterPhone']);
          if (!matchedBy.length) return null;
          return toSearchRecord({
            source: this.source,
            label: this.label,
            record,
            matchedBy,
            recommendedAction: this.recommendedAction,
            deletable: this.deletable,
            anonymizable: this.anonymizable,
            preview: buildPreview('Community request by', record, ['reporterEmail'], ['reporterPhone']),
          });
        })
        .filter(Boolean);

      return dedupeById([...submissionRecords, ...reportRecords]);
    },
    async load(recordId) {
      const submission = await findById(CommunitySubmission, recordId);
      if (submission && String(submission.sourceType || 'community') !== 'journalist') {
        return { model: CommunitySubmission, kind: 'submission', record: submission };
      }

      const report = await findById(CommunityReport, recordId);
      if (report) return { model: CommunityReport, kind: 'legacy_report', record: report };
      return null;
    },
    matchesRequest(recordWrapper, criteria) {
      const record = recordWrapper && recordWrapper.record ? recordWrapper.record : recordWrapper;
      if (recordWrapper && recordWrapper.kind === 'legacy_report') {
        return collectMatchedBy(record, criteria, ['reporterEmail'], ['reporterPhone']);
      }
      return collectMatchedBy(
        record,
        criteria,
        ['reporterEmail', 'reporterEmailNorm', 'email', 'contact.email'],
        ['phone', 'phoneNumber', 'mobile', 'mobileNumber', 'contactNumber', 'whatsapp', 'whatsappNumber', 'contact.phone', 'contact.whatsappNumber']
      );
    },
    async runAction(_action, recordId, loaded) {
      if (!loaded || !loaded.record) throw createServiceError('Selected record was not found', 404, 'DPDP_RECORD_NOT_FOUND');

      if (_action === 'delete') {
        if (loaded.kind === 'legacy_report') {
          const deleted = await hardDeleteById(CommunityReport, recordId);
          if (!deleted) throw createServiceError('Selected record could not be deleted', 404, 'DPDP_RECORD_NOT_FOUND');
          return;
        }

        await deleteCommunitySubmissionRecord(recordId, loaded.record);
        return;
      }

      const syntheticEmail = buildSyntheticEmail(this.source, recordId);

      if (loaded.kind === 'legacy_report') {
        await updateById(CommunityReport, recordId, {
          reporterName: 'Deleted User',
          reporterEmail: syntheticEmail,
          reporterPhone: null,
          reviewNotes: '[Personal data removed]',
          updatedAt: new Date(),
        });
        return;
      }

      await updateById(CommunitySubmission, recordId, {
        fullName: 'Deleted User',
        reporterName: 'Deleted User',
        name: 'Deleted User',
        userName: null,
        reporterEmail: syntheticEmail,
        reporterEmailNorm: syntheticEmail,
        email: syntheticEmail,
        phone: null,
        phoneNumber: null,
        mobile: null,
        mobileNumber: null,
        contactNumber: null,
        whatsapp: null,
        whatsappNumber: null,
        contact: {
          name: 'Deleted User',
          email: null,
          phone: null,
          preferredContact: 'no_preference',
          canContactForThisStory: false,
          canContactForFutureStories: false,
          whatsappNumber: null,
          telegramId: null,
          instagramHandle: null,
        },
        verificationNotes: '[Personal data removed]',
        editorialNotes: '[Personal data removed]',
        updatedAt: new Date(),
      });
    },
  },
  journalist_desk_requests: {
    source: 'journalist_desk_requests',
    label: 'Journalist Desk Requests',
    recommendedAction: 'delete',
    deletable: true,
    anonymizable: true,
    async search(criteria) {
      const filter = buildMongoIdentityFilter(criteria, ['email', 'emailLower', 'pendingPortalEmail'], ['phoneFull', 'phoneNumber', 'whatsappNumber', 'alternatePhone']);
      if (!filter) return [];
      const docs = await findMany(ReporterContact, { reporterType: 'journalist', ...filter });
      return docs
        .map((record) => {
          const matchedBy = collectMatchedBy(record, criteria, ['email', 'emailLower', 'pendingPortalEmail'], ['phoneFull', 'phoneNumber', 'whatsappNumber', 'alternatePhone']);
          if (!matchedBy.length) return null;
          return toSearchRecord({
            source: this.source,
            label: this.label,
            record,
            matchedBy,
            recommendedAction: this.recommendedAction,
            deletable: this.deletable,
            anonymizable: this.anonymizable,
            preview: buildPreview('Journalist request by', record, ['email', 'pendingPortalEmail'], ['phoneFull', 'phoneNumber']),
          });
        })
        .filter(Boolean);
    },
    async load(recordId) {
      const record = await findById(ReporterContact, recordId);
      if (!record || String(record.reporterType || '') !== 'journalist') return null;
      return { model: ReporterContact, record };
    },
    matchesRequest(recordWrapper, criteria) {
      const record = recordWrapper && recordWrapper.record ? recordWrapper.record : recordWrapper;
      return collectMatchedBy(record, criteria, ['email', 'emailLower', 'pendingPortalEmail'], ['phoneFull', 'phoneNumber', 'whatsappNumber', 'alternatePhone']);
    },
    async runAction(_action, recordId, loaded) {
      if (_action === 'delete') {
        if (!loaded || !loaded.record) throw createServiceError('Selected record was not found', 404, 'DPDP_RECORD_NOT_FOUND');
        await detachReporterContactDependencies(loaded.record);
        const deleted = await hardDeleteById(ReporterContact, recordId);
        if (!deleted) throw createServiceError('Selected record could not be deleted', 404, 'DPDP_RECORD_NOT_FOUND');
        return;
      }

      const syntheticEmail = buildSyntheticEmail(this.source, recordId);
      await updateById(ReporterContact, recordId, {
        fullName: 'Deleted User',
        email: syntheticEmail,
        emailLower: syntheticEmail,
        reporterKey: syntheticEmail,
        phoneNumber: null,
        phoneFull: null,
        whatsappNumber: null,
        alternatePhone: null,
        pendingPortalEmail: null,
        organisationName: null,
        positionTitle: null,
        roleOrTitle: null,
        websiteOrPortfolio: null,
        portfolioLinks: [],
        notes: '[Personal data removed]',
        journalistNotes: '[Personal data removed]',
        socialLinks: { linkedin: null, twitter: null },
        behaviourNotes: [],
        updatedAt: new Date(),
      });
    },
  },
  user_accounts: {
    source: 'user_accounts',
    label: 'User Accounts',
    recommendedAction: 'manual_review_required',
    deletable: false,
    anonymizable: false,
    blockedReason: MANUAL_REVIEW_BLOCKED_REASON,
    async search(criteria) {
      const filter = buildMongoIdentityFilter(criteria, ['email', 'pendingEmail', 'recoveryEmail'], []);
      if (!filter) return [];
      const docs = await findMany(User, {
        ...filter,
        isProtected: { $ne: true },
        isFounder: { $ne: true },
        role: { $nin: ['admin', 'founder', 'staff'] },
      });
      return docs
        .map((record) => {
          const matchedBy = collectMatchedBy(record, criteria, ['email', 'pendingEmail', 'recoveryEmail'], []);
          if (!matchedBy.length) return null;
          return toSearchRecord({
            source: this.source,
            label: this.label,
            record,
            matchedBy,
            recommendedAction: this.recommendedAction,
            deletable: this.deletable,
            anonymizable: this.anonymizable,
            preview: buildPreview('User account', record, ['email', 'pendingEmail', 'recoveryEmail'], []),
            blockedReason: this.blockedReason,
          });
        })
        .filter(Boolean);
    },
    async load(recordId) {
      const record = await findById(User, recordId);
      if (!record) return null;
      return { model: User, record };
    },
    matchesRequest(recordWrapper, criteria) {
      const record = recordWrapper && recordWrapper.record ? recordWrapper.record : recordWrapper;
      return collectMatchedBy(record, criteria, ['email', 'pendingEmail', 'recoveryEmail'], []);
    },
    async runAction() {
      throw createServiceError('User accounts require manual review in this release', 400, 'DPDP_MANUAL_REVIEW_REQUIRED');
    },
  },
};

function buildActionTakenSummary(action, results) {
  const countsBySource = new Map();
  for (const item of results || []) {
    const key = String(item.source || '').trim();
    countsBySource.set(key, (countsBySource.get(key) || 0) + 1);
  }
  const parts = Array.from(countsBySource.entries()).map(([source, count]) => `${action} ${count} ${source}`);
  return parts.join('; ');
}

async function searchMatchingDataForPrivacyRequest(request) {
  const criteria = buildIdentityCriteria(request);
  const matchedBy = new Set();
  const sources = [];

  for (const sourceName of KNOWN_SOURCE_NAMES) {
    const handler = SOURCE_HANDLERS[sourceName];
    if (!handler) continue;
    const records = await handler.search(criteria);
    if (!records.length) continue;
    for (const record of records) {
      for (const field of record.matchedBy || []) matchedBy.add(field);
    }
    sources.push({
      source: handler.source,
      label: handler.label,
      count: records.length,
      records,
    });
  }

  return {
    requestId: request.requestId,
    matchedBy: Array.from(matchedBy),
    sources,
  };
}

async function performPrivacyDataAction({ request, action, items, handledBy, newStatus }) {
  const criteria = buildIdentityCriteria(request);
  const prepared = [];

  for (const item of items || []) {
    const sourceName = String(item && item.source || '').trim();
    const recordId = String(item && item.recordId || '').trim();

    if (!KNOWN_SOURCE_NAMES.includes(sourceName)) {
      if (BLOCKED_SOURCE_NAMES.includes(sourceName)) {
        throw createServiceError(`Source is blocked from DPDP actions: ${sourceName}`, 400, 'DPDP_SOURCE_BLOCKED');
      }
      throw createServiceError(`Source is not supported: ${sourceName}`, 400, 'DPDP_SOURCE_UNSUPPORTED');
    }

    const handler = SOURCE_HANDLERS[sourceName];
    if (!handler) throw createServiceError(`Source is not supported: ${sourceName}`, 400, 'DPDP_SOURCE_UNSUPPORTED');
    if (!isValidRecordId(recordId)) {
      throw createServiceError('Invalid record ID for selected item.', 400, 'DPDP_INVALID_RECORD_ID');
    }

    const canDelete = Boolean(handler.deletable);
    const canAnonymize = Boolean(handler.anonymizable);
    if ((action === 'delete' && !canDelete) || (action === 'anonymize' && !canAnonymize)) {
      throw createServiceError(`${handler.label} does not allow ${action} in this release`, 400, 'DPDP_ACTION_NOT_ALLOWED');
    }

    const loaded = await handler.load(recordId);
    if (!loaded || !loaded.record) {
      throw createServiceError(`Selected record was not found for source ${sourceName}`, 404, 'DPDP_RECORD_NOT_FOUND');
    }

    const matchedBy = handler.matchesRequest(loaded, criteria);
    if (!matchedBy.length) {
      throw createServiceError(`Selected record does not match the verified privacy request for source ${sourceName}`, 400, 'DPDP_IDENTITY_MISMATCH');
    }

    prepared.push({ handler, source: sourceName, recordId, loaded, matchedBy });
  }

  for (const item of prepared) {
    await item.handler.runAction(action, item.recordId, item.loaded);
  }

  const results = prepared.map((item) => ({
    source: item.source,
    recordId: item.recordId,
    matchedBy: item.matchedBy,
    action,
    handledBy,
  }));

  return {
    oldStatus: request.status || null,
    newStatus,
    results,
    actionTakenSummary: buildActionTakenSummary(action, results),
  };
}

module.exports = {
  BLOCKED_SOURCE_NAMES,
  KNOWN_SOURCE_NAMES,
  isValidRecordId,
  searchMatchingDataForPrivacyRequest,
  performPrivacyDataAction,
};