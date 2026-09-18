const mongoose = require('mongoose');
const ComplianceSettings = require('../models/ComplianceSettings');
const { invalidatePublicSettingsCaches } = require('../lib/cache');

const ADMIN_FIELDS = [
  'founderName',
  'founderDesignation',
  'publisherEntity',
  'showPublisherEntity',
  'showFounderPublisher',
  'websiteUrl',
  'grievanceOfficerName',
  'grievanceOfficerDesignation',
  'grievanceEmail',
  'grievanceOfficerLocation',
  'showChiefEditor',
  'chiefEditorName',
  'chiefEditorDesignation',
  'editorialEmail',
  'officerName',
  'officerDesignation',
  'officerLocation',
  'srbRegistration',
  'srbRegistrationHistory',
  'updatedAt',
];

const PUBLIC_FIELDS = ADMIN_FIELDS.filter((field) => ![
  'grievanceOfficerLocation',
  'officerLocation',
  'srbRegistrationHistory',
].includes(field));

const SRB_REGISTRATION_FIELDS = [
  'organization',
  'publisher',
  'status',
  'registrationNumber',
  'issueDate',
  'validUntil',
];

function isDbReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function resolveBooleanValue(body, key, fallbackValue) {
  if (!hasOwn(body, key)) return !!fallbackValue;
  const value = body[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return !!value;
}

function hasOwn(source, key) {
  return !!source && Object.prototype.hasOwnProperty.call(source, key);
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (hasOwn(source, key) && source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function resolveFieldValue(body, keys, fallbackValue = '') {
  const matchedKey = keys.find((key) => hasOwn(body, key));
  if (matchedKey) {
    return normalizeOptionalString(body[matchedKey]);
  }
  return normalizeOptionalString(fallbackValue);
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isFounder(req) {
  const role = String((req && req.admin && req.admin.role) || '').trim().toLowerCase();
  return role === 'founder' || Boolean(req && req.admin && req.admin.isFounder);
}

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidIsoDateOnly(value) {
  const raw = normalizeOptionalString(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;

  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}

function normalizeSrbRegistrationInput(value, fallback = {}) {
  const source = isPlainObject(value) ? value : {};
  const normalized = {};
  for (const field of SRB_REGISTRATION_FIELDS) {
    normalized[field] = hasOwn(source, field)
      ? normalizeOptionalString(source[field])
      : normalizeOptionalString(fallback && fallback[field]);
  }
  return normalized;
}

function validateSrbRegistration(registration) {
  const errors = [];
  for (const field of SRB_REGISTRATION_FIELDS) {
    if (!normalizeOptionalString(registration && registration[field])) errors.push(`srbRegistration.${field} is required`);
  }

  const issueDate = normalizeOptionalString(registration && registration.issueDate);
  const validUntil = normalizeOptionalString(registration && registration.validUntil);
  const hasValidIssueDate = isValidIsoDateOnly(issueDate);
  const hasValidUntilDate = isValidIsoDateOnly(validUntil);
  if (issueDate && !hasValidIssueDate) errors.push('srbRegistration.issueDate must be a valid YYYY-MM-DD date');
  if (validUntil && !hasValidUntilDate) errors.push('srbRegistration.validUntil must be a valid YYYY-MM-DD date');
  if (hasValidIssueDate && hasValidUntilDate && validUntil < issueDate) {
    errors.push('srbRegistration.validUntil must not be earlier than srbRegistration.issueDate');
  }

  return errors;
}

function normalizeSrbRegistrationHistory(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      ...normalizeSrbRegistrationInput(entry, {}),
      archivedAt: normalizeOptionalString(entry.archivedAt),
    }));
}

function srbRegistrationsEqual(left, right) {
  return JSON.stringify(normalizeSrbRegistrationInput(left, {})) === JSON.stringify(normalizeSrbRegistrationInput(right, {}));
}

function hasSrbRegistrationFields(registration) {
  return SRB_REGISTRATION_FIELDS.every((field) => !!normalizeOptionalString(registration && registration[field]));
}

function isSrbRenewalRequested(body) {
  const action = normalizeOptionalString(body && body.srbRegistrationAction).toLowerCase();
  return body && (body.srbRegistrationRenewal === true || body.renewSrbRegistration === true || ['renew', 'renewal', 'replace', 'replacement'].includes(action));
}

function isSrbRegistrationChangeRequested(body, existing) {
  if (!hasOwn(body, 'srbRegistration')) return false;
  return !srbRegistrationsEqual(body.srbRegistration, ComplianceSettings.normalizeSettings(existing || {}).srbRegistration);
}

function normalizeSettings(source) {
  const raw = source || {};
  const normalized = ComplianceSettings.normalizeSettings(raw);
  return {
    ...raw,
    ...normalized,
    officerName: normalized.grievanceOfficerName,
    officerDesignation: normalized.grievanceOfficerDesignation,
    officerLocation: normalized.grievanceOfficerLocation,
  };
}

function pickFields(doc, fields) {
  const source = normalizeSettings(doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);
  const output = {};

  for (const field of fields) {
    output[field] = source && Object.prototype.hasOwnProperty.call(source, field) ? source[field] : '';
  }

  return output;
}

function pickAdminFields(doc) {
  return pickFields(doc, ADMIN_FIELDS);
}

function pickPublicFields(doc) {
  return pickFields(doc, PUBLIC_FIELDS);
}

function buildPayload(body = {}, existing = {}) {
  const defaults = ComplianceSettings.getDefaultSettings();
  const current = ComplianceSettings.normalizeSettings(existing);
  const hasSrbRegistrationPayload = hasOwn(body, 'srbRegistration');
  const srbRegistration = hasSrbRegistrationPayload
    ? normalizeSrbRegistrationInput(body.srbRegistration, current.srbRegistration || defaults.srbRegistration)
    : current.srbRegistration;
  const srbRegistrationHistory = normalizeSrbRegistrationHistory(current.srbRegistrationHistory);

  const payload = {
    founderName: resolveFieldValue(body, ['founderName'], current.founderName || defaults.founderName),
    founderDesignation: resolveFieldValue(body, ['founderDesignation'], current.founderDesignation || defaults.founderDesignation),
    publisherEntity: resolveFieldValue(body, ['publisherEntity'], current.publisherEntity || defaults.publisherEntity),
    showPublisherEntity: resolveBooleanValue(body, 'showPublisherEntity', current.showPublisherEntity ?? defaults.showPublisherEntity),
    showFounderPublisher: resolveBooleanValue(body, 'showFounderPublisher', current.showFounderPublisher ?? defaults.showFounderPublisher),
    websiteUrl: resolveFieldValue(body, ['websiteUrl'], current.websiteUrl || defaults.websiteUrl),
    grievanceOfficerName: resolveFieldValue(body, ['grievanceOfficerName', 'officerName'], current.grievanceOfficerName),
    grievanceOfficerDesignation: resolveFieldValue(
      body,
      ['grievanceOfficerDesignation', 'officerDesignation'],
      current.grievanceOfficerDesignation || defaults.grievanceOfficerDesignation,
    ),
    grievanceEmail: resolveFieldValue(body, ['grievanceEmail'], current.grievanceEmail || defaults.grievanceEmail),
    grievanceOfficerLocation: resolveFieldValue(
      body,
      ['grievanceOfficerLocation', 'officerLocation'],
      current.grievanceOfficerLocation || defaults.grievanceOfficerLocation,
    ),
    showChiefEditor: resolveBooleanValue(body, 'showChiefEditor', current.showChiefEditor ?? defaults.showChiefEditor),
    chiefEditorName: resolveFieldValue(body, ['chiefEditorName'], current.chiefEditorName),
    chiefEditorDesignation: resolveFieldValue(
      body,
      ['chiefEditorDesignation'],
      current.chiefEditorDesignation || defaults.chiefEditorDesignation,
    ),
    editorialEmail: resolveFieldValue(body, ['editorialEmail'], current.editorialEmail),
    srbRegistration,
    srbRegistrationHistory,
  };

  const errors = [];
  for (const [field, value] of Object.entries({
    founderName: payload.founderName,
    founderDesignation: payload.founderDesignation,
    publisherEntity: payload.publisherEntity,
    websiteUrl: payload.websiteUrl,
    grievanceOfficerDesignation: payload.grievanceOfficerDesignation,
    grievanceEmail: payload.grievanceEmail,
    chiefEditorDesignation: payload.chiefEditorDesignation,
  })) {
    if (!value) errors.push(`${field} is required`);
  }

  if (hasSrbRegistrationPayload) {
    if (!isPlainObject(body.srbRegistration)) {
      errors.push('srbRegistration must be an object');
    } else {
      errors.push(...validateSrbRegistration(srbRegistration));
    }
  }

  return { payload, errors };
}

function applySrbRenewal(payload, body, existing, now = new Date()) {
  if (!isSrbRenewalRequested(body)) return null;
  if (!hasOwn(body, 'srbRegistration')) return ['srbRegistration is required for SRB registration renewal'];

  const current = ComplianceSettings.normalizeSettings(existing || {});
  const previousRegistration = current.srbRegistration;
  if (!hasSrbRegistrationFields(previousRegistration) || srbRegistrationsEqual(previousRegistration, payload.srbRegistration)) {
    return null;
  }

  payload.srbRegistrationHistory = [
    ...normalizeSrbRegistrationHistory(current.srbRegistrationHistory),
    {
      ...normalizeSrbRegistrationInput(previousRegistration, {}),
      archivedAt: now.toISOString(),
    },
  ];
  return null;
}

async function getSettingsDocument() {
  return ComplianceSettings.getOrCreate();
}

async function getAdminComplianceSettings(_req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const settings = await getSettingsDocument();
    return res.status(200).json({ ok: true, item: pickAdminFields(settings) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to load compliance settings' });
  }
}

async function updateAdminComplianceSettings(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const existing = await getSettingsDocument();
    const existingObject = existing && typeof existing.toObject === 'function' ? existing.toObject() : existing;

    if ((isSrbRenewalRequested(req.body) || isSrbRegistrationChangeRequested(req.body, existingObject)) && !isFounder(req)) {
      return res.status(403).json({ ok: false, message: 'Founder role required' });
    }

    const { payload, errors } = buildPayload(req.body, existingObject);
    const renewalErrors = applySrbRenewal(payload, req.body, existingObject);
    if (renewalErrors) errors.push(...renewalErrors);
    if (errors.length > 0) {
      return res.status(400).json({ ok: false, message: 'Validation failed', errors });
    }

    const settings = await ComplianceSettings.findOneAndUpdate(
      { scope: 'default' },
      {
        $set: payload,
        $unset: {
          officerName: 1,
          officerDesignation: 1,
          officerLocation: 1,
        },
        $setOnInsert: { scope: 'default' },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    );

    invalidatePublicSettingsCaches().catch(() => {});

    return res.status(200).json({ ok: true, item: pickAdminFields(settings) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to update compliance settings' });
  }
}

async function getPublicComplianceSettings(_req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const settings = await getSettingsDocument();
    return res.status(200).json({ ok: true, item: pickPublicFields(settings) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to load compliance settings' });
  }
}

module.exports = {
  getAdminComplianceSettings,
  getPublicComplianceSettings,
  updateAdminComplianceSettings,
};