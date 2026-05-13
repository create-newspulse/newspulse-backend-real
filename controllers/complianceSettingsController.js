const mongoose = require('mongoose');
const ComplianceSettings = require('../models/ComplianceSettings');

const PUBLIC_FIELDS = [
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
  'updatedAt',
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

function pickPublicFields(doc) {
  const source = normalizeSettings(doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);
  const output = {};

  for (const field of PUBLIC_FIELDS) {
    output[field] = source && Object.prototype.hasOwnProperty.call(source, field) ? source[field] : '';
  }

  return output;
}

function buildPayload(body = {}, existing = {}) {
  const defaults = ComplianceSettings.getDefaultSettings();
  const current = ComplianceSettings.normalizeSettings(existing);
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
  };

  const errors = [];
  for (const [field, value] of Object.entries({
    founderName: payload.founderName,
    founderDesignation: payload.founderDesignation,
    publisherEntity: payload.publisherEntity,
    websiteUrl: payload.websiteUrl,
    grievanceOfficerDesignation: payload.grievanceOfficerDesignation,
    grievanceEmail: payload.grievanceEmail,
    grievanceOfficerLocation: payload.grievanceOfficerLocation,
    chiefEditorDesignation: payload.chiefEditorDesignation,
  })) {
    if (!value) errors.push(`${field} is required`);
  }

  return { payload, errors };
}

async function getSettingsDocument() {
  return ComplianceSettings.getOrCreate();
}

async function getAdminComplianceSettings(_req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const settings = await getSettingsDocument();
    return res.status(200).json({ ok: true, item: pickPublicFields(settings) });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error?.message || 'Failed to load compliance settings' });
  }
}

async function updateAdminComplianceSettings(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

    const existing = await getSettingsDocument();
    const { payload, errors } = buildPayload(req.body, existing && typeof existing.toObject === 'function' ? existing.toObject() : existing);
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

    return res.status(200).json({ ok: true, item: pickPublicFields(settings) });
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