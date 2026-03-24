const mongoose = require('mongoose');

const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterProfile = require('../models/ReporterProfile');
const ReporterContact = require('../models/ReporterContact');
const ReporterContactMethod = require('../models/ReporterContactMethod');
const ReporterCoverage = require('../models/ReporterCoverage');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const ReporterActivityLog = require('../models/ReporterActivityLog');

function isDbReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return s || null;
}

function normalizePhone(v) {
  const raw = String(v || '').trim();
  if (!raw) return null;
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D+/g, '');
  const out = plus ? `+${digits}` : digits;
  return out && out.length >= 6 ? out : null;
}

function normalizeLocation(input) {
  const loc = input && typeof input === 'object' ? input : null;
  if (!loc) return { country: null, stateProvince: null, districtCounty: null, city: null, areaLocality: null };

  const country = loc.country != null ? String(loc.country).trim() : '';
  const stateProvince = (loc.stateProvince ?? loc.state) != null ? String(loc.stateProvince ?? loc.state).trim() : '';
  const districtCounty = (loc.districtCounty ?? loc.district) != null ? String(loc.districtCounty ?? loc.district).trim() : '';
  const city = loc.city != null ? String(loc.city).trim() : '';
  const areaLocality = (loc.areaLocality ?? loc.area) != null ? String(loc.areaLocality ?? loc.area).trim() : '';

  return {
    country: country || null,
    stateProvince: stateProvince || null,
    districtCounty: districtCounty || null,
    city: city || null,
    areaLocality: areaLocality || null,
  };
}

function hasAnyLocation(loc) {
  if (!loc) return false;
  return !!(
    String(loc.country || '').trim() ||
    String(loc.stateProvince || '').trim() ||
    String(loc.districtCounty || '').trim() ||
    String(loc.city || '').trim() ||
    String(loc.areaLocality || '').trim()
  );
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveCoverageScope(loc) {
  const c = String(loc?.country || '').trim().toLowerCase();
  const hasState = !!String(loc?.stateProvince || '').trim();
  const hasDistrict = !!String(loc?.districtCounty || '').trim();
  const hasCity = !!String(loc?.city || '').trim();
  const hasArea = !!String(loc?.areaLocality || '').trim();

  if (c && c !== 'india') return 'international';
  if (hasState || hasDistrict) return 'regional';
  if (hasCity || hasArea) return 'hyperlocal';
  return 'national';
}

function computeIdentityFlags({ userId, email, phone, location }) {
  const flags = [];
  if (!email) flags.push('missing_email');
  if (!phone) flags.push('missing_phone');
  const hasLoc = hasAnyLocation(location);
  if (!hasLoc) flags.push('missing_location');
  if (!userId && !email && !phone) flags.push('identity_unresolved');
  return flags;
}

function actorFromReq(req) {
  const a = req && req.admin ? req.admin : null;
  if (!a) return { kind: 'system', adminId: null, email: null, role: null };
  return { kind: 'admin', adminId: a.id || null, email: a.email || null, role: a.role || null };
}

function toCanonicalReporterProfile(profile) {
  if (!profile) return null;
  const p = profile.toObject ? profile.toObject() : profile;
  return {
    id: p._id ? String(p._id) : null,
    displayName: p.displayName || null,
    userId: p.userId ? String(p.userId) : null,
    reporterContactId: p.reporterContactId ? String(p.reporterContactId) : null,
    primaryEmail: p.primaryEmail || null,
    primaryPhone: p.primaryPhone || null,
    coverageScope: p.coverageScope || null,
    location: p.location || null,
    flags: Array.isArray(p.flags) ? p.flags : [],
    stats: {
      totalStories: Number(p?.stats?.totalStories || 0),
      approvedStories: Number(p?.stats?.approvedStories || 0),
      pendingStories: Number(p?.stats?.pendingStories || 0),
      rejectedStories: Number(p?.stats?.rejectedStories || 0),
      withdrawnStories: Number(p?.stats?.withdrawnStories || 0),
      publishedStories: Number(p?.stats?.publishedStories || 0),
      lastStoryAt: p?.stats?.lastStoryAt || null,
      lastStoryTitle: p?.stats?.lastStoryTitle || null,
    },
    createdAt: p.createdAt || null,
    updatedAt: p.updatedAt || null,
  };
}

function classifySubmissionStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'other';

  // Published (separate bucket)
  if (s === 'published' || s === 'publish' || s === 'published_final') return 'published';

  // Approved-like
  if (s === 'approved' || s === 'approve' || s === 'approved_final' || s === 'approved_founder' || s === 'approved_by_founder' || s === 'approved_by_admin') {
    return 'approved';
  }

  // Pending/review-like
  if (s === 'new' || s === 'pending' || s === 'under_review' || s === 'pending_founder' || s === 'pendingfounder') {
    return 'pending';
  }

  // Withdrawn (separate bucket)
  if (s === 'withdrawn') return 'withdrawn';

  // Rejected/removed-like
  if (s === 'rejected' || s === 'reject' || s === 'trash' || s === 'deleted' || s === 'discarded' || s === 'archived') {
    return 'rejected';
  }

  return 'other';
}

async function recomputeReporterProfileStoryStats(profileId, { reason } = {}) {
  try {
    if (!profileId) return { ok: false, reason: 'missing-profileId' };
    if (!isDbReady()) return { ok: false, reason: 'db-not-ready' };

    const pid = String(profileId).trim();
    if (!mongoose.isValidObjectId(pid)) return { ok: false, reason: 'invalid-profileId' };

    const approvedStatuses = [
      'approved', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app',
      // treat published as approved for the approved counter
      'published', 'publish', 'published_final',
    ];
    const publishedStatuses = ['published', 'publish', 'published_final'];
    const pendingStatuses = [
      'new', 'pending', 'under_review', 'underreview', 'ai_reviewed',
      'pending_founder', 'pending_founder_review', 'pendingfounder', 'pendingfounderreview',
    ];
    const rejectedStatuses = ['rejected', 'reject', 'trash', 'discarded', 'archived'];
    const withdrawnStatuses = ['withdrawn'];

    const match = {
      reporterProfileId: new mongoose.Types.ObjectId(pid),
      isDeleted: { $ne: true },
    };

    const rows = await CommunitySubmission.aggregate([
      { $match: match },
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
          _id: null,
          totalStories: { $sum: 1 },
          approvedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', approvedStatuses] }, 1, 0] } },
          pendingStories: { $sum: { $cond: [{ $in: ['$_statusNorm', pendingStatuses] }, 1, 0] } },
          rejectedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', rejectedStatuses] }, 1, 0] } },
          withdrawnStories: { $sum: { $cond: [{ $in: ['$_statusNorm', withdrawnStatuses] }, 1, 0] } },
          publishedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', publishedStatuses] }, 1, 0] } },
          lastStoryAt: { $max: '$createdAt' },
        },
      },
    ]);

    const agg = Array.isArray(rows) && rows[0] ? rows[0] : null;
    const totalStories = Number(agg?.totalStories || 0);
    const approvedStories = Number(agg?.approvedStories || 0);
    const pendingStories = Number(agg?.pendingStories || 0);
    const rejectedStories = Number(agg?.rejectedStories || 0);
    const withdrawnStories = Number(agg?.withdrawnStories || 0);
    const publishedStories = Number(agg?.publishedStories || 0);
    const lastStoryAt = agg?.lastStoryAt || null;

    let lastStoryTitle = null;
    try {
      const latest = await CommunitySubmission.findOne(match).sort({ createdAt: -1 }).select('headline createdAt').lean();
      lastStoryTitle = latest?.headline ? String(latest.headline).trim() : null;
    } catch (_) {}

    await ReporterProfile.updateOne(
      { _id: pid },
      {
        $set: {
          'stats.totalStories': totalStories,
          'stats.approvedStories': approvedStories,
          'stats.pendingStories': pendingStories,
          'stats.rejectedStories': rejectedStories,
          'stats.withdrawnStories': withdrawnStories,
          'stats.publishedStories': publishedStories,
          'stats.lastStoryAt': lastStoryAt,
          'stats.lastStoryTitle': lastStoryTitle,
        },
      }
    );

    if (process.env.REPORTER_NORMALIZE_LOG === '1') {
      console.log('[reporter-profile][stats][recompute]', {
        profileId: pid,
        reason: reason || null,
        totalStories,
        approvedStories,
        pendingStories,
        rejectedStories,
        withdrawnStories,
        publishedStories,
        lastStoryAt,
      });
    }

    return {
      ok: true,
      profileId: pid,
      stats: { totalStories, approvedStories, pendingStories, rejectedStories, withdrawnStories, publishedStories, lastStoryAt, lastStoryTitle },
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'error' };
  }
}

async function updateReporterProfileStatsForStatusChange({ profileId, fromStatus, toStatus }) {
  if (!profileId) return { ok: false, reason: 'missing-profileId' };
  const out = await recomputeReporterProfileStoryStats(profileId, { reason: 'status-change' });
  if (!out.ok) return out;
  return { ok: true, recomputed: true, fromStatus: fromStatus || null, toStatus: toStatus || null, stats: out.stats };
}

async function findProfileByUserId(userId) {
  if (!userId) return null;
  return ReporterProfile.findOne({ userId, mergedIntoProfileId: null }).lean();
}

async function findProfileByReporterContactId(reporterContactId) {
  if (!reporterContactId) return null;
  if (!mongoose.isValidObjectId(reporterContactId)) return null;
  return ReporterProfile.findOne({ reporterContactId, mergedIntoProfileId: null }).lean();
}

async function findProfileByContact(type, normalized) {
  if (!type || !normalized) return null;
  const cm = await ReporterContactMethod.findOne({ type, normalized, status: 'active' }).lean();
  if (!cm || !cm.profileId) return null;
  return ReporterProfile.findOne({ _id: cm.profileId, mergedIntoProfileId: null }).lean();
}

async function upsertContactMethod(profileId, { type, value, normalized, isPrimary, source }) {
  if (!profileId || !type || !value) return;
  const norm = normalized || null;

  await ReporterContactMethod.findOneAndUpdate(
    { profileId, type, ...(norm ? { normalized: norm } : { value }) },
    {
      $set: {
        profileId,
        type,
        value,
        normalized: norm,
        status: 'active',
        source: source || 'system',
        ...(typeof isPrimary === 'boolean' ? { isPrimary } : {}),
      },
      $setOnInsert: { verifiedAt: null },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensurePrimaryCoverage(profileId, loc) {
  if (!profileId) return;
  const normalized = normalizeLocation(loc);
  const any = normalized && (normalized.country || normalized.stateProvince || normalized.city || normalized.districtCounty || normalized.areaLocality);
  if (!any) return;

  const coverageScope = deriveCoverageScope(normalized);

  await ReporterCoverage.findOneAndUpdate(
    { profileId, isPrimary: true },
    {
      $set: {
        profileId,
        isPrimary: true,
        coverageScope,
        country: normalized.country,
        stateProvince: normalized.stateProvince,
        districtCounty: normalized.districtCounty,
        city: normalized.city,
        areaLocality: normalized.areaLocality,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function resolveOrCreateReporterProfile(input) {
  const reporterContactIdRaw = input && input.reporterContactId ? String(input.reporterContactId).trim() : null;
  const reporterContactId = reporterContactIdRaw && mongoose.isValidObjectId(reporterContactIdRaw)
    ? new mongoose.Types.ObjectId(reporterContactIdRaw)
    : null;

  const userId = input && input.userId ? String(input.userId).trim() : null;
  const email = normalizeEmail(input && input.email);
  const phone = normalizePhone(input && input.phone);
  const displayName = String(input && input.name ? input.name : 'Unknown').trim() || 'Unknown';
  const locationInput = normalizeLocation(input && input.location);
  const hasLocInput = hasAnyLocation(locationInput);

  if (!isDbReady()) {
    return { ok: false, reason: 'db-not-ready', profile: null, resolutionMethod: 'db-not-ready', flags: computeIdentityFlags({ userId, email, phone, location: locationInput }) };
  }

  let profile = null;
  let resolutionMethod = null;

  if (reporterContactId) {
    profile = await findProfileByReporterContactId(reporterContactId);
    if (profile) resolutionMethod = 'reporterContactId';
  }

  if (userId) {
    profile = await findProfileByUserId(userId);
    if (profile) resolutionMethod = 'userId';
  }

  if (!profile && email) {
    profile = await findProfileByContact('email', email);
    if (profile) resolutionMethod = 'email';
  }

  if (!profile && phone) {
    profile = await findProfileByContact('phone', phone);
    if (profile) resolutionMethod = 'phone';
  }

  // Conservative fallback match: name + (city/state) when email/phone missing.
  if (!profile && !email && !phone) {
    const nameKey = String(displayName || '').trim();
    const cityKey = String(locationInput?.city || '').trim();
    const stateKey = String(locationInput?.stateProvince || '').trim();
    if (nameKey && nameKey.toLowerCase() !== 'unknown' && (cityKey || stateKey)) {
      profile = await ReporterProfile.findOne({
        mergedIntoProfileId: null,
        displayName: new RegExp(`^${escapeRegex(nameKey)}$`, 'i'),
        ...(cityKey ? { 'location.city': cityKey } : {}),
        ...(stateKey ? { 'location.stateProvince': stateKey } : {}),
      }).lean();
      if (profile) resolutionMethod = 'name+city/state';
    }
  }

  if (!profile) {
    // last-resort: try matching on ReporterProfile primary fields
    if (email) {
      profile = await ReporterProfile.findOne({ primaryEmail: email, mergedIntoProfileId: null }).lean();
      if (profile) resolutionMethod = 'primaryEmail';
    }
    if (!profile && phone) {
      profile = await ReporterProfile.findOne({ primaryPhone: phone, mergedIntoProfileId: null }).lean();
      if (profile) resolutionMethod = 'primaryPhone';
    }
  }

  const coverageScopeInput = deriveCoverageScope(locationInput);
  const flagsInput = computeIdentityFlags({ userId, email, phone, location: locationInput });

  if (!profile) {
    const created = await ReporterProfile.create({
      displayName,
      userId: userId || null,
      reporterContactId,
      primaryEmail: email,
      primaryPhone: phone,
      flags: flagsInput,
      verificationTier: 'new',
      coverageScope: coverageScopeInput,
      location: locationInput,
      stats: { totalStories: 0, approvedStories: 0, pendingStories: 0, lastStoryAt: null, lastStoryTitle: null },
    });

    profile = created.toObject ? created.toObject() : created;
    resolutionMethod = 'created';
  } else {
    // Keep primary identity fields as filled (never overwrite with null)
    const $set = {
      displayName: profile.displayName && profile.displayName !== 'Unknown' ? profile.displayName : displayName,
    };
    if (userId && !profile.userId) $set.userId = userId;
    if (reporterContactId && !profile.reporterContactId) $set.reporterContactId = reporterContactId;
    if (email && !profile.primaryEmail) $set.primaryEmail = email;
    if (phone && !profile.primaryPhone) $set.primaryPhone = phone;

    // Only update location/coverage when we actually received values.
    if (hasLocInput) {
      $set.location = locationInput;
      $set.coverageScope = coverageScopeInput;
    }

    // Compute flags from the merged state (do not regress location/phone/email flags).
    const emailFinal = (email || profile.primaryEmail) || null;
    const phoneFinal = (phone || profile.primaryPhone) || null;
    const userIdFinal = (userId || profile.userId) || null;
    const locFinal = hasLocInput ? locationInput : (profile.location || locationInput);
    $set.flags = computeIdentityFlags({ userId: userIdFinal, email: emailFinal, phone: phoneFinal, location: locFinal });

    await ReporterProfile.updateOne({ _id: profile._id }, { $set });
    profile = await ReporterProfile.findById(profile._id).lean();
  }

  // Best-effort enrichment from the ReporterContact directory when available.
  // This prevents the contributor profile from looking "empty" (missing phone/location)
  // when the directory is being used as the canonical contact system.
  if (reporterContactId) {
    try {
      const rc = await ReporterContact.findById(reporterContactId).lean();
      if (rc) {
        const patch = {};

        if ((!profile.displayName || profile.displayName === 'Unknown') && rc.fullName) {
          patch.displayName = String(rc.fullName).trim() || profile.displayName;
        }

        if (!profile.primaryEmail && rc.email) {
          patch.primaryEmail = normalizeEmail(rc.email);
        }

        if (!profile.primaryPhone && rc.phoneFull) {
          patch.primaryPhone = String(rc.phoneFull).trim() || null;
        }

        const hasProfileLoc = !!(
          profile.location && (
            profile.location.country ||
            profile.location.stateProvince ||
            profile.location.districtCounty ||
            profile.location.city ||
            profile.location.areaLocality
          )
        );

        if (!hasProfileLoc) {
          const mappedLoc = normalizeLocation({
            country: rc.country || null,
            stateProvince: rc.stateName || null,
            districtCounty: rc.districtName || null,
            city: rc.cityTownVillage || null,
            areaLocality: rc.talukaName || null,
          });

          const hasMapped = !!(
            mappedLoc && (mappedLoc.country || mappedLoc.stateProvince || mappedLoc.districtCounty || mappedLoc.city || mappedLoc.areaLocality)
          );
          if (hasMapped) {
            patch.location = mappedLoc;
            patch.coverageScope = deriveCoverageScope(mappedLoc);
          }
        }

        if (Object.keys(patch).length) {
          // Recompute flags using "final" values, so missing-phone/location queues are accurate.
          const emailFinal = patch.primaryEmail || profile.primaryEmail || email;
          const phoneFinal = patch.primaryPhone || profile.primaryPhone || phone;
          const locFinal = patch.location || profile.location || location;
          const userIdFinal = profile.userId || userId;
          patch.flags = computeIdentityFlags({ userId: userIdFinal, email: emailFinal, phone: phoneFinal, location: locFinal });

          await ReporterProfile.updateOne({ _id: profile._id }, { $set: patch });
          profile = await ReporterProfile.findById(profile._id).lean();
        }
      }
    } catch (_) {}
  }

  // Upsert contact methods (best-effort)
  try {
    if (email) await upsertContactMethod(profile._id, { type: 'email', value: email, normalized: email, isPrimary: true, source: input?.source || 'system' });
    if (phone) await upsertContactMethod(profile._id, { type: 'phone', value: phone, normalized: phone, isPrimary: !email, source: input?.source || 'system' });
  } catch (_) {}

  // Coverage row
  try {
    await ensurePrimaryCoverage(profile._id, location);
  } catch (_) {}

  return { ok: true, profile, resolutionMethod, flags };
}

async function attachSubmissionToReporterProfile(submission, resolveResult, { req } = {}) {
  if (!submission || !submission._id) return { ok: false, reason: 'missing-submission' };
  if (!resolveResult || !resolveResult.profile || !resolveResult.profile._id) return { ok: false, reason: 'missing-profile' };
  if (!isDbReady()) return { ok: false, reason: 'db-not-ready' };

  if (submission.reporterProfileId) {
    return {
      ok: true,
      profileId: String(submission.reporterProfileId),
      submissionId: String(submission._id),
      skipped: true,
      reason: 'already-linked',
    };
  }

  const submissionId = submission._id;
  const profileId = resolveResult.profile._id;
  const flags = Array.isArray(resolveResult.flags) ? resolveResult.flags : [];
  const resolutionMethod = resolveResult.resolutionMethod || null;

  // Set fields on submission without breaking existing ReporterContact linkage
  await CommunitySubmission.updateOne(
    { _id: submissionId },
    {
      $set: {
        reporterProfileId: profileId,
        identityFlags: flags,
        identityResolutionMethod: resolutionMethod,
      },
    }
  );

  // Create story link (idempotent)
  const linkWrite = await ReporterStoryLink.updateOne(
    { profileId, submissionId },
    { $setOnInsert: { profileId, submissionId, reason: 'auto', resolutionMethod } },
    { upsert: true }
  );

  const isNewLink = !!(
    (linkWrite && typeof linkWrite.upsertedCount === 'number' && linkWrite.upsertedCount > 0) ||
    (linkWrite && linkWrite.upsertedId)
  );

  // Update profile stats best-effort (only when link inserted)
  if (isNewLink) {
    try {
      await recomputeReporterProfileStoryStats(profileId, { reason: 'new-link' });
    } catch (_) {}
  }

  // Activity log
  try {
    const actor = actorFromReq(req);
    await ReporterActivityLog.create({
      profileId,
      type: 'story_linked',
      message: 'Story linked to reporter profile',
      metadata: { submissionId: String(submissionId), resolutionMethod },
      actor,
    });
  } catch (_) {}

  return { ok: true, profileId: String(profileId), submissionId: String(submissionId), isNewLink };
}

function identityInputFromSubmission(submission) {
  const email = submission.reporterEmailNorm || submission.reporterEmail || submission.email || submission?.contact?.email || null;
  const phone =
    submission?.contact?.phone ||
    submission?.contact?.whatsappNumber ||
    submission?.phone ||
    submission?.phoneNumber ||
    null;
  const name = submission.reporterName || submission.name || submission?.contact?.name || submission?.userName || 'Unknown';

  const loc = submission.locationDetail || submission.location || {};
  const location = {
    city: loc?.city || submission.city || null,
    state: loc?.state || submission.state || null,
    country: loc?.country || submission.country || null,
    district: loc?.district || submission?.locationDetail?.district || submission.district || null,
  };

  return {
    userId: submission.reporterUserId || null,
    reporterContactId: submission.reporterId || null,
    email,
    phone,
    name,
    location,
    source: 'system',
  };
}

async function resolveAndAttachForSubmission(submission, { req } = {}) {
  try {
    if (!submission) return { ok: false, reason: 'missing-submission' };
    const input = identityInputFromSubmission(submission);
    const resolveResult = await resolveOrCreateReporterProfile(input);
    if (!resolveResult.ok) return resolveResult;
    return await attachSubmissionToReporterProfile(submission, resolveResult, { req });
  } catch (e) {
    return { ok: false, reason: e?.message || 'error' };
  }
}

module.exports = {
  normalizeEmail,
  normalizePhone,
  normalizeLocation,
  deriveCoverageScope,
  computeIdentityFlags,
  toCanonicalReporterProfile,
  resolveOrCreateReporterProfile,
  attachSubmissionToReporterProfile,
  resolveAndAttachForSubmission,
  classifySubmissionStatus,
  updateReporterProfileStatsForStatusChange,
  recomputeReporterProfileStoryStats,
};
