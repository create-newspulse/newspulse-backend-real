const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const controller = require('../controllers/communityReporterController');
const ReporterContact = require('../models/ReporterContact');
const ReporterProfile = require('../models/ReporterProfile');
const CommunitySubmission = require('../models/CommunitySubmission');
const AuditLog = require('../models/AuditLog');

const {
  _applyDirectoryManualUpdateToContact,
  _buildBulkReporterContactMutationResponse,
  _buildBulkReporterContactRestoreResponse,
  _buildBulkReporterContactPermanentDeleteResponse,
  _buildCompactDirectoryRow,
  _buildReporterDirectoryCountsPayload,
  _buildReporterDirectoryStateIntegrityReport,
  _buildDirectoryVisibilityState,
  _buildReporterDirectoryFilters,
  _buildReporterDirectorySummaryPayload,
  _buildReporterProfileContract,
  _filterReporterDirectoryRows,
  _canRemoveReporterContactStatus,
  _canRestoreReporterContactStatus,
  _buildReporterContactPermanentDeleteContract,
  _canPermanentlyDeleteReporterStatus,
  _hasPermanentDeleteConfirmation,
  _isArchivedLikeReporterStatus,
  _normalizeBulkReporterContactIds,
  _resolveReporterContactIdFromRequest,
} = controller.__test;

function makeJsonResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function withMongoReady(fn) {
  const originalReadyState = mongoose.connection.readyState;
  const originalAuditCreate = AuditLog.create;

  mongoose.connection.readyState = 1;
  AuditLog.create = async () => ({ _id: 'audit-log-id' });

  try {
    await fn();
  } finally {
    mongoose.connection.readyState = originalReadyState;
    AuditLog.create = originalAuditCreate;
  }
}

test('reporter directory summary exposes required summary fields including newThisMonth', () => {
  const rows = [
    {
      verification: 'verified',
      missingPhone: false,
      missingLocation: false,
      lastActivityAt: '2026-04-06T10:00:00.000Z',
      createdAt: '2026-04-02T09:00:00.000Z',
    },
    {
      verification: 'community_default',
      missingPhone: true,
      missingLocation: true,
      lastActivityAt: '2026-03-20T10:00:00.000Z',
      createdAt: '2026-03-01T09:00:00.000Z',
    },
  ];

  const summary = _buildReporterDirectorySummaryPayload(rows);

  assert.strictEqual(summary.total, 2);
  assert.strictEqual(summary.totalReporters, 2);
  assert.strictEqual(summary.verified, 1);
  assert.strictEqual(summary.verifiedCount, 1);
  assert.strictEqual(summary.missingPhone, 1);
  assert.strictEqual(summary.missingPhoneCount, 1);
  assert.strictEqual(summary.missingLocation, 1);
  assert.strictEqual(summary.missingLocationCount, 1);
  assert.strictEqual(summary.activeThisMonth, 1);
  assert.strictEqual(summary.newThisMonth, 1);
  assert.strictEqual(summary.lastSubmissionAt, '2026-04-06T10:00:00.000Z');
  assert.strictEqual(summary.lastSubmission, '2026-04-06T10:00:00.000Z');
});

test('directory-wide counts distinguish active and removed rows from the same contract', () => {
  const counts = _buildReporterDirectoryCountsPayload([
    { id: 'a1', directoryStatus: 'active' },
    { id: 'a2', status: 'archived' },
    { id: 'r1', directoryStatus: 'removed' },
    { id: 'r2', archivedAt: '2026-04-07T08:00:00.000Z' },
  ]);

  assert.deepStrictEqual(counts, {
    activeCount: 2,
    removedCount: 2,
    totalCount: 4,
  });
  assert.strictEqual(counts.totalCount, counts.activeCount + counts.removedCount);
});

test('explicit directoryStatus wins over legacy moderation status so one contact resolves to exactly one state', () => {
  const activeRow = _buildCompactDirectoryRow({
    _id: 'contact-active',
    fullName: 'Active Reporter',
    email: 'active@example.com',
    status: 'archived',
    directoryStatus: 'active',
  }, null);
  const removedRow = _buildCompactDirectoryRow({
    _id: 'contact-removed',
    fullName: 'Removed Reporter',
    email: 'removed@example.com',
    status: 'active',
    directoryStatus: 'removed',
  }, null);

  assert.strictEqual(activeRow.status, 'active');
  assert.strictEqual(activeRow.rawStatus, 'archived');
  assert.strictEqual(activeRow.directoryStatus, 'active');
  assert.strictEqual(removedRow.status, 'removed');
  assert.strictEqual(removedRow.rawStatus, 'active');
  assert.strictEqual(removedRow.directoryStatus, 'removed');
});

test('directory counts dedupe duplicate identities and keep total equal to active plus removed', () => {
  const counts = _buildReporterDirectoryCountsPayload([
    { reporterContactId: 'contact-1', email: 'same@example.com', directoryStatus: 'active' },
    { reporterContactId: 'contact-1', email: 'same@example.com', directoryStatus: 'removed' },
    { reporterContactId: 'contact-2', email: 'other@example.com', directoryStatus: 'removed' },
  ]);

  assert.deepStrictEqual(counts, {
    activeCount: 1,
    removedCount: 1,
    totalCount: 2,
  });
  assert.strictEqual(counts.totalCount, counts.activeCount + counts.removedCount);
});

test('state integrity report detects invalid directory statuses and duplicate identities', () => {
  const report = _buildReporterDirectoryStateIntegrityReport([
    { _id: '1', email: 'same@example.com', directoryStatus: 'active', status: 'active' },
    { _id: '2', email: 'same@example.com', directoryStatus: 'removed', status: 'archived' },
    { _id: '3', email: 'invalid@example.com', directoryStatus: 'blocked', status: 'suspended' },
  ]);

  assert.strictEqual(report.scannedCount, 3);
  assert.strictEqual(report.invalidDirectoryStatusCount, 1);
  assert.strictEqual(report.duplicateIdentityGroups.length, 1);
  assert.strictEqual(report.totalCount, report.activeCount + report.removedCount);
  assert.strictEqual(report.totalEqualsStateSum, true);
  assert.strictEqual(report.valid, false);
});

test('compact reporter row stays compact and includes required table fields', () => {
  const row = _buildCompactDirectoryRow({
    _id: 'contact-1',
    fullName: 'Kiran Parmar',
    email: 'kiran@example.com',
    phoneFull: '+919999991234',
    cityTownVillage: 'Ahmedabad',
    districtName: 'Ahmedabad',
    stateName: 'Gujarat',
    reporterType: 'community',
    verificationLevel: 'verified',
    status: 'active',
    createdAt: '2026-04-01T08:00:00.000Z',
    updatedAt: '2026-04-06T08:00:00.000Z',
  }, {
    totalStories: 18,
    approvedStories: 12,
    pendingStories: 3,
    publishedStories: 7,
    lastStoryAt: '2026-04-06T08:00:00.000Z',
  });

  assert.strictEqual(row.id, 'contact-1');
  assert.strictEqual(row._id, 'contact-1');
  assert.strictEqual(row.contactId, 'contact-1');
  assert.strictEqual(row.reporterContactId, 'contact-1');
  assert.strictEqual(row.name, 'Kiran Parmar');
  assert.strictEqual(row.email, 'kiran@example.com');
  assert.strictEqual(row.phone, '+919999991234');
  assert.strictEqual(row.maskedPhone, 'xxxxxx1234');
  assert.strictEqual(row.fullPhone, '+919999991234');
  assert.strictEqual(row.whatsapp, null);
  assert.strictEqual(row.city, 'Ahmedabad');
  assert.strictEqual(row.district, 'Ahmedabad');
  assert.strictEqual(row.state, 'Gujarat');
  assert.strictEqual(row.reporterType, 'community');
  assert.strictEqual(row.type, 'community');
  assert.strictEqual(row.verification, 'verified');
  assert.strictEqual(row.directoryState, 'active');
  assert.strictEqual(row.directoryStatus, 'active');
  assert.strictEqual(row.isRemovedFromDirectory, false);
  assert.strictEqual(row.isVisibleInDirectory, true);
  assert.strictEqual(row.directory.state, 'active');
  assert.strictEqual(row.directory.status, 'active');
  assert.strictEqual(row.totalStories, 18);
  assert.strictEqual(row.stories, 18);
  assert.strictEqual(row.approvedStories, 12);
  assert.strictEqual(row.approved, 12);
  assert.strictEqual(row.pendingStories, 3);
  assert.strictEqual(row.pending, 3);
  assert.strictEqual(row.lastSubmission, '2026-04-06T08:00:00.000Z');
  assert.strictEqual(row.actions.viewStories, true);
  assert.strictEqual(row.actions.profile, true);
  assert.strictEqual(row.actions.archive, false);
  assert.strictEqual(row.actions.removeFromDirectory, undefined);
  assert.strictEqual(row.actions.restore, undefined);
  assert.strictEqual(row.actions.deletePermanently, undefined);
  assert.strictEqual(row.deleteMode, 'bulk_remove_only');
  assert.deepStrictEqual(row.availableActions, ['email', 'view_stories', 'profile']);
  assert.strictEqual(row.lastActivityAt, '2026-04-06T08:00:00.000Z');
  assert.strictEqual(row.missingPhone, false);
  assert.strictEqual(row.missingLocation, false);
  assert.strictEqual(row.needsVerification, false);
});

test('profile drawer contract exposes full drawer fields with task flags and activity timestamps', () => {
  const profile = _buildReporterProfileContract({
    _id: 'contact-1',
    fullName: 'Kiran Parmar',
    email: 'kiran@example.com',
    phoneFull: '+919999999999',
    whatsappNumber: '+918888888888',
    alternatePhone: '+917777777777',
    cityTownVillage: 'Ahmedabad',
    districtName: 'Ahmedabad',
    stateName: 'Gujarat',
    country: 'India',
    primaryBeat: 'Politics',
    areaName: 'West Zone',
    reporterType: 'community',
    verificationLevel: 'verified',
  }, {
    _id: 'profile-1',
    displayName: 'Kiran Parmar',
    primaryEmail: 'kiran@example.com',
    primaryPhone: '+919999999999',
    verificationTier: 'verified_journalist',
    coverageScope: 'regional',
    location: {
      city: 'Ahmedabad',
      districtCounty: 'Ahmedabad',
      stateProvince: 'Gujarat',
      country: 'India',
      areaLocality: 'West Zone',
    },
    stats: {
      totalStories: 18,
      approvedStories: 11,
      pendingStories: 4,
      rejectedStories: 2,
      publishedStories: 7,
      lastStoryAt: '2026-04-06T08:00:00.000Z',
      lastStoryTitle: 'Lead story',
    },
  }, [
    {
      _id: 'method-1',
      type: 'whatsapp',
      value: '+918888888888',
      normalized: '918888888888',
      isPrimary: true,
      status: 'active',
      source: 'admin',
    },
  ], [
    {
      _id: 'task-1',
      title: 'Call reporter',
      status: 'open',
      updatedAt: '2026-04-05T09:00:00.000Z',
      nextFollowUpAt: '2026-04-10T08:00:00.000Z',
    },
  ], [
    {
      _id: 'activity-1',
      type: 'note',
      message: 'Manual note',
      actor: { kind: 'admin', email: 'admin@newspulse.ai', role: 'admin' },
      createdAt: '2026-04-05T08:00:00.000Z',
    },
  ], {
    id: 'contact-1',
    phone: 'xxxxxx9999',
    totalStories: 18,
    approvedStories: 11,
    pendingStories: 4,
    rejectedStories: 2,
    publishedStories: 7,
    lastSubmissionAt: '2026-04-06T08:00:00.000Z',
    lastStoryAt: '2026-04-06T08:00:00.000Z',
    lastStoryTitle: 'Lead story',
    lastActivityAt: '2026-04-06T08:00:00.000Z',
  }, null);

  assert.strictEqual(profile.phone, '+919999999999');
  assert.strictEqual(profile.fullPhone, '+919999999999');
  assert.strictEqual(profile.maskedPhone, null);
  assert.strictEqual(profile.phonePreview, '+919999999999');
  assert.strictEqual(profile.contact.phone, '+919999999999');
  assert.strictEqual(profile.contact.fullPhone, '+919999999999');
  assert.strictEqual(profile.contact.maskedPhone, null);
  assert.strictEqual(profile.contact.phonePreview, '+919999999999');
  assert.strictEqual(profile.contact.whatsapp, '+918888888888');
  assert.strictEqual(profile.city, 'Ahmedabad');
  assert.strictEqual(profile.district, 'Ahmedabad');
  assert.strictEqual(profile.state, 'Gujarat');
  assert.strictEqual(profile.country, 'India');
  assert.strictEqual(profile.reporterType, 'community');
  assert.strictEqual(profile.verification, 'verified');
  assert.strictEqual(profile.directoryState, 'active');
  assert.strictEqual(profile.directoryStatus, 'active');
  assert.strictEqual(profile.isRemovedFromDirectory, false);
  assert.strictEqual(profile.isVisibleInDirectory, true);
  assert.strictEqual(profile.directory.state, 'active');
  assert.strictEqual(profile.directory.status, 'active');
  assert.strictEqual(profile.directory.canRemoveFromDirectory, undefined);
  assert.strictEqual(profile.directory.canRestore, undefined);
  assert.strictEqual(profile.directory.canDeletePermanently, undefined);
  assert.strictEqual(profile.overview.directoryState, 'active');
  assert.strictEqual(profile.stories, 18);
  assert.strictEqual(profile.approved, 11);
  assert.strictEqual(profile.pending, 4);
  assert.strictEqual(profile.lastSubmission, '2026-04-06T08:00:00.000Z');
  assert.strictEqual(profile.stats.stories, 18);
  assert.strictEqual(profile.stats.approved, 11);
  assert.strictEqual(profile.stats.pending, 4);
  assert.strictEqual(profile.stats.lastSubmission, '2026-04-06T08:00:00.000Z');
  assert.strictEqual(profile.stats.publishedStories, 7);
  assert.strictEqual(profile.tasks.length, 1);
  assert.strictEqual(profile.contactMethods.length, 1);
  assert.strictEqual(profile.activity[0].createdAt, '2026-04-05T08:00:00.000Z');
  assert.strictEqual(profile.lastActivityAt, '2026-04-06T08:00:00.000Z');
});

test('profile drawer contract exposes removed state and recovery actions for soft-removed contacts', () => {
  const profile = _buildReporterProfileContract({
    _id: 'contact-2',
    fullName: 'Removed Reporter',
    email: 'removed@example.com',
    status: 'archived',
    archivedAt: '2026-04-07T08:00:00.000Z',
    archivedBy: 'admin@newspulse.ai',
  }, null, [], [], [], {
    id: 'contact-2',
    status: 'archived',
  }, null, [], []);

  assert.strictEqual(profile.status, 'removed');
  assert.strictEqual(profile.rawStatus, 'archived');
  assert.strictEqual(profile.directoryState, 'removed');
  assert.strictEqual(profile.directoryStatus, 'removed');
  assert.strictEqual(profile.isRemovedFromDirectory, true);
  assert.strictEqual(profile.isVisibleInDirectory, false);
  assert.strictEqual(profile.directory.state, 'removed');
  assert.strictEqual(profile.directory.status, 'removed');
  assert.strictEqual(profile.directory.isRemovedFromDirectory, true);
  assert.strictEqual(profile.directory.isVisibleInDirectory, false);
  assert.strictEqual(profile.directory.canRemoveFromDirectory, undefined);
  assert.strictEqual(profile.directory.canRestore, undefined);
  assert.strictEqual(profile.directory.canDeletePermanently, undefined);
  assert.strictEqual(profile.directory.removedAt, '2026-04-07T08:00:00.000Z');
  assert.strictEqual(profile.directory.removedBy, 'admin@newspulse.ai');
  assert.strictEqual(profile.directory.restoreRoute, undefined);
  assert.strictEqual(profile.directory.permanentDeleteRoute, undefined);
  assert.strictEqual(profile.overview.directoryState, 'removed');
  assert.strictEqual(profile.overview.isRemovedFromDirectory, true);
  assert.strictEqual(profile.overview.isVisibleInDirectory, false);
});

test('bulk hide id normalization keeps valid ReporterContact ids and reports invalid values', () => {
  const result = _normalizeBulkReporterContactIds([
    ' 507f1f77bcf86cd799439011 ',
    { id: '507f1f77bcf86cd799439012' },
    { reporterContactId: '507f1f77bcf86cd799439013' },
    'not-an-object-id',
    '',
    null,
    '507f1f77bcf86cd799439011',
  ]);

  assert.deepStrictEqual(result.receivedIds, [
    '507f1f77bcf86cd799439011',
    '507f1f77bcf86cd799439012',
    '507f1f77bcf86cd799439013',
    'not-an-object-id',
    '507f1f77bcf86cd799439011',
  ]);
  assert.deepStrictEqual(result.validIds, [
    '507f1f77bcf86cd799439011',
    '507f1f77bcf86cd799439012',
    '507f1f77bcf86cd799439013',
  ]);
  assert.deepStrictEqual(result.invalidIds, ['not-an-object-id']);
  assert.strictEqual(result.receivedCount, 5);
});

test('bulk hide id normalization reports no valid ReporterContact ids when payload has no usable ids', () => {
  const result = _normalizeBulkReporterContactIds(['', '   ', null, undefined, 'bad-id']);

  assert.deepStrictEqual(result.receivedIds, ['bad-id']);
  assert.deepStrictEqual(result.validIds, []);
  assert.deepStrictEqual(result.invalidIds, ['bad-id']);
  assert.strictEqual(result.receivedCount, 1);
});

test('manual contact updates accept verification and fullPhone aliases and mark overrides', () => {
  const contact = {
    directoryManualOverrides: {},
  };

  _applyDirectoryManualUpdateToContact(contact, {
    fullPhone: '+919876543210',
    city: 'Surat',
    areaName: 'South Zone',
    notes: 'Follow up by desk',
    verification: 'limited',
  }, { email: 'admin@newspulse.ai' });

  assert.strictEqual(contact.phoneFull, '+919876543210');
  assert.strictEqual(contact.cityTownVillage, 'Surat');
  assert.strictEqual(contact.areaName, 'South Zone');
  assert.strictEqual(contact.notes, 'Follow up by desk');
  assert.strictEqual(contact.verificationLevel, 'limited');
  assert.strictEqual(contact.directoryManualOverrides.phoneFull.enabled, true);
  assert.strictEqual(contact.directoryManualOverrides.cityTownVillage.enabled, true);
  assert.strictEqual(contact.directoryManualOverrides.areaName.enabled, true);
  assert.strictEqual(contact.directoryManualOverrides.notes.enabled, true);
  assert.strictEqual(contact.directoryManualOverrides.verificationLevel.enabled, true);
});

test('bulk remove response stays soft and compatible with existing delete-shaped consumers', () => {
  const response = _buildBulkReporterContactMutationResponse(
    ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022'],
    [{ id: '507f1f77bcf86cd799439023', code: 'CONTACT_NOT_FOUND' }]
  );

  assert.strictEqual(response.success, true);
  assert.strictEqual(response.message, 'Bulk remove from directory completed');
  assert.strictEqual(response.mode, 'soft');
  assert.strictEqual(response.hidden, true);
  assert.strictEqual(response.removed, true);
  assert.strictEqual(response.removedCount, 2);
  assert.deepStrictEqual(response.removedIds, ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022']);
  assert.strictEqual(response.deletedCount, 2);
  assert.deepStrictEqual(response.deletedIds, ['507f1f77bcf86cd799439021', '507f1f77bcf86cd799439022']);
  assert.deepStrictEqual(response.skipped, [{ id: '507f1f77bcf86cd799439023', code: 'CONTACT_NOT_FOUND' }]);
});

test('bulk restore and bulk permanent delete responses expose distinct mutation outcomes', () => {
  const restoreResponse = _buildBulkReporterContactRestoreResponse(
    ['507f1f77bcf86cd799439041'],
    [{ id: '507f1f77bcf86cd799439042', code: 'CONTACT_NOT_REMOVED' }]
  );
  const permanentDeleteResponse = _buildBulkReporterContactPermanentDeleteResponse(
    ['507f1f77bcf86cd799439043'],
    [{ id: '507f1f77bcf86cd799439044', code: 'CONTACT_HAS_LINKED_STORIES' }]
  );

  assert.strictEqual(restoreResponse.mode, 'restore');
  assert.strictEqual(restoreResponse.successCount, 1);
  assert.strictEqual(restoreResponse.restoredCount, 1);
  assert.deepStrictEqual(restoreResponse.restoredIds, ['507f1f77bcf86cd799439041']);
  assert.strictEqual(restoreResponse.failedCount, 1);
  assert.deepStrictEqual(restoreResponse.failedIds, ['507f1f77bcf86cd799439042']);
  assert.strictEqual(restoreResponse.missingCount, 0);
  assert.deepStrictEqual(restoreResponse.missingIds, []);
  assert.strictEqual(restoreResponse.invalidStateCount, 1);
  assert.deepStrictEqual(restoreResponse.invalidStateIds, ['507f1f77bcf86cd799439042']);
  assert.deepStrictEqual(restoreResponse.failures, [{ id: '507f1f77bcf86cd799439042', code: 'CONTACT_NOT_REMOVED' }]);
  assert.deepStrictEqual(restoreResponse.skipped, [{ id: '507f1f77bcf86cd799439042', code: 'CONTACT_NOT_REMOVED' }]);

  assert.strictEqual(permanentDeleteResponse.mode, 'hard');
  assert.strictEqual(permanentDeleteResponse.successCount, 1);
  assert.strictEqual(permanentDeleteResponse.deletedCount, 1);
  assert.deepStrictEqual(permanentDeleteResponse.deletedIds, ['507f1f77bcf86cd799439043']);
  assert.strictEqual(permanentDeleteResponse.failedCount, 1);
  assert.deepStrictEqual(permanentDeleteResponse.failedIds, ['507f1f77bcf86cd799439044']);
  assert.strictEqual(permanentDeleteResponse.missingCount, 0);
  assert.deepStrictEqual(permanentDeleteResponse.missingIds, []);
  assert.strictEqual(permanentDeleteResponse.invalidStateCount, 0);
  assert.deepStrictEqual(permanentDeleteResponse.invalidStateIds, []);
  assert.strictEqual(permanentDeleteResponse.blockedCount, 1);
  assert.deepStrictEqual(permanentDeleteResponse.blockedIds, ['507f1f77bcf86cd799439044']);
  assert.deepStrictEqual(permanentDeleteResponse.failures, [{ id: '507f1f77bcf86cd799439044', code: 'CONTACT_HAS_LINKED_STORIES' }]);
  assert.deepStrictEqual(permanentDeleteResponse.skipped, [{ id: '507f1f77bcf86cd799439044', code: 'CONTACT_HAS_LINKED_STORIES' }]);
});

test('bulk remove response allows complete soft removal without dependency skips', () => {
  const response = _buildBulkReporterContactMutationResponse(
    ['507f1f77bcf86cd799439031', '507f1f77bcf86cd799439032'],
    []
  );

  assert.strictEqual(response.removed, true);
  assert.strictEqual(response.removedCount, 2);
  assert.deepStrictEqual(response.removedIds, ['507f1f77bcf86cd799439031', '507f1f77bcf86cd799439032']);
  assert.deepStrictEqual(response.skipped, []);
});

test('directory returns active contacts by default and removed contacts for removed-list filters', () => {
  const rows = [
    { id: 'visible-1', name: 'Visible Reporter', status: 'archived', verification: 'verified', type: 'community', reporterType: 'community', missingPhone: false, missingLocation: false },
    { id: 'hidden-1', name: 'Hidden Reporter', archivedAt: '2026-04-07T08:00:00.000Z', verification: 'verified', type: 'community', reporterType: 'community', missingPhone: false, missingLocation: false },
  ];

  const visible = _filterReporterDirectoryRows(rows, { query: {} }, null);
  const hidden = _filterReporterDirectoryRows(rows, { query: { status: 'removed', includeHidden: 'true' } }, null);
  const defaultFilters = _buildReporterDirectoryFilters({ query: {} });
  const hiddenFilters = _buildReporterDirectoryFilters({ query: { includeHidden: 'true', status: 'removed' } });

  assert.deepStrictEqual(visible.map((row) => row.id), ['visible-1']);
  assert.deepStrictEqual(hidden.map((row) => row.id), ['hidden-1']);
  assert.deepStrictEqual(defaultFilters.$or, [
    { directoryStatus: 'active' },
    {
      directoryStatus: { $exists: false },
      archivedAt: { $in: [null, undefined] },
      deletedAt: { $in: [null, undefined] },
      archivedBy: { $in: [null, undefined] },
      deletedBy: { $in: [null, undefined] },
    },
  ]);
  assert.deepStrictEqual(hiddenFilters.$or, [
    { directoryStatus: 'removed' },
    {
      directoryStatus: { $exists: false },
      $or: [
        { archivedAt: { $exists: true, $ne: null } },
        { deletedAt: { $exists: true, $ne: null } },
        { archivedBy: { $exists: true, $ne: null } },
        { deletedBy: { $exists: true, $ne: null } },
      ],
    },
  ]);
});

test('legacy moderation status alone does not move a contact into removed', () => {
  const row = _buildCompactDirectoryRow({
    _id: 'legacy-active',
    fullName: 'Legacy Active',
    email: 'legacy@example.com',
    status: 'archived',
  }, null);

  assert.strictEqual(row.rawStatus, 'archived');
  assert.strictEqual(row.directoryStatus, 'active');
  assert.strictEqual(row.status, 'active');
});

test('explicit archive metadata keeps legacy removed contacts in removed', () => {
  const row = _buildCompactDirectoryRow({
    _id: 'legacy-removed',
    fullName: 'Legacy Removed',
    email: 'legacy-removed@example.com',
    status: 'active',
    archivedAt: '2026-04-07T08:00:00.000Z',
  }, null);

  assert.strictEqual(row.directoryStatus, 'removed');
  assert.strictEqual(row.status, 'removed');
});

test('directory visibility rules only allow remove from active and restore/delete from removed', () => {
  const active = _buildDirectoryVisibilityState('active');
  const removed = _buildDirectoryVisibilityState('removed');

  assert.strictEqual(active.directoryStatus, 'active');
  assert.strictEqual(removed.directoryStatus, 'removed');
  assert.strictEqual(_canRemoveReporterContactStatus('active'), true);
  assert.strictEqual(_canRemoveReporterContactStatus('removed'), false);
  assert.strictEqual(_canRestoreReporterContactStatus('active'), false);
  assert.strictEqual(_canRestoreReporterContactStatus('removed'), true);
});

test('permanent delete requires explicit confirmation and archived status semantics', () => {
  assert.strictEqual(_isArchivedLikeReporterStatus('archived'), true);
  assert.strictEqual(_isArchivedLikeReporterStatus('hidden'), true);
  assert.strictEqual(_isArchivedLikeReporterStatus('active'), false);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus('archived'), true);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus('active'), false);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus({ directoryStatus: 'removed', status: 'suspended' }), true);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus('active', { allowActive: true }), true);

  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmPermanentDelete: true } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: { confirm: 'true' }, body: {} }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmed: true } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmationText: 'DELETE' } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmationText: 'delete' } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: {} }), false);
});

test('remove from directory only flips selected contact state fields and preserves contact data', async () => {
  const contactId = '507f1f77bcf86cd799439011';
  const originalFindById = ReporterContact.findById;
  const originalUpdateOne = ReporterContact.updateOne;
  let capturedUpdate = null;

  await withMongoReady(async () => {
    ReporterContact.findById = () => ({
      lean: async () => ({
        _id: contactId,
        fullName: 'Legacy Reporter',
        email: 'legacy@example.com',
        phoneFull: '+919999999999',
        districtName: 'Ahmedabad',
        directoryStatus: 'active',
        status: 'archived',
      }),
    });
    ReporterContact.updateOne = async (_filter, update) => {
      capturedUpdate = update;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const req = {
      params: { id: contactId },
      body: { reason: 'manual cleanup' },
      query: {},
      originalUrl: `/api/admin/community-reporter/contacts/${contactId}/remove-from-directory`,
      path: `/contacts/${contactId}/remove-from-directory`,
      method: 'POST',
      headers: {},
      admin: { id: 'admin-1', email: 'admin@example.com', role: 'founder' },
    };
    const res = makeJsonResponse();

    await controller.hideReporterContact(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.directoryStatus, 'removed');
    assert.ok(capturedUpdate);
    assert.deepStrictEqual(Object.keys(capturedUpdate).sort(), ['$set']);
    assert.strictEqual(capturedUpdate.$set.directoryStatus, 'removed');
    assert.ok(capturedUpdate.$set.archivedAt instanceof Date);
    assert.deepStrictEqual(capturedUpdate.$set.archivedBy, {
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'founder',
    });
    assert.strictEqual(capturedUpdate.$set.archivedReason, 'manual cleanup');
    assert.strictEqual(capturedUpdate.$set.fullName, undefined);
    assert.strictEqual(capturedUpdate.$set.email, undefined);
    assert.strictEqual(capturedUpdate.$set.phoneFull, undefined);
    assert.strictEqual(capturedUpdate.$set.districtName, undefined);
    assert.strictEqual(capturedUpdate.$set.status, undefined);
  });

  ReporterContact.findById = originalFindById;
  ReporterContact.updateOne = originalUpdateOne;
});

test('restore only flips removed contact back to active and clears removal metadata without touching contact fields', async () => {
  const contactId = '507f1f77bcf86cd799439012';
  const originalFindById = ReporterContact.findById;
  const originalUpdateOne = ReporterContact.updateOne;
  let capturedUpdate = null;

  await withMongoReady(async () => {
    ReporterContact.findById = () => ({
      lean: async () => ({
        _id: contactId,
        fullName: 'Removed Reporter',
        email: 'removed@example.com',
        phoneFull: '+918888888888',
        districtName: 'Surat',
        directoryStatus: 'removed',
        archivedAt: new Date('2026-04-07T08:00:00.000Z'),
        archivedBy: { id: 'admin-2' },
      }),
    });
    ReporterContact.updateOne = async (_filter, update) => {
      capturedUpdate = update;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const req = {
      params: { id: contactId },
      body: {},
      query: {},
      originalUrl: `/api/admin/community-reporter/contacts/${contactId}/restore`,
      path: `/contacts/${contactId}/restore`,
      method: 'POST',
      headers: {},
      admin: { id: 'admin-9', email: 'restorer@example.com', role: 'founder' },
    };
    const res = makeJsonResponse();

    await controller.restoreReporterContact(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.directoryStatus, 'active');
    assert.ok(capturedUpdate);
    assert.deepStrictEqual(Object.keys(capturedUpdate).sort(), ['$set', '$unset']);
    assert.strictEqual(capturedUpdate.$set.directoryStatus, 'active');
    assert.ok(capturedUpdate.$set.restoredAt instanceof Date);
    assert.deepStrictEqual(capturedUpdate.$set.restoredBy, {
      id: 'admin-9',
      email: 'restorer@example.com',
      role: 'founder',
    });
    assert.deepStrictEqual(capturedUpdate.$unset, {
      archivedAt: 1,
      archivedBy: 1,
      archivedReason: 1,
      deletedAt: 1,
      deletedBy: 1,
    });
    assert.strictEqual(capturedUpdate.$set.fullName, undefined);
    assert.strictEqual(capturedUpdate.$set.email, undefined);
    assert.strictEqual(capturedUpdate.$set.phoneFull, undefined);
    assert.strictEqual(capturedUpdate.$set.districtName, undefined);
    assert.strictEqual(capturedUpdate.$set.status, undefined);
  });

  ReporterContact.findById = originalFindById;
  ReporterContact.updateOne = originalUpdateOne;
});

test('bulk restore returns precise success, missing, and invalid-state ids for selected removed contacts', async () => {
  const originalCountDocuments = ReporterContact.countDocuments;
  const originalFindById = ReporterContact.findById;
  const originalUpdateOne = ReporterContact.updateOne;

  const removedId = '507f1f77bcf86cd799439101';
  const activeId = '507f1f77bcf86cd799439102';
  const missingId = '507f1f77bcf86cd799439103';
  const contactStateById = {
    [removedId]: { _id: removedId, directoryStatus: 'removed', archivedAt: new Date('2026-04-07T08:00:00.000Z') },
    [activeId]: { _id: activeId, directoryStatus: 'active' },
  };
  const updates = [];

  await withMongoReady(async () => {
    ReporterContact.countDocuments = async () => 2;
    ReporterContact.findById = (id) => ({
      lean: async () => contactStateById[id] || null,
    });
    ReporterContact.updateOne = async (filter, update) => {
      updates.push({ filter, update });
      return { acknowledged: true, modifiedCount: 1 };
    };

    const req = {
      body: { ids: [removedId, activeId, missingId] },
      query: {},
      method: 'POST',
      headers: {},
      admin: { id: 'admin-restore-bulk', email: 'restore-bulk@example.com', role: 'founder' },
    };
    const res = makeJsonResponse();

    await controller.bulkRestoreReporterContacts(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.successCount, 1);
    assert.strictEqual(res.body.restoredCount, 1);
    assert.deepStrictEqual(res.body.restoredIds, [removedId]);
    assert.strictEqual(res.body.failedCount, 2);
    assert.deepStrictEqual(res.body.failedIds, [activeId, missingId]);
    assert.strictEqual(res.body.missingCount, 1);
    assert.deepStrictEqual(res.body.missingIds, [missingId]);
    assert.strictEqual(res.body.invalidStateCount, 1);
    assert.deepStrictEqual(res.body.invalidStateIds, [activeId]);
    assert.strictEqual(res.body.blockedCount, 0);
    assert.deepStrictEqual(res.body.blockedIds, []);
    assert.deepStrictEqual(res.body.failures, [
      { id: activeId, code: 'CONTACT_NOT_REMOVED', message: 'Restore is only allowed for removed contacts' },
      { id: missingId, code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' },
    ]);
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(updates[0].filter, { _id: removedId });
    assert.strictEqual(updates[0].update.$set.directoryStatus, 'active');
  });

  ReporterContact.countDocuments = originalCountDocuments;
  ReporterContact.findById = originalFindById;
  ReporterContact.updateOne = originalUpdateOne;
});

test('bulk permanent delete requires explicit confirmation and only deletes selected removed contacts', async () => {
  const originalCountDocuments = ReporterContact.countDocuments;
  const originalFindById = ReporterContact.findById;
  const originalDeleteOne = ReporterContact.deleteOne;
  const originalSubmissionCountDocuments = CommunitySubmission.countDocuments;
  const originalSubmissionUpdateMany = CommunitySubmission.updateMany;
  const originalProfileCountDocuments = ReporterProfile.countDocuments;
  const originalProfileUpdateMany = ReporterProfile.updateMany;

  const removedId = '507f1f77bcf86cd799439111';
  const activeId = '507f1f77bcf86cd799439112';
  const missingId = '507f1f77bcf86cd799439113';
  const contactsById = {
    [removedId]: { _id: removedId, email: 'removed@example.com', directoryStatus: 'removed' },
    [activeId]: { _id: activeId, email: 'active@example.com', directoryStatus: 'active' },
  };
  const deletedFilters = [];

  await withMongoReady(async () => {
    ReporterContact.countDocuments = async () => 2;
    ReporterContact.findById = async (id) => contactsById[id] || null;
    ReporterContact.deleteOne = async (filter) => {
      deletedFilters.push(filter);
      return { acknowledged: true, deletedCount: 1 };
    };
    CommunitySubmission.countDocuments = async () => 0;
    CommunitySubmission.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    ReporterProfile.countDocuments = async () => 0;
    ReporterProfile.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });

    const missingConfirmationReq = {
      body: { ids: [removedId] },
      query: {},
      method: 'POST',
      headers: {},
      admin: { id: 'admin-delete-bulk', email: 'delete-bulk@example.com', role: 'founder' },
    };
    const missingConfirmationRes = makeJsonResponse();

    await controller.bulkPermanentlyDeleteReporterContacts(missingConfirmationReq, missingConfirmationRes);

    assert.strictEqual(missingConfirmationRes.statusCode, 400);
    assert.strictEqual(missingConfirmationRes.body.code, 'DELETE_CONFIRMATION_REQUIRED');
    assert.strictEqual(missingConfirmationRes.body.invalidConfirmation, true);
    assert.deepStrictEqual(missingConfirmationRes.body.details, _buildReporterContactPermanentDeleteContract());

    const req = {
      body: { ids: [removedId, activeId, missingId], confirmPermanentDelete: true },
      query: {},
      method: 'POST',
      headers: {},
      admin: { id: 'admin-delete-bulk', email: 'delete-bulk@example.com', role: 'founder' },
    };
    const res = makeJsonResponse();

    await controller.bulkPermanentlyDeleteReporterContacts(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.successCount, 1);
    assert.strictEqual(res.body.deletedCount, 1);
    assert.deepStrictEqual(res.body.deletedIds, [removedId]);
    assert.strictEqual(res.body.failedCount, 2);
    assert.deepStrictEqual(res.body.failedIds, [activeId, missingId]);
    assert.strictEqual(res.body.missingCount, 1);
    assert.deepStrictEqual(res.body.missingIds, [missingId]);
    assert.strictEqual(res.body.invalidStateCount, 1);
    assert.deepStrictEqual(res.body.invalidStateIds, [activeId]);
    assert.strictEqual(res.body.blockedCount, 0);
    assert.deepStrictEqual(res.body.blockedIds, []);
    assert.deepStrictEqual(res.body.requestContract, _buildReporterContactPermanentDeleteContract());
    assert.deepStrictEqual(res.body.failures, [
      { id: activeId, code: 'CONTACT_NOT_REMOVED', message: 'Permanent delete is only allowed for removed contacts' },
      { id: missingId, code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' },
    ]);
    assert.deepStrictEqual(deletedFilters, [{ _id: removedId }]);
  });

  ReporterContact.countDocuments = originalCountDocuments;
  ReporterContact.findById = originalFindById;
  ReporterContact.deleteOne = originalDeleteOne;
  CommunitySubmission.countDocuments = originalSubmissionCountDocuments;
  CommunitySubmission.updateMany = originalSubmissionUpdateMany;
  ReporterProfile.countDocuments = originalProfileCountDocuments;
  ReporterProfile.updateMany = originalProfileUpdateMany;
});

test('bulk permanent delete detaches linked stories and contributor profiles before deleting removed contacts', async () => {
  const originalCountDocuments = ReporterContact.countDocuments;
  const originalFindById = ReporterContact.findById;
  const originalDeleteOne = ReporterContact.deleteOne;
  const originalSubmissionUpdateMany = CommunitySubmission.updateMany;
  const originalProfileUpdateMany = ReporterProfile.updateMany;

  const removedId = '507f1f77bcf86cd799439114';
  const contactsById = {
    [removedId]: { _id: removedId, email: 'detached@example.com', directoryStatus: 'removed' },
  };
  const submissionUpdates = [];
  const profileUpdates = [];
  const deletedFilters = [];

  await withMongoReady(async () => {
    ReporterContact.countDocuments = async () => 1;
    ReporterContact.findById = async (id) => contactsById[id] || null;
    ReporterContact.deleteOne = async (filter) => {
      deletedFilters.push(filter);
      return { acknowledged: true, deletedCount: 1 };
    };
    CommunitySubmission.updateMany = async (filter, update) => {
      submissionUpdates.push({ filter, update });
      return { acknowledged: true, modifiedCount: submissionUpdates.length };
    };
    ReporterProfile.updateMany = async (filter, update) => {
      profileUpdates.push({ filter, update });
      return { acknowledged: true, modifiedCount: 1 };
    };

    const req = {
      body: { ids: [removedId], confirmPermanentDelete: true },
      query: {},
      method: 'POST',
      headers: {},
      admin: { id: 'admin-delete-bulk', email: 'delete-bulk@example.com', role: 'founder' },
    };
    const res = makeJsonResponse();

    await controller.bulkPermanentlyDeleteReporterContacts(req, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deletedCount, 1);
    assert.deepStrictEqual(deletedFilters, [{ _id: removedId }]);
    assert.strictEqual(submissionUpdates.length, 2);
    assert.deepStrictEqual(submissionUpdates[0], {
      filter: { reporterId: removedId },
      update: { $set: { reporterId: null } },
    });
    assert.deepStrictEqual(profileUpdates, [
      {
        filter: { reporterContactId: removedId },
        update: { $set: { reporterContactId: null } },
      },
    ]);
  });

  ReporterContact.countDocuments = originalCountDocuments;
  ReporterContact.findById = originalFindById;
  ReporterContact.deleteOne = originalDeleteOne;
  CommunitySubmission.updateMany = originalSubmissionUpdateMany;
  ReporterProfile.updateMany = originalProfileUpdateMany;
});

test('hide/remove resolves ReporterContact id from params first, then explicit payload fallback', () => {
  assert.deepStrictEqual(
    _resolveReporterContactIdFromRequest({ params: { id: '507f1f77bcf86cd799439011' }, body: {}, query: {} }),
    { id: '507f1f77bcf86cd799439011', source: 'params.id' }
  );

  assert.deepStrictEqual(
    _resolveReporterContactIdFromRequest({ params: {}, body: { contactId: '507f1f77bcf86cd799439012' }, query: {} }),
    { id: '507f1f77bcf86cd799439012', source: 'body.contactId' }
  );

  assert.deepStrictEqual(
    _resolveReporterContactIdFromRequest({ params: {}, body: { reporterContactId: '507f1f77bcf86cd799439013' }, query: {} }),
    { id: '507f1f77bcf86cd799439013', source: 'body.reporterContactId' }
  );
});