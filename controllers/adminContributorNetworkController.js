const mongoose = require('mongoose');

const ReporterProfile = require('../models/ReporterProfile');
const ReporterTask = require('../models/ReporterTask');
const ReporterActivityLog = require('../models/ReporterActivityLog');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterMergeQueue = require('../models/ReporterMergeQueue');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const ReporterContact = require('../models/ReporterContact');

const { resolveAndAttachForSubmission } = require('../services/reporterIdentityResolution.service');

function isDbReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

function parseIntSafe(v, def) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

async function listProfilesByFlag(req, res, flag) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const page = Math.max(parseIntSafe(req.query.page, 1), 1);
    const limit = Math.min(Math.max(parseIntSafe(req.query.limit, 50), 1), 200);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      ReporterProfile.find({ mergedIntoProfileId: null, flags: flag }).sort({ 'stats.lastStoryAt': -1 }).skip(skip).limit(limit).lean(),
      ReporterProfile.countDocuments({ mergedIntoProfileId: null, flags: flag }),
    ]);

    return res.status(200).json({ ok: true, items, total, page, limit });
  } catch (e) {
    console.error('[contributor-network][queue] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load queue' });
  }
}

async function queueUnresolved(req, res) {
  return listProfilesByFlag(req, res, 'identity_unresolved');
}

async function queueMissingEmail(req, res) {
  return listProfilesByFlag(req, res, 'missing_email');
}

async function queueMissingPhone(req, res) {
  return listProfilesByFlag(req, res, 'missing_phone');
}

async function queueMissingLocation(req, res) {
  return listProfilesByFlag(req, res, 'missing_location');
}

async function listInactiveContributors(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const days = Math.min(Math.max(parseIntSafe(req.query.days, 90), 7), 3650);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);

    const page = Math.max(parseIntSafe(req.query.page, 1), 1);
    const limit = Math.min(Math.max(parseIntSafe(req.query.limit, 50), 1), 200);
    const skip = (page - 1) * limit;

    const filter = {
      mergedIntoProfileId: null,
      status: { $in: ['active', 'inactive'] },
      $or: [
        { 'stats.lastStoryAt': { $lt: cutoff } },
        { 'stats.lastStoryAt': null },
      ],
    };

    const [items, total] = await Promise.all([
      ReporterProfile.find(filter).sort({ 'stats.lastStoryAt': 1 }).skip(skip).limit(limit).lean(),
      ReporterProfile.countDocuments(filter),
    ]);

    return res.status(200).json({ ok: true, cutoff, days, items, total, page, limit });
  } catch (e) {
    console.error('[contributor-network][inactive] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load inactive contributors' });
  }
}

async function highContributionUnverified(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const minStories = Math.min(Math.max(parseIntSafe(req.query.minStories, 10), 1), 100000);

    const filter = {
      mergedIntoProfileId: null,
      verificationTier: { $nin: ['verified_journalist', 'trusted_local'] },
      'stats.totalStories': { $gte: minStories },
    };

    const items = await ReporterProfile.find(filter).sort({ 'stats.totalStories': -1 }).limit(200).lean();
    return res.status(200).json({ ok: true, minStories, items });
  } catch (e) {
    console.error('[contributor-network][high-contribution-unverified] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load contributors' });
  }
}

async function topContributors(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const scope = String(req.query.scope || '').trim();
    const state = String(req.query.state || '').trim();
    const country = String(req.query.country || '').trim();

    const filter = { mergedIntoProfileId: null };
    if (scope) filter.coverageScope = scope;
    if (state) filter['location.stateProvince'] = state;
    if (country) filter['location.country'] = country;

    const items = await ReporterProfile.find(filter).sort({ 'stats.totalStories': -1 }).limit(200).lean();
    return res.status(200).json({ ok: true, items });
  } catch (e) {
    console.error('[contributor-network][top] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load top contributors' });
  }
}

async function addNote(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const profileId = String(req.params.profileId || '').trim();
    if (!mongoose.isValidObjectId(profileId)) return res.status(400).json({ ok: false, message: 'Invalid profileId' });

    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ ok: false, message: 'message is required' });

    const actor = req.admin ? { kind: 'admin', adminId: req.admin.id || null, email: req.admin.email || null, role: req.admin.role || null } : { kind: 'system' };
    await ReporterActivityLog.create({ profileId, type: 'note', message, actor });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[contributor-network][note] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to add note' });
  }
}

async function createTask(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const profileId = String(req.params.profileId || '').trim();
    if (!mongoose.isValidObjectId(profileId)) return res.status(400).json({ ok: false, message: 'Invalid profileId' });

    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ ok: false, message: 'title is required' });

    const doc = await ReporterTask.create({
      profileId,
      title,
      description: req.body?.description ? String(req.body.description).trim() : null,
      dueAt: req.body?.dueAt ? new Date(req.body.dueAt) : null,
      nextFollowUpAt: req.body?.nextFollowUpAt ? new Date(req.body.nextFollowUpAt) : null,
      assignedTo: req.body?.assignedTo ? String(req.body.assignedTo).trim() : null,
      labels: Array.isArray(req.body?.labels) ? req.body.labels.map(String) : [],
    });

    const actor = req.admin ? { kind: 'admin', adminId: req.admin.id || null, email: req.admin.email || null, role: req.admin.role || null } : { kind: 'system' };
    await ReporterActivityLog.create({ profileId, type: 'task_created', message: title, metadata: { taskId: String(doc._id) }, actor });

    return res.status(201).json({ ok: true, taskId: String(doc._id) });
  } catch (e) {
    console.error('[contributor-network][task] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to create task' });
  }
}

async function backfillProfiles(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const limit = Math.min(Math.max(parseIntSafe(req.body?.limit ?? req.query.limit, 5000), 1), 200000);
    const dryRun = String(req.body?.dryRun ?? req.query.dryRun ?? '').toLowerCase() === 'true';

    const cursor = CommunitySubmission.find({ $or: [{ reporterProfileId: { $exists: false } }, { reporterProfileId: null }] })
      .sort({ createdAt: 1 })
      .limit(limit)
      .cursor();

    let scanned = 0;
    let attached = 0;
    for await (const sub of cursor) {
      scanned += 1;
      if (dryRun) continue;
      const out = await resolveAndAttachForSubmission(sub, { req });
      if (out && out.ok) attached += 1;
    }

    return res.status(200).json({ ok: true, scanned, attached, limit, dryRun });
  } catch (e) {
    console.error('[contributor-network][backfill] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Backfill failed' });
  }
}

async function runMergeSuggestions(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    // Simple phase-1 heuristic: same primaryPhone or primaryEmail across profiles.
    // (We do not enforce unique constraints yet; this creates merge queue entries.)
    const byEmail = await ReporterProfile.aggregate([
      { $match: { mergedIntoProfileId: null, primaryEmail: { $ne: null } } },
      { $group: { _id: '$primaryEmail', ids: { $addToSet: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 2000 },
    ]);

    const byPhone = await ReporterProfile.aggregate([
      { $match: { mergedIntoProfileId: null, primaryPhone: { $ne: null } } },
      { $group: { _id: '$primaryPhone', ids: { $addToSet: '$_id' }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 2000 },
    ]);

    const actor = req.admin ? { adminId: req.admin.id || null, email: req.admin.email || null, role: req.admin.role || null } : { adminId: null, email: null, role: null };

    let created = 0;
    const pairs = [];

    function addPairs(rows, kind) {
      for (const row of rows || []) {
        const ids = Array.isArray(row.ids) ? row.ids : [];
        if (ids.length < 2) continue;
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            pairs.push({ a: ids[i], b: ids[j], kind, key: row._id });
          }
        }
      }
    }

    addPairs(byEmail, 'email');
    addPairs(byPhone, 'phone');

    for (const p of pairs.slice(0, 5000)) {
      try {
        await ReporterMergeQueue.updateOne(
          { profileAId: p.a, profileBId: p.b },
          {
            $setOnInsert: {
              profileAId: p.a,
              profileBId: p.b,
              reason: 'duplicate_detected',
              evidence: { kind: p.kind, key: p.key },
              status: 'open',
              createdBy: actor,
            },
          },
          { upsert: true }
        );
        created += 1;
      } catch (_) {}
    }

    return res.status(200).json({ ok: true, created, candidates: pairs.length });
  } catch (e) {
    console.error('[contributor-network][merge-suggestions] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to run merge suggestions' });
  }
}

async function profileDebug(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const profileId = String(req.params.profileId || '').trim();
    if (!mongoose.isValidObjectId(profileId)) return res.status(400).json({ ok: false, message: 'Invalid profileId' });

    const profile = await ReporterProfile.findById(profileId).lean();
    if (!profile) return res.status(404).json({ ok: false, message: 'Profile not found' });

    const [submissionCount, linkCount, recentSubs] = await Promise.all([
      CommunitySubmission.countDocuments({ reporterProfileId: profileId }),
      ReporterStoryLink.countDocuments({ profileId }),
      CommunitySubmission.find({ reporterProfileId: profileId })
        .sort({ createdAt: -1 })
        .limit(50)
        .select('headline status createdAt reporterEmail reporterEmailNorm email contact.phone contact.email reporterId location locationDetail identityResolutionMethod')
        .lean(),
    ]);

    const methods = new Map();
    const reporterIds = new Set();
    let hasAnyPhoneInSubmissions = false;
    let hasAnyLocationInSubmissions = false;
    for (const s of recentSubs || []) {
      const m = String(s.identityResolutionMethod || 'unknown');
      methods.set(m, (methods.get(m) || 0) + 1);
      if (s.reporterId) reporterIds.add(String(s.reporterId));
      if (s?.contact?.phone) hasAnyPhoneInSubmissions = true;
      const loc = s.locationDetail || s.location || null;
      if (loc && (loc.city || loc.state || loc.country || loc.district)) hasAnyLocationInSubmissions = true;
    }

    const reporterContacts = [];
    if (reporterIds.size) {
      const ids = Array.from(reporterIds).filter((x) => mongoose.isValidObjectId(x));
      if (ids.length) {
        const rows = await ReporterContact.find({ _id: { $in: ids } })
          .select('fullName email phoneFull country stateName districtName talukaName cityTownVillage reporterType verificationLevel')
          .lean();
        for (const r of rows || []) reporterContacts.push(r);
      }
    }

    const hasAnyPhoneInDirectory = reporterContacts.some((r) => !!String(r?.phoneFull || '').trim());
    const hasAnyLocationInDirectory = reporterContacts.some((r) => !!(
      String(r?.stateName || '').trim() || String(r?.districtName || '').trim() || String(r?.cityTownVillage || '').trim() || String(r?.country || '').trim()
    ));

    return res.status(200).json({
      ok: true,
      profile,
      storyCounts: {
        submissionsByProfileId: submissionCount,
        reporterStoryLinks: linkCount,
      },
      identityResolution: {
        recentSubmissionMethods: Object.fromEntries(Array.from(methods.entries()).sort((a, b) => b[1] - a[1])),
        recentSubmissionsSampleSize: (recentSubs || []).length,
      },
      dataPresence: {
        hasAnyPhoneInSubmissions,
        hasAnyLocationInSubmissions,
        reporterContactIdsSeen: reporterIds.size,
        reporterContactsFound: reporterContacts.length,
        hasAnyPhoneInDirectory,
        hasAnyLocationInDirectory,
      },
      recentSubmissions: recentSubs,
      reporterContacts,
    });
  } catch (e) {
    console.error('[contributor-network][profile-debug] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load profile debug' });
  }
}

module.exports = {
  queueUnresolved,
  queueMissingEmail,
  queueMissingPhone,
  queueMissingLocation,
  listInactiveContributors,
  highContributionUnverified,
  topContributors,
  profileDebug,
  addNote,
  createTask,
  backfillProfiles,
  runMergeSuggestions,
};
