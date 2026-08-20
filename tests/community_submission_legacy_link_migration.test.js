const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const {
  portalEligibleReporterFilter,
  runMigration,
} = require('../scripts/link-legacy-community-submissions-to-reporters');

const originalReporterFind = ReporterContact.find;
const originalSubmissionFind = CommunitySubmission.find;
const originalSubmissionCountDocuments = CommunitySubmission.countDocuments;
const originalSubmissionUpdateMany = CommunitySubmission.updateMany;

let reporters;
let submissions;
let updateCalls;

function clone(value) {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function getPathValue(doc, path) {
  return String(path || '').split('.').reduce((value, part) => (value == null ? undefined : value[part]), doc);
}

function isEmptyOwner(value) {
  return value === undefined || value === null || value === '';
}

function sameValue(left, right) {
  return String(left || '') === String(right || '');
}

function matchesFilter(doc, filter) {
  if (!filter || typeof filter !== 'object') return true;

  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$and') return Array.isArray(expected) && expected.every((entry) => matchesFilter(doc, entry));
    if (key === '$or') return Array.isArray(expected) && expected.some((entry) => matchesFilter(doc, entry));
    const actual = getPathValue(doc, key);

    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (Object.prototype.hasOwnProperty.call(expected, '$exists')) {
        return expected.$exists ? actual !== undefined : actual === undefined;
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$ne')) {
        return !sameValue(actual, expected.$ne);
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$nin')) {
        return !expected.$nin.some((value) => sameValue(actual, value));
      }
      if (Object.prototype.hasOwnProperty.call(expected, '$in')) {
        return expected.$in.some((value) => sameValue(actual, value));
      }
    }

    return sameValue(actual, expected);
  });
}

function makeFindQuery(items) {
  const state = { items: items.map((item) => clone(item)), limit: null };
  return {
    sort() { return this; },
    select() { return this; },
    limit(value) {
      state.limit = value;
      return this;
    },
    async lean() {
      return state.items.slice(0, state.limit || undefined).map((item) => clone(item));
    },
  };
}

test.beforeEach(() => {
  reporters = [
    {
      _id: '507f191e810c19729de861aa',
      email: 'verified@example.com',
      emailLower: 'verified@example.com',
      verificationLevel: 'verified',
      portalAccessEnabled: true,
      status: 'active',
      directoryStatus: 'active',
    },
    {
      _id: '507f191e810c19729de861bb',
      email: 'Mixed.Case@Example.com',
      emailLower: 'unverified@example.com',
      verificationLevel: 'community_default',
      portalAccessEnabled: true,
      status: 'active',
      directoryStatus: 'active',
    },
    {
      _id: '507f191e810c19729de861ff',
      email: 'restricted@example.com',
      emailLower: 'restricted@example.com',
      verificationLevel: 'verified',
      portalAccessEnabled: false,
      status: 'active',
      directoryStatus: 'active',
    },
  ];
  submissions = [
    {
      _id: '507f1f77bcf86cd799439101',
      reporterEmailNorm: 'verified@example.com',
      reporterAccountId: null,
      reporterId: null,
      isDeleted: false,
    },
    {
      _id: '507f1f77bcf86cd799439102',
      reporterEmailNorm: 'verified@example.com',
      reporterAccountId: '507f191e810c19729de861aa',
      reporterId: '507f191e810c19729de861aa',
      isDeleted: false,
    },
    {
      _id: '507f1f77bcf86cd799439103',
      reporterEmailNorm: 'verified@example.com',
      reporterAccountId: '507f191e810c19729de861cc',
      reporterId: '507f191e810c19729de861cc',
      isDeleted: false,
    },
    {
      _id: '507f1f77bcf86cd799439104',
      reporterEmailNorm: ' mixed.case@example.com ',
      reporterAccountId: null,
      reporterId: null,
      isDeleted: false,
    },
    {
      _id: '507f1f77bcf86cd799439105',
      reporterEmailNorm: 'verified@example.com',
      reporterAccountId: null,
      reporterId: '507f191e810c19729de861dd',
      isDeleted: false,
    },
    {
      _id: '507f1f77bcf86cd799439106',
      reporterEmailNorm: 'restricted@example.com',
      reporterAccountId: null,
      reporterId: null,
      isDeleted: false,
    },
  ];
  updateCalls = [];

  ReporterContact.find = (filter) => makeFindQuery(reporters.filter((reporter) => matchesFilter(reporter, filter)));
  CommunitySubmission.find = (filter) => makeFindQuery(submissions.filter((submission) => matchesFilter(submission, filter)));
  CommunitySubmission.countDocuments = async (filter) => submissions.filter((submission) => matchesFilter(submission, filter)).length;
  CommunitySubmission.updateMany = async (filter, update) => {
    updateCalls.push({ filter: clone(filter), update: clone(update) });
    let matchedCount = 0;
    let modifiedCount = 0;
    submissions = submissions.map((submission) => {
      if (!matchesFilter(submission, filter)) return submission;
      matchedCount += 1;
      if (!isEmptyOwner(submission.reporterAccountId) || !isEmptyOwner(submission.reporterId)) return submission;
      modifiedCount += 1;
      return { ...submission, ...(update && update.$set ? clone(update.$set) : {}) };
    });
    return { acknowledged: true, matchedCount, modifiedCount };
  };
});

test.after(() => {
  ReporterContact.find = originalReporterFind;
  CommunitySubmission.find = originalSubmissionFind;
  CommunitySubmission.countDocuments = originalSubmissionCountDocuments;
  CommunitySubmission.updateMany = originalSubmissionUpdateMany;
});

test('legacy link migration uses Reporter Portal account eligibility filter', () => {
  assert.deepStrictEqual(portalEligibleReporterFilter(), {
    portalAccessEnabled: { $ne: false },
    status: { $nin: ['suspended', 'banned'] },
  });
});

test('legacy link migration dry-run reports eligible portal account matches without writing', async () => {
  const result = await runMigration({ args: { confirm: false, limit: 0 } });

  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(result.reporterCount, 2);
  assert.strictEqual(result.totalSubmissions, 6);
  assert.strictEqual(result.matchedReporterCount, 2);
  assert.strictEqual(result.unmatchedReporterEmailCount, 1);
  assert.strictEqual(result.writes.length, 0);
  assert.strictEqual(updateCalls.length, 0);
  assert.deepStrictEqual(result.counts, {
    eligibleCount: 2,
    alreadyOwnedCount: 2,
    alreadyOwnedRecords: 2,
    noVerifiedReporterCount: 1,
    ambiguousCount: 0,
    missingEmailCount: 0,
    conflictCount: 1,
    recordsWithLegacyEmail: 6,
    recordsWithoutLegacyEmail: 0,
  });
  assert.strictEqual(result.eligibleCount, 2);
  assert.strictEqual(result.noVerifiedReporterCount, 1);
});

test('legacy link migration confirm links only unowned records and never reassigns owned records', async () => {
  const result = await runMigration({ args: { confirm: true, limit: 0 } });

  assert.strictEqual(result.mode, 'confirm');
  assert.strictEqual(result.writes.length, 2);
  assert.strictEqual(result.writes.reduce((sum, write) => sum + write.modifiedCount, 0), 2);

  const linked = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439101');
  assert.strictEqual(String(linked.reporterAccountId), '507f191e810c19729de861aa');
  assert.strictEqual(String(linked.reporterId), '507f191e810c19729de861aa');

  const alreadyOwned = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439102');
  assert.strictEqual(String(alreadyOwned.reporterAccountId), '507f191e810c19729de861aa');

  const conflict = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439103');
  assert.strictEqual(String(conflict.reporterAccountId), '507f191e810c19729de861cc');

  const normalizedMatch = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439104');
  assert.strictEqual(String(normalizedMatch.reporterAccountId), '507f191e810c19729de861bb');
  assert.strictEqual(String(normalizedMatch.reporterId), '507f191e810c19729de861bb');

  const conflictingLink = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439105');
  assert.strictEqual(conflictingLink.reporterAccountId, null);
  assert.strictEqual(String(conflictingLink.reporterId), '507f191e810c19729de861dd');

  const restrictedMatch = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439106');
  assert.strictEqual(restrictedMatch.reporterAccountId, null);
  assert.strictEqual(restrictedMatch.reporterId, null);
});

test('legacy link migration leaves ambiguous portal account email matches untouched', async () => {
  reporters.push({
    _id: '507f191e810c19729de861ee',
    email: 'verified@example.com',
    emailLower: 'verified@example.com',
    verificationLevel: 'verified',
    portalAccessEnabled: true,
    status: 'active',
    directoryStatus: 'active',
  });

  const result = await runMigration({ args: { confirm: true, limit: 0 } });

  assert.strictEqual(result.mode, 'confirm');
  assert.strictEqual(result.counts.eligibleCount, 1);
  assert.strictEqual(result.counts.ambiguousCount, 2);
  assert.strictEqual(result.writes.length, 1);
  assert.strictEqual(updateCalls.length, 1);

  const ambiguous = submissions.find((submission) => submission._id === '507f1f77bcf86cd799439101');
  assert.strictEqual(ambiguous.reporterAccountId, null);
  assert.strictEqual(ambiguous.reporterId, null);
});