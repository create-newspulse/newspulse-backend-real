/**
 * One-time migration: link legacy unowned CommunitySubmission records to Reporter Portal accounts.
 *
 * Default is dry-run only. Pass --confirm to apply eligible links.
 * Logs only aggregate counts by default.
 */
require('dotenv').config();

const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const { normalizeEmail } = require('../lib/normalizeEmail');

function parseArgs(argv = []) {
  const args = { confirm: false, reporterEmail: null, reporterId: null, limit: 0 };
  for (const raw of argv) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (value === '--confirm') args.confirm = true;
    else if (value === '--dry-run') args.confirm = false;
    else if (value.startsWith('--reporter-email=')) args.reporterEmail = normalizeEmail(value.slice('--reporter-email='.length));
    else if (value.startsWith('--reporter-id=')) args.reporterId = value.slice('--reporter-id='.length).trim();
    else if (value.startsWith('--limit=')) args.limit = Math.max(parseInt(value.slice('--limit='.length), 10) || 0, 0);
  }
  return args;
}

function ownerMissingFilter() {
  return {
    $or: [{ reporterAccountId: { $exists: false } }, { reporterAccountId: null }, { reporterAccountId: '' }],
  };
}

function ownerMatchesFilter(reporterId) {
  return {
    $or: [
      { reporterAccountId: reporterId },
      { reporterId },
    ],
  };
}

function emailMatchFilter(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { _id: null };
  return {
    $or: [
      { reporterEmailNorm: normalized },
      { reporterEmail: normalized },
      { email: normalized },
      { 'contact.email': normalized },
    ],
  };
}

function portalEligibleReporterFilter(args = {}) {
  const filter = {
    portalAccessEnabled: { $ne: false },
    status: { $nin: ['suspended', 'banned'] },
  };
  if (args.reporterEmail) {
    filter.$or = [{ email: args.reporterEmail }, { emailLower: args.reporterEmail }];
  }
  if (args.reporterId) {
    filter._id = args.reporterId;
  }
  return filter;
}

function toId(value) {
  return value && typeof value.toString === 'function' ? value.toString() : String(value || '');
}

function isMissingOwner(value) {
  return value === undefined || value === null || value === '';
}

function getSubmissionLegacyEmail(submission) {
  return normalizeEmail(
    submission?.reporterEmailNorm
    || submission?.reporterEmail
    || submission?.email
    || submission?.contact?.email
  );
}

function buildReporterEmailMap(reporters) {
  const map = new Map();
  for (const reporter of reporters || []) {
    const email = normalizeEmail(reporter?.email || reporter?.emailLower);
    const reporterId = toId(reporter?._id);
    if (!email || !reporterId) continue;
    if (!map.has(email)) map.set(email, []);
    map.get(email).push({ _id: reporterId, email });
  }
  return map;
}

function summarizeReporterEmailMatches(submissions, reporters) {
  const reporterMap = buildReporterEmailMap(reporters);
  const submissionEmails = new Set();
  for (const submission of submissions || []) {
    const email = getSubmissionLegacyEmail(submission);
    if (email) submissionEmails.add(email);
  }

  let matchedReporterCount = 0;
  let unmatchedReporterEmailCount = 0;
  for (const email of submissionEmails) {
    const matches = reporterMap.get(email) || [];
    if (matches.length > 0) matchedReporterCount += matches.length;
    else unmatchedReporterEmailCount += 1;
  }

  return { matchedReporterCount, unmatchedReporterEmailCount };
}

function classifySubmissions(submissions, reporters) {
  const reporterMap = buildReporterEmailMap(reporters);
  const counts = {
    eligibleCount: 0,
    alreadyOwnedCount: 0,
    alreadyOwnedRecords: 0,
    noVerifiedReporterCount: 0,
    ambiguousCount: 0,
    missingEmailCount: 0,
    conflictCount: 0,
    recordsWithLegacyEmail: 0,
    recordsWithoutLegacyEmail: 0,
  };
  const eligibleLinks = [];

  for (const submission of submissions || []) {
    const submissionId = toId(submission?._id);
    const reporterAccountId = toId(submission?.reporterAccountId);
    const reporterId = toId(submission?.reporterId);
    const email = getSubmissionLegacyEmail(submission);

    if (email) counts.recordsWithLegacyEmail += 1;
    else counts.recordsWithoutLegacyEmail += 1;

    if (!isMissingOwner(reporterAccountId)) {
      counts.alreadyOwnedCount += 1;
      counts.alreadyOwnedRecords += 1;
      continue;
    }

    if (!email) {
      counts.missingEmailCount += 1;
      continue;
    }

    const matches = reporterMap.get(email) || [];
    if (matches.length === 0) {
      counts.noVerifiedReporterCount += 1;
      continue;
    }
    if (matches.length > 1) {
      counts.ambiguousCount += 1;
      continue;
    }

    const reporter = matches[0];
    if (!isMissingOwner(reporterId) && reporterId !== reporter._id) {
      counts.conflictCount += 1;
      continue;
    }

    counts.eligibleCount += 1;
    eligibleLinks.push({ submissionId, reporterId: reporter._id, email });
  }

  return { counts, eligibleLinks };
}

async function summarizeReporter(reporter) {
  const reporterId = reporter && reporter._id;
  const email = normalizeEmail(reporter && (reporter.email || reporter.emailLower));
  if (!reporterId || !email) return null;

  const base = { isDeleted: { $ne: true } };
  const legacyEmailMatch = emailMatchFilter(email);
  const ownerMissing = ownerMissingFilter();
  const ownerMatches = ownerMatchesFilter(reporterId);

  const [matchingUnownedDocs, alreadyOwnedCount, matchingEmailDocs] = await Promise.all([
    CommunitySubmission.find({ ...base, $and: [legacyEmailMatch, ownerMissing] }).select('_id').lean(),
    CommunitySubmission.countDocuments({ ...base, $and: [legacyEmailMatch, ownerMatches] }),
    CommunitySubmission.find({ ...base, ...legacyEmailMatch }).select('_id reporterAccountId reporterId').lean(),
  ]);

  const matchingUnownedIds = matchingUnownedDocs.map((doc) => toId(doc._id));
  const ownedIds = new Set(
    matchingEmailDocs
      .filter((doc) => toId(doc.reporterAccountId) === toId(reporterId) || toId(doc.reporterId) === toId(reporterId))
      .map((doc) => toId(doc._id))
  );
  const unownedIds = new Set(matchingUnownedIds);
  const conflictIds = matchingEmailDocs
    .map((doc) => toId(doc._id))
    .filter((id) => !ownedIds.has(id) && !unownedIds.has(id));

  return {
    verifiedReporter: toId(reporterId),
    matchingUnownedCount: matchingUnownedIds.length,
    alreadyOwnedCount,
    conflictCount: conflictIds.length,
    matchingUnownedIds,
    conflictIds,
  };
}

async function applyEligibleLink(link) {
  if (!link || !link.submissionId || !link.reporterId) {
    return { matchedCount: 0, modifiedCount: 0 };
  }
  return CommunitySubmission.updateMany(
    {
      $and: [
        { _id: link.submissionId },
        ownerMissingFilter(),
        {
          $or: [
            { reporterId: { $exists: false } },
            { reporterId: null },
            { reporterId: '' },
            { reporterId: link.reporterId },
          ],
        },
      ],
    },
    {
      $set: {
        reporterAccountId: link.reporterId,
        reporterId: link.reporterId,
        reporterEmailNorm: link.email,
      },
    }
  );
}

async function runMigration(options = {}) {
  const args = options.args || parseArgs(options.argv || process.argv.slice(2));
  const reporterQuery = ReporterContact.find(portalEligibleReporterFilter(args)).sort({ _id: 1 });
  if (typeof reporterQuery.select === 'function') reporterQuery.select('_id email emailLower');
  const reporters = await reporterQuery.lean();
  const submissionFilter = { isDeleted: { $ne: true } };
  if (args.reporterEmail) {
    submissionFilter.$and = [emailMatchFilter(args.reporterEmail)];
  }
  const submissionQuery = CommunitySubmission.find(submissionFilter)
    .select('_id reporterAccountId reporterId reporterEmailNorm reporterEmail email contact.email')
    .sort({ _id: 1 });
  if (args.limit) submissionQuery.limit(args.limit);
  const submissions = await submissionQuery.lean();
  const { counts, eligibleLinks } = classifySubmissions(submissions, reporters);
  const matchSummary = summarizeReporterEmailMatches(submissions, reporters);
  const writes = [];

  if (args.confirm) {
    for (const link of eligibleLinks) {
      const result = await applyEligibleLink(link);
      writes.push({
        verifiedReporter: link.reporterId,
        matchedCount: result.matchedCount || result.n || 0,
        modifiedCount: result.modifiedCount || result.nModified || 0,
      });
    }
  }

  return {
    mode: args.confirm ? 'confirm' : 'dry-run',
    reporterCount: reporters.length,
    totalSubmissions: submissions.length,
    matchedReporterCount: matchSummary.matchedReporterCount,
    unmatchedReporterEmailCount: matchSummary.unmatchedReporterEmailCount,
    ...counts,
    counts,
    writes,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    console.error('MONGODB_URI (or legacy MONGO_URI) not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(JSON.stringify({ mode: args.confirm ? 'confirm' : 'dry-run', confirmRequired: !args.confirm }, null, 2));
  const result = await runMigration({ args });
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (error) => {
    console.error('Legacy link migration failed:', error?.message || error);
    try { await mongoose.disconnect(); } catch (_) {}
    process.exit(1);
  });
}

module.exports = {
  applyEligibleLink,
  buildReporterEmailMap,
  classifySubmissions,
  emailMatchFilter,
  ownerMatchesFilter,
  ownerMissingFilter,
  parseArgs,
  runMigration,
  summarizeReporter,
  summarizeReporterEmailMatches,
  portalEligibleReporterFilter,
  verifiedReporterFilter: portalEligibleReporterFilter,
};