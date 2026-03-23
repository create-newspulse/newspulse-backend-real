const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');

// Helper: safely apply provided value only if not undefined/null
function applyIfPresent(target, key, value) {
  if (value === undefined || value === null) return;
  // Empty string should not overwrite existing non-empty data unless explicitly provided
  if (typeof value === 'string' && value.trim() === '') return;
  target[key] = value;
}

function _normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e || null;
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
      { 'contact.email': emailNorm },
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

  const phone =
    (submission?.contact?.phone && String(submission.contact.phone).trim()) ||
    (submission?.phone && String(submission.phone).trim()) ||
    (submission?.whatsapp && String(submission.whatsapp).trim()) ||
    '';

  const locationInput =
    submission?.locationDetail ||
    submission?.location ||
    submission?.reporterLocation ||
    submission?.city ||
    null;

  const { city, district, state, country } = _parseLocationParts(locationInput);

  // Compute story stats for this reporter (counts + latest headline).
  const match = _buildSubmissionEmailMatch(emailNorm);
  const approvedStatuses = ['APPROVED', 'approved'];
  const pendingStatuses = ['NEW', 'UNDER_REVIEW', 'PENDING_FOUNDER', 'pending', 'under_review'];

  const [stories, approved, pending, latest] = await Promise.all([
    CommunitySubmission.countDocuments(match),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: approvedStatuses },
    }),
    CommunitySubmission.countDocuments({
      ...match,
      status: { $in: pendingStatuses },
    }),
    CommunitySubmission.findOne(match).sort({ createdAt: -1 }).lean(),
  ]);

  const lastStoryTitle = latest?.headline ? String(latest.headline).trim() : '';
  const lastStoryAt = latest?.createdAt || null;

  return upsertReporterContact({
    name,
    email: emailNorm,
    phone,
    city: city || undefined,
    district: district || undefined,
    state: state || undefined,
    country: country || undefined,
    reporterType: submission?.sourceType === 'journalist' ? 'journalist' : 'community',
    stats: {
      totalStories: Number(stories || 0),
      approvedStories: Number(approved || 0),
      pendingStories: Number(pending || 0),
      lastStoryAt,
      lastStoryTitle,
    },
  });
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
    city,
    district,
    state,
    country,
    reporterType,
    // Optional: stats (when calling from backfills)
    stats,
  } = payload || {};

  const emailNorm = _normalizeEmail(email);
  if (!emailNorm) throw new Error('Reporter email is required');

  const $set = {};
  const $setOnInsert = {
    fullName: (typeof name === 'string' && name.trim()) ? name.trim() : 'Unknown',
    email: emailNorm,
    emailLower: emailNorm,
    reporterType: reporterType === 'journalist' ? 'journalist' : 'community',
    verificationLevel: reporterType === 'journalist' ? 'pending' : 'community_default',
    status: 'active',
  };

  // Always keep emailLower present
  $set.emailLower = emailNorm;

  if (typeof name === 'string' && name.trim()) $set.fullName = name.trim();
  if (typeof phone === 'string' && phone.trim()) $set.phoneFull = phone.trim();
  if (typeof city === 'string' && city.trim()) $set.cityTownVillage = city.trim();
  if (typeof district === 'string' && district.trim()) $set.districtName = district.trim();
  if (typeof state === 'string' && state.trim()) $set.stateName = state.trim();
  if (typeof country === 'string' && country.trim()) $set.country = country.trim();

  if (stats && typeof stats === 'object') {
    if (typeof stats.totalStories === 'number') $set['stats.totalStories'] = stats.totalStories;
    if (typeof stats.approvedStories === 'number') $set['stats.approvedStories'] = stats.approvedStories;
    if (typeof stats.pendingStories === 'number') $set['stats.pendingStories'] = stats.pendingStories;
    if (stats.lastStoryAt) $set['stats.lastStoryAt'] = stats.lastStoryAt;
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
    city,
    state,
    country,
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
    city,
    state,
    country,
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