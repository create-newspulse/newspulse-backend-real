const mongoose = require('mongoose');

const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterProfile = require('../models/ReporterProfile');
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
  const hasLoc = !!(location && (location.city || location.stateProvince || location.country || location.districtCounty || location.areaLocality));
  if (!hasLoc) flags.push('missing_location');
  if (!userId && !email && !phone) flags.push('identity_unresolved');
  return flags;
}

function actorFromReq(req) {
  const a = req && req.admin ? req.admin : null;
  if (!a) return { kind: 'system', adminId: null, email: null, role: null };
  return { kind: 'admin', adminId: a.id || null, email: a.email || null, role: a.role || null };
}

function classifySubmissionStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s) return 'other';

  // Approved-like
  if (s === 'approved' || s === 'published') return 'approved';

  // Pending/review-like
  if (s === 'new' || s === 'pending' || s === 'under_review' || s === 'pending_founder' || s === 'pendingfounder') {
    return 'pending';
  }

  // Rejected/removed-like
  if (s === 'rejected' || s === 'trash' || s === 'deleted' || s === 'discarded' || s === 'withdrawn' || s === 'archived') {
    return 'rejected';
  }

  return 'other';
}

async function updateReporterProfileStatsForStatusChange({ profileId, fromStatus, toStatus }) {
  if (!profileId) return { ok: false, reason: 'missing-profileId' };
  if (!isDbReady()) return { ok: false, reason: 'db-not-ready' };

  const fromClass = classifySubmissionStatus(fromStatus);
  const toClass = classifySubmissionStatus(toStatus);
  if (fromClass === toClass) return { ok: true, skipped: true, reason: 'no-change' };

  const inc = {};
  if (fromClass === 'pending') inc['stats.pendingStories'] = (inc['stats.pendingStories'] || 0) - 1;
  if (toClass === 'pending') inc['stats.pendingStories'] = (inc['stats.pendingStories'] || 0) + 1;
  if (fromClass === 'approved') inc['stats.approvedStories'] = (inc['stats.approvedStories'] || 0) - 1;
  if (toClass === 'approved') inc['stats.approvedStories'] = (inc['stats.approvedStories'] || 0) + 1;

  // Defensive: do not allow negative counters in aggregate; clamp via pipeline update when needed.
  await ReporterProfile.updateOne(
    { _id: profileId },
    {
      $inc: inc,
    }
  );

  // Clamp negatives (best-effort)
  try {
    const p = await ReporterProfile.findById(profileId, 'stats.pendingStories stats.approvedStories').lean();
    if (!p) return { ok: true };
    const pendingStories = Math.max(0, Number(p?.stats?.pendingStories || 0));
    const approvedStories = Math.max(0, Number(p?.stats?.approvedStories || 0));
    await ReporterProfile.updateOne({ _id: profileId }, { $set: { 'stats.pendingStories': pendingStories, 'stats.approvedStories': approvedStories } });
  } catch (_) {}

  return { ok: true, fromClass, toClass };
}

async function findProfileByUserId(userId) {
  if (!userId) return null;
  return ReporterProfile.findOne({ userId, mergedIntoProfileId: null }).lean();
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
  const userId = input && input.userId ? String(input.userId).trim() : null;
  const email = normalizeEmail(input && input.email);
  const phone = normalizePhone(input && input.phone);
  const displayName = String(input && input.name ? input.name : 'Unknown').trim() || 'Unknown';
  const location = normalizeLocation(input && input.location);

  if (!isDbReady()) {
    return { ok: false, reason: 'db-not-ready', profile: null, resolutionMethod: 'db-not-ready', flags: computeIdentityFlags({ userId, email, phone, location }) };
  }

  let profile = null;
  let resolutionMethod = null;

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

  const flags = computeIdentityFlags({ userId, email, phone, location });
  const coverageScope = deriveCoverageScope(location);

  if (!profile) {
    const created = await ReporterProfile.create({
      displayName,
      userId: userId || null,
      primaryEmail: email,
      primaryPhone: phone,
      flags,
      verificationTier: 'new',
      coverageScope,
      location,
      stats: { totalStories: 0, approvedStories: 0, pendingStories: 0, lastStoryAt: null, lastStoryTitle: null },
    });

    profile = created.toObject ? created.toObject() : created;
    resolutionMethod = 'created';
  } else {
    // Keep primary identity fields as filled (never overwrite with null)
    const $set = {
      displayName: profile.displayName && profile.displayName !== 'Unknown' ? profile.displayName : displayName,
      coverageScope,
      location,
      flags,
    };
    if (userId && !profile.userId) $set.userId = userId;
    if (email && !profile.primaryEmail) $set.primaryEmail = email;
    if (phone && !profile.primaryPhone) $set.primaryPhone = phone;

    await ReporterProfile.updateOne({ _id: profile._id }, { $set });
    profile = await ReporterProfile.findById(profile._id).lean();
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
      const status = String(submission.status || '').trim().toLowerCase();
      const isApproved = status === 'approved' || status === 'published';
      const isPending = status === 'new' || status === 'pending' || status === 'under_review' || status === 'pending_founder';

      await ReporterProfile.updateOne(
        { _id: profileId },
        {
          $inc: {
            'stats.totalStories': 1,
            ...(isApproved ? { 'stats.approvedStories': 1 } : {}),
            ...(isPending ? { 'stats.pendingStories': 1 } : {}),
          },
          $set: {
            'stats.lastStoryAt': submission.createdAt || new Date(),
            'stats.lastStoryTitle': submission.headline ? String(submission.headline).trim() : null,
          },
        }
      );
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
  const phone = submission?.contact?.phone || submission.phone || null;
  const name = submission.reporterName || submission.name || submission?.contact?.name || 'Unknown';

  const loc = submission.locationDetail || submission.location || null;
  const location = {
    city: loc?.city || null,
    state: loc?.state || null,
    country: loc?.country || null,
    district: loc?.district || null,
  };

  return {
    userId: submission.reporterUserId || null,
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
  resolveOrCreateReporterProfile,
  attachSubmissionToReporterProfile,
  resolveAndAttachForSubmission,
  classifySubmissionStatus,
  updateReporterProfileStatsForStatusChange,
};
