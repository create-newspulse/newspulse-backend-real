const test = require('node:test');
const assert = require('node:assert');

const controller = require('../controllers/communityReporterController');

const {
  _applyDirectoryManualUpdateToContact,
  _buildBulkReporterContactMutationResponse,
  _buildCompactDirectoryRow,
  _buildReporterDirectoryFilters,
  _buildReporterDirectorySummaryPayload,
  _buildReporterProfileContract,
  _filterReporterDirectoryRows,
  _canPermanentlyDeleteReporterStatus,
  _hasPermanentDeleteConfirmation,
  _isArchivedLikeReporterStatus,
  _resolveReporterContactIdFromRequest,
} = controller.__test;

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

  assert.deepStrictEqual(Object.keys(summary), [
    'total',
    'verified',
    'missingPhone',
    'missingLocation',
    'activeThisMonth',
    'newThisMonth',
    'lastSubmissionAt',
  ]);
  assert.strictEqual(summary.total, 2);
  assert.strictEqual(summary.verified, 1);
  assert.strictEqual(summary.missingPhone, 1);
  assert.strictEqual(summary.missingLocation, 1);
  assert.strictEqual(summary.activeThisMonth, 1);
  assert.strictEqual(summary.newThisMonth, 1);
  assert.strictEqual(summary.lastSubmissionAt, '2026-04-06T10:00:00.000Z');
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
  assert.strictEqual(row.phone, 'xxxxxx1234');
  assert.strictEqual(row.maskedPhone, 'xxxxxx1234');
  assert.strictEqual(row.fullPhone, '+919999991234');
  assert.strictEqual(row.city, 'Ahmedabad');
  assert.strictEqual(row.district, 'Ahmedabad');
  assert.strictEqual(row.state, 'Gujarat');
  assert.strictEqual(row.reporterType, 'community');
  assert.strictEqual(row.type, 'community');
  assert.strictEqual(row.verification, 'verified');
  assert.strictEqual(row.directoryState, 'active');
  assert.strictEqual(row.isRemovedFromDirectory, false);
  assert.strictEqual(row.isVisibleInDirectory, true);
  assert.strictEqual(row.directory.state, 'active');
  assert.strictEqual(row.directory.canRemoveFromDirectory, true);
  assert.strictEqual(row.directory.canRestore, false);
  assert.strictEqual(row.directory.canDeletePermanently, false);
  assert.strictEqual(row.totalStories, 18);
  assert.strictEqual(row.approvedStories, 12);
  assert.strictEqual(row.pendingStories, 3);
  assert.strictEqual(row.actions.viewStories, true);
  assert.strictEqual(row.actions.profile, true);
  assert.strictEqual(row.actions.archive, false);
  assert.strictEqual(row.actions.removeFromDirectory, true);
  assert.strictEqual(row.actions.restore, false);
  assert.strictEqual(row.actions.deletePermanently, false);
  assert.strictEqual(row.deleteMode, 'archive_only');
  assert.deepStrictEqual(row.availableActions, ['email', 'view_stories', 'profile', 'remove_from_directory']);
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
  assert.strictEqual(profile.reporterType, 'community');
  assert.strictEqual(profile.verification, 'verified');
  assert.strictEqual(profile.directoryState, 'active');
  assert.strictEqual(profile.isRemovedFromDirectory, false);
  assert.strictEqual(profile.isVisibleInDirectory, true);
  assert.strictEqual(profile.directory.state, 'active');
  assert.strictEqual(profile.directory.canRemoveFromDirectory, true);
  assert.strictEqual(profile.directory.canRestore, false);
  assert.strictEqual(profile.directory.canDeletePermanently, false);
  assert.strictEqual(profile.overview.directoryState, 'active');
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

  assert.strictEqual(profile.status, 'archived');
  assert.strictEqual(profile.directoryState, 'removed');
  assert.strictEqual(profile.isRemovedFromDirectory, true);
  assert.strictEqual(profile.isVisibleInDirectory, false);
  assert.strictEqual(profile.directory.state, 'removed');
  assert.strictEqual(profile.directory.isRemovedFromDirectory, true);
  assert.strictEqual(profile.directory.isVisibleInDirectory, false);
  assert.strictEqual(profile.directory.canRemoveFromDirectory, false);
  assert.strictEqual(profile.directory.canRestore, true);
  assert.strictEqual(profile.directory.canDeletePermanently, true);
  assert.strictEqual(profile.directory.removedAt, '2026-04-07T08:00:00.000Z');
  assert.strictEqual(profile.directory.removedBy, 'admin@newspulse.ai');
  assert.strictEqual(profile.directory.restoreRoute, '/api/admin/community-reporter/contacts/contact-2/restore');
  assert.strictEqual(profile.directory.permanentDeleteRoute, '/api/admin/community-reporter/contacts/contact-2/permanent-delete');
  assert.strictEqual(profile.overview.directoryState, 'removed');
  assert.strictEqual(profile.overview.isRemovedFromDirectory, true);
  assert.strictEqual(profile.overview.isVisibleInDirectory, false);
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
    { id: 'visible-1', name: 'Visible Reporter', status: 'active', verification: 'verified', type: 'community', reporterType: 'community', missingPhone: false, missingLocation: false },
    { id: 'hidden-1', name: 'Hidden Reporter', status: 'archived', verification: 'verified', type: 'community', reporterType: 'community', missingPhone: false, missingLocation: false },
  ];

  const visible = _filterReporterDirectoryRows(rows, { query: {} }, null);
  const hidden = _filterReporterDirectoryRows(rows, { query: { status: 'removed', includeHidden: 'true' } }, null);
  const defaultFilters = _buildReporterDirectoryFilters({ query: {} });
  const hiddenFilters = _buildReporterDirectoryFilters({ query: { includeHidden: 'true', status: 'removed' } });

  assert.deepStrictEqual(visible.map((row) => row.id), ['visible-1']);
  assert.deepStrictEqual(hidden.map((row) => row.id), ['hidden-1']);
  assert.deepStrictEqual(defaultFilters.status, { $nin: ['archived', 'banned', 'deleted'] });
  assert.deepStrictEqual(hiddenFilters.status, { $in: ['archived', 'banned', 'deleted'] });
});

test('permanent delete requires explicit confirmation and archived status semantics', () => {
  assert.strictEqual(_isArchivedLikeReporterStatus('archived'), true);
  assert.strictEqual(_isArchivedLikeReporterStatus('hidden'), true);
  assert.strictEqual(_isArchivedLikeReporterStatus('active'), false);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus('archived'), true);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus('active'), false);
  assert.strictEqual(_canPermanentlyDeleteReporterStatus('active', { allowActive: true }), true);

  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: { confirm: 'true' }, body: {} }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmed: true } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmationText: 'DELETE' } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: { confirmationText: 'delete' } }), true);
  assert.strictEqual(_hasPermanentDeleteConfirmation({ query: {}, body: {} }), false);
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