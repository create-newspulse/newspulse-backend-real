const mongoose = require('mongoose');

const ReporterProfile = require('../models/ReporterProfile');
const ReporterTask = require('../models/ReporterTask');
const ReporterActivityLog = require('../models/ReporterActivityLog');
const CommunitySubmission = require('../models/CommunitySubmission');
const CommunityReport = require('../models/CommunityReport');
const ReporterMergeQueue = require('../models/ReporterMergeQueue');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const ReporterContact = require('../models/ReporterContact');
const ReporterBeat = require('../models/ReporterBeat');
const ReporterCoverage = require('../models/ReporterCoverage');
const News = require('../models/News');
const Article = require('../models/Article');

const {
  resolveAndAttachForSubmission,
  resolveOrCreateReporterProfile,
} = require('../services/reporterIdentityResolution.service');

function isDbReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

function parseIntSafe(v, def) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

function parseBool(v) {
  return String(v || '').trim().toLowerCase() === 'true' || String(v || '').trim() === '1';
}

function safeMaxDate(...values) {
  let best = null;
  for (const v of values) {
    if (!v) continue;
    const d = v instanceof Date ? v : new Date(v);
    if (!Number.isFinite(d.getTime())) continue;
    if (!best || d.getTime() > best.getTime()) best = d;
  }
  return best;
}

function startOfUtcMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function normalizeStrOrNull(v) {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
}

function normalizeReporterEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeStatusToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizeOptionalFilterValue(value) {
  const token = normalizeStatusToken(value);
  if (!token) return null;
  if (['all', 'any', 'default', 'none', 'null', 'undefined', 'select', 'all_states', 'all_districts', 'all_cities', 'all_countries'].includes(token)) {
    return null;
  }
  return token;
}

function normalizeDirectoryStatus(value) {
  const token = normalizeOptionalFilterValue(value);
  if (!token) return null;
  if (['banned', 'archived', 'deleted', 'removed'].includes(token)) return 'archived';
  if (['blocked', 'suspended', 'watchlist', 'revoked'].includes(token)) return 'blocked';
  if (['active', 'verified', 'approved', 'community_default', 'pending', 'new', 'inactive'].includes(token)) return 'active';
  return null;
}

function isLocalDiagnosticsRequest(req) {
  const host = String(req?.headers?.host || req?.get?.('host') || '').toLowerCase();
  const origin = String(req?.headers?.origin || '').toLowerCase();
  const forwardedFor = String(req?.headers?.['x-forwarded-for'] || '').toLowerCase();
  return [host, origin, forwardedFor].some((value) => value.includes('localhost') || value.includes('127.0.0.1'));
}

function logLocalNetworkDirectoryDiagnostics(req, payload) {
  if (!isLocalDiagnosticsRequest(req)) return;
  console.log('[LOCALHOST][contributor-network][directory]', JSON.stringify({
    routePath: payload?.routePath || null,
    queryParamsReceived: payload?.queryParamsReceived || {},
    normalizedPagination: payload?.normalizedPagination || {},
    filtersReceived: payload?.filtersReceived || {},
    effectiveFilters: payload?.effectiveFilters || {},
    usedFirstPageFallback: payload?.usedFirstPageFallback === true,
    totalRowsReturned: Number(payload?.totalRowsReturned || 0),
  }));
}

function hasRealDirectoryFilters(effectiveFilters) {
  if (!effectiveFilters || typeof effectiveFilters !== 'object') return false;
  return Object.entries(effectiveFilters).some(([key, value]) => {
    if (value === null || value === undefined) return false;
    if (key === 'status') return false;
    if (key === 'includeArchived') return value === true;
    return true;
  });
}

function firstReporterEmail(...values) {
  for (const value of values) {
    const email = normalizeReporterEmail(value);
    if (email && email.includes('@')) return email;
  }
  return null;
}

function mapVerificationStatus({ profile, reporterContact }) {
  const rcLevel = normalizeStrOrNull(reporterContact?.verificationLevel);
  if (rcLevel) return rcLevel;
  return normalizeStrOrNull(profile?.verificationTier) || 'new';
}

function mapReporterType({ reporterContact }) {
  return normalizeStrOrNull(reporterContact?.reporterType) || 'community';
}

async function aggregateStoryStatsByProfileIds(profileIds) {
  const ids = (profileIds || []).filter((x) => x && mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return new Map();

  const approvedStatuses = [
    'approved', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app',
    'published', 'publish', 'published_final',
  ];
  const publishedStatuses = ['published', 'publish', 'published_final'];
  const pendingStatuses = [
    'new', 'pending', 'under_review', 'underreview', 'ai_reviewed',
    'pending_founder', 'pending_founder_review', 'pendingfounder', 'pendingfounderreview',
  ];
  const rejectedStatuses = ['rejected', 'reject', 'trash', 'discarded', 'archived'];
  const withdrawnStatuses = ['withdrawn'];

  const rows = await CommunitySubmission.aggregate([
    {
      $match: {
        reporterProfileId: { $in: ids },
        isDeleted: { $ne: true },
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
      },
    },
    {
      $group: {
        _id: '$reporterProfileId',
        storyCount: { $sum: 1 },
        approvedCount: { $sum: { $cond: [{ $in: ['$_statusNorm', approvedStatuses] }, 1, 0] } },
        pendingCount: { $sum: { $cond: [{ $in: ['$_statusNorm', pendingStatuses] }, 1, 0] } },
        rejectedCount: { $sum: { $cond: [{ $in: ['$_statusNorm', rejectedStatuses] }, 1, 0] } },
        withdrawnCount: { $sum: { $cond: [{ $in: ['$_statusNorm', withdrawnStatuses] }, 1, 0] } },
        publishedCount: { $sum: { $cond: [{ $in: ['$_statusNorm', publishedStatuses] }, 1, 0] } },
        lastStoryAt: { $max: '$createdAt' },
      },
    },
  ]);

  const out = new Map();
  for (const r of rows || []) {
    const id = r && r._id ? String(r._id) : null;
    if (!id) continue;
    out.set(id, {
      storyCount: Number(r.storyCount || 0),
      approvedCount: Number(r.approvedCount || 0),
      pendingCount: Number(r.pendingCount || 0),
      rejectedCount: Number(r.rejectedCount || 0),
      withdrawnCount: Number(r.withdrawnCount || 0),
      publishedCount: Number(r.publishedCount || 0),
      lastStoryAt: r.lastStoryAt || null,
    });
  }
  return out;
}

async function aggregateNotesAndLastActivity(profileIds) {
  const ids = (profileIds || []).filter((x) => x && mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return { map: new Map(), lastActivityMap: new Map() };

  const rows = await ReporterActivityLog.aggregate([
    { $match: { profileId: { $in: ids } } },
    {
      $group: {
        _id: '$profileId',
        notesCount: { $sum: { $cond: [{ $eq: ['$type', 'note'] }, 1, 0] } },
        lastActiveAt: { $max: '$createdAt' },
      },
    },
  ]);

  const map = new Map();
  const lastActivityMap = new Map();
  for (const r of rows || []) {
    const id = r && r._id ? String(r._id) : null;
    if (!id) continue;
    map.set(id, Number(r.notesCount || 0));
    lastActivityMap.set(id, r.lastActiveAt || null);
  }
  return { map, lastActivityMap };
}

async function aggregateTasks(profileIds) {
  const ids = (profileIds || []).filter((x) => x && mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return { tasksCountMap: new Map(), lastTaskAtMap: new Map() };

  const rows = await ReporterTask.aggregate([
    { $match: { profileId: { $in: ids }, archived: { $ne: true } } },
    {
      $group: {
        _id: '$profileId',
        tasksCount: { $sum: 1 },
        lastTaskAt: { $max: '$updatedAt' },
      },
    },
  ]);

  const tasksCountMap = new Map();
  const lastTaskAtMap = new Map();
  for (const r of rows || []) {
    const id = r && r._id ? String(r._id) : null;
    if (!id) continue;
    tasksCountMap.set(id, Number(r.tasksCount || 0));
    lastTaskAtMap.set(id, r.lastTaskAt || null);
  }
  return { tasksCountMap, lastTaskAtMap };
}

async function fetchBeatsByProfileIds(profileIds) {
  const ids = (profileIds || []).filter((x) => x && mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return new Map();

  const rows = await ReporterBeat.find({ profileId: { $in: ids } }).select('profileId beat').lean();
  const map = new Map();
  for (const r of rows || []) {
    const pid = r?.profileId ? String(r.profileId) : null;
    const beat = normalizeStrOrNull(r?.beat);
    if (!pid || !beat) continue;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push(beat);
  }
  for (const [k, arr] of map.entries()) {
    map.set(k, Array.from(new Set(arr)).sort());
  }
  return map;
}

async function fetchCoverageByProfileIds(profileIds) {
  const ids = (profileIds || []).filter((x) => x && mongoose.isValidObjectId(x)).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return new Map();

  const rows = await ReporterCoverage.find({ profileId: { $in: ids } })
    .select('profileId coverageScope country stateProvince districtCounty city areaLocality isPrimary')
    .sort({ isPrimary: -1, updatedAt: -1 })
    .lean();

  const map = new Map();
  for (const r of rows || []) {
    const pid = r?.profileId ? String(r.profileId) : null;
    if (!pid) continue;
    if (!map.has(pid)) map.set(pid, []);
    map.get(pid).push({
      scope: r.coverageScope || null,
      country: r.country || null,
      state: r.stateProvince || null,
      district: r.districtCounty || null,
      city: r.city || null,
      area: r.areaLocality || null,
      isPrimary: !!r.isPrimary,
    });
  }
  return map;
}

async function getReporterDirectory(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database not connected' });

    const page = Math.max(parseIntSafe(req.query.page, 1), 1);
    const limit = Math.min(Math.max(parseIntSafe(req.query.limit, 50), 1), 200);
    const debug = parseBool(req.query.debug);
    const effectiveFilters = {
      q: normalizeOptionalFilterValue(req.query.q || req.query.search || ''),
      status: normalizeDirectoryStatus(req.query.status) || 'active',
      verification: normalizeOptionalFilterValue(req.query.verification),
      reporterType: normalizeOptionalFilterValue(req.query.reporterType || req.query.type),
      state: normalizeOptionalFilterValue(req.query.state),
      district: normalizeOptionalFilterValue(req.query.district),
      city: normalizeOptionalFilterValue(req.query.city),
      country: normalizeOptionalFilterValue(req.query.country),
      includeArchived: parseBool(req.query.includeArchived) === true,
      missingPhone: null,
      missingLocation: null,
    };

    const baseFilter = { mergedIntoProfileId: null };
    if (effectiveFilters.status === 'archived') {
      baseFilter.status = { $in: ['archived', 'banned', 'deleted', 'removed'] };
    } else if (effectiveFilters.status === 'blocked') {
      baseFilter.status = { $in: ['blocked', 'suspended', 'revoked'] };
    } else if (!effectiveFilters.includeArchived) {
      baseFilter.status = { $nin: ['archived', 'banned', 'deleted', 'removed', 'blocked', 'suspended', 'revoked'] };
    }

    const skip = (page - 1) * limit;
    const [total, summaryArr] = await Promise.all([
      ReporterProfile.countDocuments(baseFilter),
      ReporterProfile.aggregate([
        { $match: baseFilter },
        {
          $group: {
            _id: null,
            totalReporters: { $sum: 1 },
            verified: { $sum: { $cond: [{ $in: ['$verificationTier', ['trusted_local', 'verified_journalist']] }, 1, 0] } },
            missingPhone: { $sum: { $cond: [{ $in: ['missing_phone', '$flags'] }, 1, 0] } },
            missingLocation: { $sum: { $cond: [{ $in: ['missing_location', '$flags'] }, 1, 0] } },
            lastSubmissionAt: { $max: '$stats.lastStoryAt' },
            newestReporterAt: { $max: '$createdAt' },
          },
        },
      ]),
    ]);

    const hasRealFilters = hasRealDirectoryFilters(effectiveFilters);
    const shouldFallbackToFirstPage = !hasRealFilters && total > 0 && skip >= total;
    const effectivePage = shouldFallbackToFirstPage ? 1 : page;
    const effectiveSkip = shouldFallbackToFirstPage ? 0 : skip;

    const profiles = await ReporterProfile.find(baseFilter)
      .sort({ 'stats.lastStoryAt': -1, createdAt: -1 })
      .skip(effectiveSkip)
      .limit(limit)
      .lean();

    const profileIds = (profiles || []).map((p) => (p && p._id ? String(p._id) : null)).filter(Boolean);

    const reporterContactIds = (profiles || [])
      .map((p) => (p && p.reporterContactId ? String(p.reporterContactId) : null))
      .filter((x) => x && mongoose.isValidObjectId(x));

    const [storyStatsMap, notesAgg, tasksAgg, beatsMap, coverageMap, reporterContacts] = await Promise.all([
      aggregateStoryStatsByProfileIds(profileIds),
      aggregateNotesAndLastActivity(profileIds),
      aggregateTasks(profileIds),
      fetchBeatsByProfileIds(profileIds),
      fetchCoverageByProfileIds(profileIds),
      reporterContactIds.length
        ? ReporterContact.find({ _id: { $in: reporterContactIds } })
          .select('fullName email phoneFull country stateName districtName cityTownVillage talukaName reporterType verificationLevel status ethicsStrikes')
          .lean()
        : [],
    ]);

    const reporterContactsById = new Map();
    for (const rc of reporterContacts || []) {
      if (rc && rc._id) reporterContactsById.set(String(rc._id), rc);
    }

    const now = new Date();
    const monthStart = startOfUtcMonth(now);

    const summaryBase = Array.isArray(summaryArr) && summaryArr[0] ? summaryArr[0] : null;
    const summary = {
      totalReporters: Number(summaryBase?.totalReporters || 0),
      verified: Number(summaryBase?.verified || 0),
      missingPhone: Number(summaryBase?.missingPhone || 0),
      missingLocation: Number(summaryBase?.missingLocation || 0),
      activeThisMonth: 0,
      newThisMonth: 0,
      lastSubmissionAt: summaryBase?.lastSubmissionAt || null,
      asOf: now,
    };

    // More precise calendar-month counts based on profile fields (indexed).
    try {
      const [activeThisMonth, newThisMonth] = await Promise.all([
        ReporterProfile.countDocuments({ ...baseFilter, 'stats.lastStoryAt': { $gte: monthStart } }),
        ReporterProfile.countDocuments({ ...baseFilter, createdAt: { $gte: monthStart } }),
      ]);
      summary.activeThisMonth = Number(activeThisMonth || 0);
      summary.newThisMonth = Number(newThisMonth || 0);
    } catch (_) {}

    const items = (profiles || []).map((p) => {
      const profileId = p && p._id ? String(p._id) : null;
      const rc = p && p.reporterContactId ? reporterContactsById.get(String(p.reporterContactId)) : null;

      const story = storyStatsMap.get(profileId) || {
        storyCount: Number(p?.stats?.totalStories || 0),
        approvedCount: Number(p?.stats?.approvedStories || 0),
        pendingCount: Number(p?.stats?.pendingStories || 0),
        rejectedCount: Number(p?.stats?.rejectedStories || 0),
        withdrawnCount: Number(p?.stats?.withdrawnStories || 0),
        publishedCount: Number(p?.stats?.publishedStories || 0),
        lastStoryAt: p?.stats?.lastStoryAt || null,
      };

      const email = normalizeStrOrNull(p?.primaryEmail) || normalizeStrOrNull(rc?.email);
      const phone = normalizeStrOrNull(p?.primaryPhone) || normalizeStrOrNull(rc?.phoneFull);

      const city = normalizeStrOrNull(p?.location?.city) || normalizeStrOrNull(rc?.cityTownVillage);
      const district = normalizeStrOrNull(p?.location?.districtCounty) || normalizeStrOrNull(rc?.districtName);
      const state = normalizeStrOrNull(p?.location?.stateProvince) || normalizeStrOrNull(rc?.stateName);
      const country = normalizeStrOrNull(p?.location?.country) || normalizeStrOrNull(rc?.country);

      const notesCount = Number(notesAgg.map.get(profileId) || 0);
      const tasksCount = Number(tasksAgg.tasksCountMap.get(profileId) || 0);

      const lastStoryAt = story.lastStoryAt || null;
      const lastLogAt = notesAgg.lastActivityMap.get(profileId) || null;
      const lastTaskAt = tasksAgg.lastTaskAtMap.get(profileId) || null;
      const lastActiveAt = safeMaxDate(lastStoryAt, lastLogAt, lastTaskAt);

      const beats = beatsMap.get(profileId) || [];
      const coverageAreas = coverageMap.get(profileId) || [];
      const primaryCoverage = coverageAreas.find((x) => x && x.isPrimary) || null;

      const out = {
        id: profileId,
        displayName: normalizeStrOrNull(p?.displayName) || 'Unknown',
        email: email || null,
        phone: phone || null,
        city: city || null,
        district: district || null,
        state: state || null,
        country: country || null,
        type: mapReporterType({ reporterContact: rc }),
        verificationStatus: mapVerificationStatus({ profile: p, reporterContact: rc }),
        activeStatus: normalizeStrOrNull(p?.status) || 'active',
        strikes: Number(rc?.ethicsStrikes || 0),
        storyCount: Number(story.storyCount || 0),
        approvedCount: Number(story.approvedCount || 0),
        pendingCount: Number(story.pendingCount || 0),
        rejectedCount: Number(story.rejectedCount || 0),
        withdrawnCount: Number(story.withdrawnCount || 0),
        publishedCount: Number(story.publishedCount || 0),
        lastStoryAt: lastStoryAt,
        lastActiveAt: lastActiveAt,
        notesCount,
        tasksCount,
        beats,
        coverage: {
          scope: normalizeStrOrNull(p?.coverageScope) || (primaryCoverage ? primaryCoverage.scope : null) || null,
          primary: primaryCoverage || {
            scope: normalizeStrOrNull(p?.coverageScope) || null,
            country,
            state,
            district,
            city,
            area: normalizeStrOrNull(p?.location?.areaLocality) || normalizeStrOrNull(rc?.talukaName) || null,
            isPrimary: true,
          },
        },
      };

      if (debug) {
        out.debug = {
          profile: {
            userId: p?.userId ? String(p.userId) : null,
            reporterContactId: p?.reporterContactId ? String(p.reporterContactId) : null,
            flags: Array.isArray(p?.flags) ? p.flags : [],
            verificationTier: normalizeStrOrNull(p?.verificationTier) || null,
            mergedIntoProfileId: p?.mergedIntoProfileId ? String(p.mergedIntoProfileId) : null,
          },
          reporterContact: rc
            ? {
              id: rc?._id ? String(rc._id) : null,
              status: normalizeStrOrNull(rc?.status) || null,
              verificationLevel: normalizeStrOrNull(rc?.verificationLevel) || null,
            }
            : null,
          sources: {
            email: normalizeStrOrNull(p?.primaryEmail) ? 'profile.primaryEmail' : (normalizeStrOrNull(rc?.email) ? 'reporterContact.email' : null),
            phone: normalizeStrOrNull(p?.primaryPhone) ? 'profile.primaryPhone' : (normalizeStrOrNull(rc?.phoneFull) ? 'reporterContact.phoneFull' : null),
            location: (normalizeStrOrNull(p?.location?.city) || normalizeStrOrNull(p?.location?.stateProvince) || normalizeStrOrNull(p?.location?.country) || normalizeStrOrNull(p?.location?.districtCounty))
              ? 'profile.location'
              : (rc ? 'reporterContact.location' : null),
          },
        };
      }

      return out;
    });

    logLocalNetworkDirectoryDiagnostics(req, {
      routePath: req.originalUrl || `${req.baseUrl || ''}${req.path || ''}` || '/api/admin/community-reporter/network/directory',
      queryParamsReceived: req.query || {},
      normalizedPagination: {
        page,
        limit,
        effectivePage,
        effectiveSkip,
      },
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
      },
      effectiveFilters,
      usedFirstPageFallback: shouldFallbackToFirstPage,
      totalRowsReturned: total,
    });

    return res.status(200).json({ ok: true, items, total, page: effectivePage, limit, summary });
  } catch (e) {
    console.error('[contributor-network][directory] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
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
    const force = String(req.body?.force ?? req.query.force ?? '').toLowerCase() === 'true';
    const forceIfPlaceholder = String(req.body?.forceIfPlaceholder ?? req.query.forceIfPlaceholder ?? '').toLowerCase() === 'true';
    const mode = String(req.body?.mode ?? req.query.mode ?? '').trim().toLowerCase();
    const scanAll = mode === 'all' || String(req.body?.all ?? req.query.all ?? '').toLowerCase() === 'true';

    const filter = scanAll
      ? { isDeleted: { $ne: true } }
      : { $or: [{ reporterProfileId: { $exists: false } }, { reporterProfileId: null }] };

    const sourceSummary = {
      CommunitySubmission: { total: 0, included: 0, skipped: 0, written: 0, skippedReasons: {} },
      CommunityReport: { total: 0, included: 0, skipped: 0, written: 0, skippedReasons: {} },
      ReporterContact: { total: 0, included: 0, skipped: 0, written: 0, skippedReasons: {} },
      News: { total: 0, included: 0, skipped: 0, written: 0, skippedReasons: {} },
      Article: { total: 0, included: 0, skipped: 0, written: 0, skippedReasons: {} },
    };
    const countsPerEmail = new Map();

    const markSkipped = (bucket, reason) => {
      sourceSummary[bucket].skipped += 1;
      sourceSummary[bucket].skippedReasons[reason] = Number(sourceSummary[bucket].skippedReasons[reason] || 0) + 1;
    };
    const trackEmail = (email, bucket) => {
      if (!email) return;
      if (!countsPerEmail.has(email)) countsPerEmail.set(email, { total: 0, perSource: {} });
      const row = countsPerEmail.get(email);
      row.total += 1;
      row.perSource[bucket] = Number(row.perSource[bucket] || 0) + 1;
    };

    const [submissions, reports, contacts, newsDocs, articleDocs] = await Promise.all([
      CommunitySubmission.find(filter).sort({ createdAt: 1 }).limit(limit).lean(),
      CommunityReport.find({}).sort({ createdAt: 1 }).limit(limit).lean(),
      ReporterContact.find({}).sort({ createdAt: 1 }).limit(limit).lean(),
      News.find({}).sort({ createdAt: 1 }).limit(limit).lean(),
      Article.find({}).sort({ createdAt: 1 }).limit(limit).lean(),
    ]);

    sourceSummary.CommunitySubmission.total = submissions.length;
    sourceSummary.CommunityReport.total = reports.length;
    sourceSummary.ReporterContact.total = contacts.length;
    sourceSummary.News.total = newsDocs.length;
    sourceSummary.Article.total = articleDocs.length;

    let scanned = 0;
    let attached = 0;

    for (const sub of submissions) {
      scanned += 1;
      const email = firstReporterEmail(
        sub.reporterEmailNorm,
        sub.reporterEmail,
        sub.email,
        sub.submittedByEmail,
        sub.contactEmail,
        sub.authorEmail,
        sub.contact?.email,
        sub.reporter?.email,
        sub.reporterProfile?.email,
        sub.contributor?.email
      );
      if (!email) {
        markSkipped('CommunitySubmission', 'missing_email');
        continue;
      }
      sourceSummary.CommunitySubmission.included += 1;
      trackEmail(email, 'CommunitySubmission');
      if (dryRun) continue;
      const out = await resolveAndAttachForSubmission(sub, { req, force, forceIfPlaceholder });
      if (out?.ok) {
        attached += 1;
        sourceSummary.CommunitySubmission.written += 1;
      } else {
        markSkipped('CommunitySubmission', out?.reason || 'attach_failed');
      }
    }

    for (const report of reports) {
      scanned += 1;
      const email = firstReporterEmail(report.reporterEmail, report.submittedByEmail, report.contactEmail, report.authorEmail);
      if (!email) {
        markSkipped('CommunityReport', 'missing_email');
        continue;
      }
      sourceSummary.CommunityReport.included += 1;
      trackEmail(email, 'CommunityReport');
      if (dryRun) continue;
      const linkedContact = await ReporterContact.findOne({ $or: [{ emailLower: email }, { email }] }).select('_id').lean();
      const out = await resolveOrCreateReporterProfile({
        reporterContactId: linkedContact?._id || null,
        email,
        phone: report.reporterPhone || null,
        name: report.reporterName || 'Unknown',
        location: {
          city: report.reporterCity || null,
          state: report.reporterState || null,
          country: report.reporterCountry || null,
        },
        source: 'system',
      });
      if (out?.ok) sourceSummary.CommunityReport.written += 1;
      else markSkipped('CommunityReport', out?.reason || 'profile_create_failed');
    }

    for (const contact of contacts) {
      scanned += 1;
      const email = firstReporterEmail(contact.email, contact.emailLower);
      if (!email) {
        markSkipped('ReporterContact', 'missing_email');
        continue;
      }
      sourceSummary.ReporterContact.included += 1;
      trackEmail(email, 'ReporterContact');
      if (dryRun) continue;
      const out = await resolveOrCreateReporterProfile({
        reporterContactId: contact._id,
        email,
        phone: contact.phoneFull || contact.phoneNumber || null,
        name: contact.fullName || 'Unknown',
        location: {
          city: contact.cityTownVillage || null,
          state: contact.stateName || null,
          country: contact.country || null,
          district: contact.districtName || null,
          area: contact.areaName || contact.talukaName || null,
        },
        source: 'system',
      });
      if (out?.ok) sourceSummary.ReporterContact.written += 1;
      else markSkipped('ReporterContact', out?.reason || 'profile_create_failed');
    }

    for (const doc of newsDocs) {
      scanned += 1;
      const email = firstReporterEmail(doc.reporterEmail, doc.submittedByEmail, doc.contactEmail, doc.authorEmail, doc.reporter?.email, doc.reporterProfile?.email, doc.contributor?.email);
      if (!email) {
        markSkipped('News', 'missing_email');
        continue;
      }
      sourceSummary.News.included += 1;
      trackEmail(email, 'News');
    }

    for (const doc of articleDocs) {
      scanned += 1;
      const email = firstReporterEmail(doc.reporterEmail, doc.submittedByEmail, doc.contactEmail, doc.authorEmail, doc.reporter?.email, doc.reporterProfile?.email, doc.contributor?.email);
      if (!email) {
        markSkipped('Article', 'missing_email');
        continue;
      }
      sourceSummary.Article.included += 1;
      trackEmail(email, 'Article');
    }

    const totalProfiles = await ReporterProfile.countDocuments({ mergedIntoProfileId: null });
    const topEmails = [...countsPerEmail.entries()]
      .map(([email, row]) => ({ email, total: row.total, perSource: row.perSource }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 100);

    return res.status(200).json({
      ok: true,
      scanned,
      attached,
      limit,
      dryRun,
      force,
      forceIfPlaceholder,
      mode: scanAll ? 'all' : 'missing',
      collectionsScanned: sourceSummary,
      totalRawSourceRecordsScanned: Object.values(sourceSummary).reduce((sum, row) => sum + Number(row.total || 0), 0),
      totalUniqueNormalizedReporterEmailsFound: countsPerEmail.size,
      totalDirectoryRowsWritten: totalProfiles,
      countsPerReporterEmail: topEmails,
    });
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
  getReporterDirectory,
  profileDebug,
  addNote,
  createTask,
  backfillProfiles,
  runMergeSuggestions,
};
