const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');
const { normalizeEmail } = require('../lib/normalizeEmail');

const AREA_TYPE_MAP = {
  metro: 'METRO',
  metropolitan: 'METRO',
  corporation: 'CORPORATION',
  city: 'CORPORATION',
  district_hq: 'DISTRICT_HQ',
  district_headquarter: 'DISTRICT_HQ',
  district_headquarters: 'DISTRICT_HQ',
  district: 'DISTRICT_HQ',
  taluka: 'TALUKA',
  tehsil: 'TALUKA',
  town: 'TOWN',
  village: 'VILLAGE',
  rural: 'VILLAGE',
  other: 'OTHER',
};

const COVERAGE_SCOPE_MAP = {
  local: 'hyperlocal',
  hyper_local: 'hyperlocal',
  hyperlocal: 'hyperlocal',
  city: 'hyperlocal',
  district: 'regional',
  regional: 'regional',
  state: 'regional',
  national: 'national',
  country: 'national',
  international: 'international',
  global: 'international',
};

function _shouldLogReporterContactPipeline() {
  const enabled = String(process.env.REPORTER_CONTACT_PIPELINE_LOG || '').trim() === '1';
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  return enabled || (env && env !== 'production');
}

function _logReporterContactPipeline(payload) {
  if (!_shouldLogReporterContactPipeline()) return;
  try {
    console.log('[reporter-contact-pipeline]', payload);
  } catch (_) {}
}

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

function _normalizeBoolean(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  const token = String(value).trim().toLowerCase();
  if (!token) return null;
  if (['1', 'true', 'yes', 'enabled', 'active', 'authenticated', 'allowed'].includes(token)) return true;
  if (['0', 'false', 'no', 'disabled', 'blocked', 'inactive', 'unauthenticated'].includes(token)) return false;
  return undefined;
}

function _normalizeNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : undefined;
}

function _normalizeAreaType(value) {
  const normalized = _normalizeText(value);
  if (normalized === undefined) return undefined;
  if (normalized === null) return null;
  const token = normalized.toLowerCase().replace(/[\s-]+/g, '_');
  return AREA_TYPE_MAP[token] || 'OTHER';
}

function _normalizeCoverageScope(value) {
  const normalized = _normalizeText(value);
  if (normalized === undefined) return undefined;
  if (normalized === null) return null;
  const token = normalized.toLowerCase().replace(/[\s-]+/g, '_');
  return COVERAGE_SCOPE_MAP[token] || null;
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

function _extractSubmissionField(source, paths) {
  for (const path of paths) {
    const segments = String(path || '').split('.').filter(Boolean);
    let cursor = source;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== 'object') {
        cursor = undefined;
        break;
      }
      cursor = cursor[segment];
    }
    if (cursor !== undefined) return cursor;
  }
  return undefined;
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
  if (!input) return { city: null, district: null, state: null, country: null, area: null };

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
      area: null,
    };
  }

  // Object: { city, district, state, country }
  if (typeof input === 'object') {
    const city = input.city ? String(input.city).trim() : '';
    const district = input.district ? String(input.district).trim() : '';
    const state = input.state ? String(input.state).trim() : '';
    const country = input.country ? String(input.country).trim() : '';
    const area = (input.area ?? input.areaName ?? input.areaLocality) ? String(input.area ?? input.areaName ?? input.areaLocality).trim() : '';

    // Sometimes we store "Ahmedabad, Gujarat" into city; split if needed.
    if (city && city.includes(',') && !state) {
      const parsed = _parseLocationParts(city);
      return {
        city: parsed.city,
        district: district || parsed.district,
        state: parsed.state,
        country: country || parsed.country,
        area: area || parsed.area,
      };
    }

    return {
      city: city || null,
      district: district || null,
      state: state || null,
      country: country || null,
      area: area || null,
    };
  }

  return { city: null, district: null, state: null, country: null, area: null };
}

function _extractSubmissionReporterSnapshot(submission) {
  const { sourcePhone, sourceMobile, sourceWhatsapp } = _extractSubmissionContactChannels(submission);
  const locationInput =
    submission?.locationDetail ||
    submission?.location ||
    submission?.reporterLocation ||
    {
      city: submission?.city,
      district: submission?.district,
      state: submission?.state,
      country: submission?.country,
      area: submission?.area,
    };

  const location = _parseLocationParts(locationInput);
  const organisationName = _normalizeText(
    _extractSubmissionField(submission, [
      'organisationName',
      'organizationName',
      'organization',
      'organisation',
      'reporter.organisationName',
      'reporter.organizationName',
      'reporter.organization',
      'reporter.organisation',
    ])
  );
  const portalAccessEnabled = _normalizeBoolean(
    _extractSubmissionField(submission, [
      'portalAccessEnabled',
      'portalAuthStatus',
      'reporter.portalAccessEnabled',
      'reporter.portalAuthStatus',
    ])
  );
  const portalAuthVersion = _normalizeNumber(
    _extractSubmissionField(submission, ['portalAuthVersion', 'reporter.portalAuthVersion'])
  );

  return {
    name:
      (submission?.name && String(submission.name).trim()) ||
      (submission?.reporterName && String(submission.reporterName).trim()) ||
      (submission?.userName && String(submission.userName).trim()) ||
      (submission?.contact?.name && String(submission.contact.name).trim()) ||
      'Unknown reporter',
    email: _normalizeEmail(
      submission?.reporterEmailNorm || submission?.reporterEmail || submission?.email || submission?.contact?.email
    ),
    phone: sourcePhone || sourceMobile || '',
    whatsapp: sourceWhatsapp || '',
    city: location.city || _normalizeText(submission?.city) || undefined,
    district: location.district || _normalizeText(submission?.district) || undefined,
    state: location.state || _normalizeText(submission?.state) || undefined,
    country: location.country || _normalizeText(submission?.country) || undefined,
    area: location.area || _normalizeText(submission?.area) || undefined,
    areaType: _normalizeAreaType(
      _extractSubmissionField(submission, ['areaType', 'reporter.areaType', 'location.areaType', 'locationDetail.areaType'])
    ),
    coverageScope: _normalizeCoverageScope(
      _extractSubmissionField(submission, ['coverageScope', 'reporter.coverageScope', 'location.coverageScope', 'locationDetail.coverageScope'])
    ),
    beat: _normalizeText(
      _extractSubmissionField(submission, ['beat', 'primaryBeat', 'reporter.beat', 'reporter.primaryBeat'])
    ),
    organisationName: organisationName || undefined,
    portalAccessEnabled,
    portalAuthVersion,
  };
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
  const snapshot = _extractSubmissionReporterSnapshot(submission);
  const emailNorm = snapshot.email;
  if (!emailNorm) return null;

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
    name: snapshot.name,
    email: emailNorm,
    phone: snapshot.phone,
    whatsapp: snapshot.whatsapp,
    city: snapshot.city,
    district: snapshot.district,
    state: snapshot.state,
    country: snapshot.country,
    area: snapshot.area,
    areaType: snapshot.areaType,
    coverageScope: snapshot.coverageScope,
    beat: snapshot.beat,
    organisationName: snapshot.organisationName,
    portalAccessEnabled: snapshot.portalAccessEnabled,
    portalAuthVersion: snapshot.portalAuthVersion,
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
      sourcePhone: snapshot.phone || null,
      sourceMobile: null,
      sourceWhatsapp: snapshot.whatsapp || null,
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
    areaType,
    coverageScope,
    notes,
    verificationLevel,
    reporterType,
    organisationName,
    portalAccessEnabled,
    portalAuthVersion,
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

  _logReporterContactPipeline({
    stage: 'upsert.before',
    email: emailNorm,
    incomingPhone: _normalizePhoneValue(phone),
    incomingWhatsapp: _normalizePhoneValue(whatsapp),
    incomingCity: _normalizeText(city),
    incomingDistrict: _normalizeText(district),
    incomingState: _normalizeText(state),
    incomingCountry: _normalizeText(country),
    incomingArea: _normalizeText(area),
    incomingAreaType: _normalizeAreaType(areaType),
    incomingCoverageScope: _normalizeCoverageScope(coverageScope),
    incomingBeat: _normalizeText(beat),
    incomingOrganisation: _normalizeText(organisationName),
    incomingPortalAccessEnabled: portalAccessEnabled,
    incomingPortalAuthVersion: portalAuthVersion,
    storedPhone: _normalizePhoneValue(existing?.phoneFull || existing?.phoneNumber || null),
    storedWhatsapp: _normalizePhoneValue(existing?.whatsappNumber || null),
    storedCity: _normalizeText(existing?.cityTownVillage || null),
    storedDistrict: _normalizeText(existing?.districtName || null),
    storedState: _normalizeText(existing?.stateName || null),
    storedCountry: _normalizeText(existing?.country || null),
    storedArea: _normalizeText(existing?.areaName || null),
    storedAreaType: _normalizeText(existing?.areaType || null),
    storedCoverageScope: _normalizeText(existing?.coverageScope || null),
    storedBeat: _normalizeText(existing?.primaryBeat || null),
    storedOrganisation: _normalizeText(existing?.organisationName || null),
    reporterContactId: existing?._id ? String(existing._id) : null,
  });

  const normalizedVerificationLevel = _normalizeText(verificationLevel);
  const $set = {};
  const $setOnInsert = {
    email: emailNorm,
    reporterType: reporterType === 'journalist' ? 'journalist' : 'community',
    status: 'active',
    directoryStatus: 'active',
  };
  if (!normalizedVerificationLevel) {
    $setOnInsert.verificationLevel = reporterType === 'journalist' ? 'pending' : 'community_default';
  }
  if (!trimmedName) $setOnInsert.fullName = 'Unknown';

  // Always keep emailLower present
  $set.emailLower = emailNorm;
  $set.reporterKey = emailNorm;

  if (trimmedName) $set.fullName = trimmedName;
  const normalizedPhone = _normalizePhoneValue(phone);
  _setSourceField($set, existing, 'phoneFull', normalizedPhone, 'phone');
  _setSourceField($set, existing, 'phoneNumber', normalizedPhone, 'phone');
  _setSourceField($set, existing, 'whatsappNumber', _normalizePhoneValue(whatsapp), 'whatsapp');
  _setSourceField($set, existing, 'alternatePhone', _normalizePhoneValue(alternatePhone), 'alternatePhone');
  _setSourceField($set, existing, 'cityTownVillage', _normalizeText(city), 'city');
  _setSourceField($set, existing, 'districtName', _normalizeText(district), 'district');
  _setSourceField($set, existing, 'stateName', _normalizeText(state), 'state');
  _setSourceField($set, existing, 'country', _normalizeText(country), 'country');
  _setSourceField($set, existing, 'primaryBeat', _normalizeText(beat), 'beat');
  _setSourceField($set, existing, 'areaName', _normalizeText(area), 'area');
  _setSourceField($set, existing, 'areaType', _normalizeAreaType(areaType), 'area');
  _setSourceField($set, existing, 'coverageScope', _normalizeCoverageScope(coverageScope), 'area');
  if (_normalizeText(organisationName)) $set.organisationName = _normalizeText(organisationName);
  _setSourceField($set, existing, 'notes', _normalizeText(notes), 'notes');
  if (!_isManualOverrideEnabled(existing, 'verificationLevel') && normalizedVerificationLevel) {
    $set.verificationLevel = normalizedVerificationLevel;
  }
  if (portalAccessEnabled !== undefined && portalAccessEnabled !== null) {
    $set.portalAccessEnabled = !!portalAccessEnabled;
  }
  if (portalAuthVersion !== undefined && portalAuthVersion !== null) {
    $set.portalAuthVersion = portalAuthVersion;
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

  _logReporterContactPipeline({
    stage: 'upsert.after',
    email: emailNorm,
    incomingPhone: _normalizePhoneValue(phone),
    incomingWhatsapp: _normalizePhoneValue(whatsapp),
    storedPhone: _normalizePhoneValue(contact?.phoneFull || contact?.phoneNumber || null),
    storedWhatsapp: _normalizePhoneValue(contact?.whatsappNumber || null),
    storedCity: _normalizeText(contact?.cityTownVillage || null),
    storedDistrict: _normalizeText(contact?.districtName || null),
    storedState: _normalizeText(contact?.stateName || null),
    storedCountry: _normalizeText(contact?.country || null),
    storedArea: _normalizeText(contact?.areaName || null),
    storedAreaType: _normalizeText(contact?.areaType || null),
    storedCoverageScope: _normalizeText(contact?.coverageScope || null),
    storedBeat: _normalizeText(contact?.primaryBeat || null),
    storedOrganisation: _normalizeText(contact?.organisationName || null),
    reporterContactId: contact?._id ? String(contact._id) : null,
  });

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
    areaType,
    coverageScope,
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
    organisationName: organisationNameInput,
    organizationName,
    organization,
    organisation,
    portalAccessEnabled,
    portalAuthVersion,
    stats,
  } = payload || {};

  const normalizedOrganisationName = organisationNameInput || organizationName || organization || organisation;

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
    areaType,
    coverageScope,
    notes,
    verificationLevel,
    reporterType,
    organisationName: normalizedOrganisationName,
    portalAccessEnabled,
    portalAuthVersion,
    ...(stats ? { stats } : {}),
  });


  // Journalist-specific extras (only apply if present)
  applyIfPresent(contact, 'organisationName', normalizedOrganisationName);
  applyIfPresent(contact, 'organisationType', organisationType);
  applyIfPresent(contact, 'positionTitle', positionTitle);
  applyIfPresent(contact, 'coverageScope', _normalizeCoverageScope(coverageScope));
  applyIfPresent(contact, 'areaType', _normalizeAreaType(areaType));
  if (_normalizeBoolean(portalAccessEnabled) !== undefined) {
    contact.portalAccessEnabled = _normalizeBoolean(portalAccessEnabled);
  }
  if (_normalizeNumber(portalAuthVersion) !== undefined) {
    contact.portalAuthVersion = _normalizeNumber(portalAuthVersion);
  }
  if (_normalizePhoneValue(phone) && !contact.phoneNumber) {
    contact.phoneNumber = _normalizePhoneValue(phone);
  }
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