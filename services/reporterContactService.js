const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const { normalizeEmail } = require('../lib/normalizeEmail');

// Helper: safely apply provided value only if not undefined/null
function applyIfPresent(target, key, value) {
  if (value === undefined || value === null) return;
  // Empty string should not overwrite existing non-empty data unless explicitly provided
  if (typeof value === 'string' && value.trim() === '') return;
  target[key] = value;
}

function _normalizeEmail(email) {
  const normalized = normalizeEmail(email);
  return normalized || null;
}

function _normalizeText(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text || null;
}

function _normalizePhoneValue(value) {
  const raw = _normalizeText(value);
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7) return null;
  if (/^0+$/.test(digits)) return null;
  return raw.replace(/\s+/g, '');
}

function _firstNormalizedPhone(...values) {
  for (const value of values) {
    const normalized = _normalizePhoneValue(value);
    if (normalized) return normalized;
  }
  return null;
}

function _extractSubmissionContactChannels(submission) {
  return {
    sourcePhone: _firstNormalizedPhone(
      submission?.contact?.phone,
      submission?.phone,
      submission?.mobile,
      submission?.mobileNumber,
      submission?.contactNumber,
      submission?.reporterPhone,
      submission?.reporterMobile,
      submission?.reporter?.phone,
      submission?.reporter?.mobile,
      submission?.reporter?.mobileNumber,
      submission?.reporter?.contactNumber
    ),
    sourceMobile: _firstNormalizedPhone(
      submission?.mobile,
      submission?.mobileNumber,
      submission?.reporterMobile,
      submission?.reporter?.mobile,
      submission?.reporter?.mobileNumber,
      submission?.contactNumber
    ),
    sourceWhatsapp: _firstNormalizedPhone(
      submission?.contact?.whatsappNumber,
      submission?.whatsappNumber,
      submission?.whatsapp,
      submission?.reporter?.whatsapp,
      submission?.reporter?.whatsappNumber
    ),
  };
}

function _isManualOverrideEnabled(contact, key) {
  return !!(contact && contact.directoryManualOverrides && contact.directoryManualOverrides[key] && contact.directoryManualOverrides[key].enabled === true);
}

function _setSourceField(set, contact, fieldName, value, manualOverrideKey) {
  if (_isManualOverrideEnabled(contact, manualOverrideKey)) return;
  if (value === undefined || value === null || value === '') return;
  set[fieldName] = value;
}

function _setSourceStat(set, key, value) {
  if (value === undefined || value === null) return;
  set[`stats.${key}`] = value;
}

function _parseLocationParts(input) {
  if (!input) return { city: null, district: null, state: null, country: null };

  // String: "City, State, Country"
  if (typeof input === 'string') {
    const parts = String(input)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    return {
      city: parts[0] || null,
      district: null,
      state: parts[1] || null,
      country: parts[2] || null,
    };
  }

  // Object: { city, district, state, country }
  if (typeof input === 'object') {
    const city = input.city ? String(input.city).trim() : '';
    const district = input.district ? String(input.district).trim() : '';
    const state = input.state ? String(input.state).trim() : '';
    const country = input.country ? String(input.country).trim() : '';

    // Sometimes we store "Ahmedabad, Gujarat" into city; split if needed.
    if (city && city.includes(',') && !state) {
      const parsed = _parseLocationParts(city);
      return {
        city: parsed.city,
        district: district || parsed.district,
        state: parsed.state,
        country: country || parsed.country,
      };
    }

    return {
      city: city || null,
      district: district || null,
      state: state || null,
      country: country || null,
    };
  }

  return { city: null, district: null, state: null, country: null };
}

function _buildSubmissionEmailMatch(emailNorm) {
  if (!emailNorm) return null;
  return {
    $or: [
      { reporterEmailNorm: emailNorm },
      { reporterEmail: emailNorm },
      { email: emailNorm },
      { submittedByEmail: emailNorm },
      { contactEmail: emailNorm },
      { authorEmail: emailNorm },
      { 'contact.email': emailNorm },
      { 'reporter.email': emailNorm },
      { 'reporterProfile.email': emailNorm },
      { 'contributor.email': emailNorm },
    ],
    isDeleted: { $ne: true },
  };
}

/**
 * Best-effort helper: upsert ReporterContact from a saved/lean CommunitySubmission.
 * Designed to be safe across Phase-1 and legacy submission shapes.
 */
async function upsertReporterContactFromSubmission(submission) {
  const emailNorm = _normalizeEmail(
    submission?.reporterEmailNorm || submission?.reporterEmail || submission?.email || submission?.contact?.email
  );
  if (!emailNorm) return null;

  const name =
    (submission?.name && String(submission.name).trim()) ||
    (submission?.reporterName && String(submission.reporterName).trim()) ||
    (submission?.userName && String(submission.userName).trim()) ||
    (submission?.contact?.name && String(submission.contact.name).trim()) ||
    'Unknown reporter';

  const { sourcePhone, sourceMobile, sourceWhatsapp } = _extractSubmissionContactChannels(submission);
  const phone = sourcePhone || sourceMobile || '';
  const whatsapp = sourceWhatsapp || '';

  const locationInput =
    submission?.locationDetail ||
    submission?.location ||
    submission?.reporterLocation ||
    submission?.city ||
    null;

  const { city, district, state, country } = _parseLocationParts(locationInput);

  // Compute story stats for this reporter (counts + latest headline).
  const match = _buildSubmissionEmailMatch(emailNorm);
  const approvedStatuses = [
    'APPROVED', 'approved',
    // treat published as approved for approvedStories
    'PUBLISHED', 'published', 'PUBLISH', 'publish',
  ];
  const publishedStatuses = ['PUBLISHED', 'published', 'PUBLISH', 'publish'];
  const pendingStatuses = [
    'NEW', 'new',
    'PENDING', 'pending',
    'UNDER_REVIEW', 'under_review', 'UNDERREVIEW', 'underreview',
    'PENDING_FOUNDER', 'pending_founder', 'PENDINGFOUNDER', 'pendingfounder',
    'AI_REVIEWED', 'ai_reviewed',
  ];
  const rejectedStatuses = [
    'REJECTED', 'rejected',
    'TRASH', 'trash',
    'DISCARDED', 'discarded',
    'ARCHIVED', 'archived',
    'DELETED', 'deleted',
  ];
  const withdrawnStatuses = ['WITHDRAWN', 'withdrawn'];

  const [stories, approved, pending, rejected, withdrawn, published, latest] = await Promise.all([
    CommunitySubmission.countDocuments(match),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: approvedStatuses },
    }),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: pendingStatuses },
    }),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: rejectedStatuses },
    }),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: withdrawnStatuses },
    }),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: publishedStatuses },
    }),
    CommunitySubmission.findOne(match).sort({ createdAt: -1 }).lean(),
  ]);

  const lastStoryTitle = latest?.headline ? String(latest.headline).trim() : '';
  const lastStoryAt = latest?.createdAt || null;

  const out = await upsertReporterContact({
    name,
    email: emailNorm,
    phone,
    whatsapp,
    city: city || undefined,
    district: district || undefined,
    state: state || undefined,
    country: country || undefined,
    reporterType: submission?.sourceType === 'journalist' ? 'journalist' : 'community',
    stats: {
      totalStories: Number(stories || 0),
      approvedStories: Number(approved || 0),
      pendingStories: Number(pending || 0),
      rejectedStories: Number(rejected || 0),
      withdrawnStories: Number(withdrawn || 0),
      publishedStories: Number(published || 0),
      firstStoryAt: latest?.createdAt || null,
      lastStoryAt,
      lastStoryTitle,
    },
  });

  if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production' || String(process.env.REPORTER_CONTACTS_DEBUG || '').trim() === '1') {
    console.log('[reporter-contact][contact-sync]', {
      email: emailNorm,
      sourcePhone: sourcePhone || null,
      sourceMobile: sourceMobile || null,
      sourceWhatsapp: sourceWhatsapp || null,
      storedPhone: out?.contact?.phoneFull || out?.contact?.phoneNumber || null,
      storedWhatsapp: out?.contact?.whatsappNumber || null,
      responsePhone: out?.contact?.phoneFull || out?.contact?.phoneNumber || null,
      responseWhatsapp: out?.contact?.whatsappNumber || null,
    });
  }

  return out;
}

/**
 * Upsert ReporterContact keyed by emailLower.
 * - Never overwrites existing phone/location with null/empty.
 * - Preserves existing status/verificationLevel for existing contacts.
 */
async function upsertReporterContact(payload) {
  const {
    name,
    email,
    phone,
    whatsapp,
    alternatePhone,
    city,
    district,
    state,
    country,
    beat,
    area,
    notes,
    verificationLevel,
    reporterType,
    // Optional: stats (when calling from backfills)
    stats,
  } = payload || {};

  const emailNorm = _normalizeEmail(email);
  if (!emailNorm) throw new Error('Reporter email is required');
  const trimmedName = typeof name === 'string' && name.trim() ? name.trim() : '';

  let existing = null;
  try {
    if (ReporterContact?.db?.readyState === 1 && typeof ReporterContact.findOne === 'function') {
      existing = await ReporterContact.findOne({ $or: [{ emailLower: emailNorm }, { email: emailNorm }] });
    }
  } catch (_) {}

  const normalizedVerificationLevel = _normalizeText(verificationLevel);
  const $set = {};
  const $setOnInsert = {
    email: emailNorm,
    reporterType: reporterType === 'journalist' ? 'journalist' : 'community',
    status: 'active',
  };
  if (!normalizedVerificationLevel) {
    $setOnInsert.verificationLevel = reporterType === 'journalist' ? 'pending' : 'community_default';
  }
  if (!trimmedName) $setOnInsert.fullName = 'Unknown';

  // Always keep emailLower present
  $set.emailLower = emailNorm;
  $set.reporterKey = emailNorm;

  if (trimmedName) $set.fullName = trimmedName;
  _setSourceField($set, existing, 'phoneFull', _normalizePhoneValue(phone), 'phone');
  _setSourceField($set, existing, 'whatsappNumber', _normalizePhoneValue(whatsapp), 'whatsapp');
  _setSourceField($set, existing, 'alternatePhone', _normalizePhoneValue(alternatePhone), 'alternatePhone');
  _setSourceField($set, existing, 'cityTownVillage', _normalizeText(city), 'city');
  _setSourceField($set, existing, 'districtName', _normalizeText(district), 'district');
  _setSourceField($set, existing, 'stateName', _normalizeText(state), 'state');
  _setSourceField($set, existing, 'country', _normalizeText(country), 'country');
  _setSourceField($set, existing, 'primaryBeat', _normalizeText(beat), 'beat');
  _setSourceField($set, existing, 'areaName', _normalizeText(area), 'area');
  _setSourceField($set, existing, 'notes', _normalizeText(notes), 'notes');
  if (!_isManualOverrideEnabled(existing, 'verificationLevel') && normalizedVerificationLevel) {
    $set.verificationLevel = normalizedVerificationLevel;
  }

  if (stats && typeof stats === 'object') {
    if (typeof stats.totalStories === 'number') _setSourceStat($set, 'totalStories', stats.totalStories);
    if (typeof stats.approvedStories === 'number') _setSourceStat($set, 'approvedStories', stats.approvedStories);
    if (typeof stats.pendingStories === 'number') _setSourceStat($set, 'pendingStories', stats.pendingStories);
    if (typeof stats.rejectedStories === 'number') _setSourceStat($set, 'rejectedStories', stats.rejectedStories);
    if (typeof stats.withdrawnStories === 'number') _setSourceStat($set, 'withdrawnStories', stats.withdrawnStories);
    if (typeof stats.publishedStories === 'number') _setSourceStat($set, 'publishedStories', stats.publishedStories);
    if (stats.firstStoryAt) _setSourceStat($set, 'firstStoryAt', stats.firstStoryAt);
    if (stats.lastStoryAt) _setSourceStat($set, 'lastStoryAt', stats.lastStoryAt);
    if (typeof stats.lastStoryTitle === 'string' && stats.lastStoryTitle.trim()) {
      $set['stats.lastStoryTitle'] = stats.lastStoryTitle.trim();
    }
  }

  const contact = await ReporterContact.findOneAndUpdate(
    { email: emailNorm, $or: [{ emailLower: emailNorm }, { email: emailNorm }] },
    { $set, $setOnInsert },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { contact, contactId: contact._id };
}

/**
 * Upsert ReporterContact from incoming submission / journalist application payload.
 * Lookup is strictly by email (unique identifier in schema).
 * Does NOT erase existing good data with undefined / empty values.
 * @param {Object} payload
 * @returns {Promise<import('mongoose').Document>}
 */
async function upsertReporterContactFromPayload(payload) {
  const {
    name,
    email,
    phone,
    whatsapp,
    alternatePhone,
    city,
    district,
    state,
    country,
    beat,
    area,
    notes,
    verificationLevel,
    reporterType,
    languages,
    interests,
    heardAbout,
    organisationName,
    organisationType,
    positionTitle,
    beatsProfessional,
    yearsExperience,
    websiteOrPortfolio,
    socialLinks,
    journalistCharterAccepted,
    stats,
  } = payload || {};

  const { contact, contactId } = await upsertReporterContact({
    name,
    email,
    phone,
    whatsapp,
    alternatePhone,
    city,
    district,
    state,
    country,
    beat,
    area,
    notes,
    verificationLevel,
    reporterType,
    ...(stats ? { stats } : {}),
  });


  // Journalist-specific extras (only apply if present)
  applyIfPresent(contact, 'organisationName', organisationName);
  applyIfPresent(contact, 'organisationType', organisationType);
  applyIfPresent(contact, 'positionTitle', positionTitle);
  if (Array.isArray(beatsProfessional) && beatsProfessional.length) {
    contact.beatsProfessional = beatsProfessional;
  }
  if (typeof yearsExperience === 'number') {
    contact.yearsExperience = yearsExperience;
  }
  if (Array.isArray(languages) && languages.length) {
    contact.languages = languages;
  }
  if (Array.isArray(interests) && interests.length) {
    contact.interests = interests;
  }
  applyIfPresent(contact, 'heardAbout', heardAbout);
  applyIfPresent(contact, 'websiteOrPortfolio', websiteOrPortfolio);
  if (socialLinks && typeof socialLinks === 'object') {
    contact.socialLinks = contact.socialLinks || {};
    applyIfPresent(contact.socialLinks, 'linkedin', socialLinks.linkedin);
    applyIfPresent(contact.socialLinks, 'twitter', socialLinks.twitter);
  }

  if (journalistCharterAccepted === true && contact.journalistCharterAccepted !== true) {
    contact.journalistCharterAccepted = true;
    contact.charterAcceptedAt = new Date();
  }

  // In NODE_ENV=test, unit tests may stub findOneAndUpdate to return a plain object.
  // Only call .save() when it's a real Mongoose document.
  if (contact && typeof contact.save === 'function') {
    await contact.save();
  }
  return { contact, contactId };
}

module.exports = { upsertReporterContact, upsertReporterContactFromPayload, upsertReporterContactFromSubmission };