const mongoose = require('mongoose');

const DEFAULT_SRB_REGISTRATION = {
  organization: 'Working Journalist Media Council (WJMC)',
  publisher: 'News Pulse (Digital)',
  status: 'Registered',
  registrationNumber: 'WJMC/7489/462-26',
  issueDate: '2026-09-14',
  validUntil: '2027-09-14',
};

const DEFAULT_COMPLIANCE_SETTINGS = {
  founderName: 'Kiran Parmar',
  founderDesignation: 'Founder, News Pulse',
  publisherEntity: 'News Pulse Media',
  showPublisherEntity: true,
  showFounderPublisher: false,
  websiteUrl: 'https://www.newspulse.co.in',
  grievanceOfficerName: '',
  grievanceOfficerDesignation: 'Grievance Officer',
  grievanceEmail: 'grievance@newspulse.co.in',
  grievanceOfficerLocation: 'India',
  showChiefEditor: true,
  chiefEditorName: '',
  chiefEditorDesignation: 'Chief Editor',
  editorialEmail: '',
  srbRegistration: DEFAULT_SRB_REGISTRATION,
  srbRegistrationHistory: [],
};

const SRB_REGISTRATION_FIELDS = [
  'organization',
  'publisher',
  'status',
  'registrationNumber',
  'issueDate',
  'validUntil',
];

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeBoolean(value, fallbackValue) {
  if (value === undefined || value === null) return !!fallbackValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return !!value;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) {
      return source[key];
    }
  }
  return undefined;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSrbRegistration(source = {}, fallback = DEFAULT_SRB_REGISTRATION) {
  const raw = isPlainObject(source) ? source : {};
  const normalized = {};
  for (const field of SRB_REGISTRATION_FIELDS) {
    normalized[field] = normalizeOptionalString(raw[field]) || normalizeOptionalString(fallback && fallback[field]);
  }
  return normalized;
}

function normalizeSrbRegistrationHistory(source = []) {
  if (!Array.isArray(source)) return [];
  return source
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      ...normalizeSrbRegistration(entry, {}),
      archivedAt: normalizeOptionalString(entry.archivedAt),
    }));
}

function comparableValue(value) {
  if (value && typeof value.toObject === 'function') return value.toObject();
  return value;
}

function valuesEqual(left, right) {
  const normalizedLeft = comparableValue(left);
  const normalizedRight = comparableValue(right);
  if (isPlainObject(normalizedLeft) || Array.isArray(normalizedLeft) || isPlainObject(normalizedRight) || Array.isArray(normalizedRight)) {
    return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight);
  }
  return normalizedLeft === normalizedRight;
}

function resolveStoredSettings(source = {}) {
  return {
    founderName: normalizeOptionalString(source.founderName) || DEFAULT_COMPLIANCE_SETTINGS.founderName,
    founderDesignation: normalizeOptionalString(source.founderDesignation) || DEFAULT_COMPLIANCE_SETTINGS.founderDesignation,
    publisherEntity: normalizeOptionalString(source.publisherEntity) || DEFAULT_COMPLIANCE_SETTINGS.publisherEntity,
    showPublisherEntity: normalizeBoolean(source.showPublisherEntity, DEFAULT_COMPLIANCE_SETTINGS.showPublisherEntity),
    showFounderPublisher: normalizeBoolean(source.showFounderPublisher, DEFAULT_COMPLIANCE_SETTINGS.showFounderPublisher),
    websiteUrl: normalizeOptionalString(source.websiteUrl) || DEFAULT_COMPLIANCE_SETTINGS.websiteUrl,
    grievanceOfficerName: normalizeOptionalString(firstDefined(source, ['grievanceOfficerName', 'officerName'])),
    grievanceOfficerDesignation:
      normalizeOptionalString(firstDefined(source, ['grievanceOfficerDesignation', 'officerDesignation']))
      || DEFAULT_COMPLIANCE_SETTINGS.grievanceOfficerDesignation,
    grievanceEmail: normalizeOptionalString(source.grievanceEmail) || DEFAULT_COMPLIANCE_SETTINGS.grievanceEmail,
    grievanceOfficerLocation:
      normalizeOptionalString(firstDefined(source, ['grievanceOfficerLocation', 'officerLocation']))
      || DEFAULT_COMPLIANCE_SETTINGS.grievanceOfficerLocation,
    showChiefEditor: normalizeBoolean(source.showChiefEditor, DEFAULT_COMPLIANCE_SETTINGS.showChiefEditor),
    chiefEditorName: normalizeOptionalString(source.chiefEditorName),
    chiefEditorDesignation: normalizeOptionalString(source.chiefEditorDesignation) || DEFAULT_COMPLIANCE_SETTINGS.chiefEditorDesignation,
    editorialEmail: normalizeOptionalString(source.editorialEmail),
    srbRegistration: normalizeSrbRegistration(source.srbRegistration, DEFAULT_COMPLIANCE_SETTINGS.srbRegistration),
    srbRegistrationHistory: normalizeSrbRegistrationHistory(source.srbRegistrationHistory),
  };
}

const SrbRegistrationSchema = new mongoose.Schema(
  {
    organization: { type: String, trim: true, default: DEFAULT_SRB_REGISTRATION.organization },
    publisher: { type: String, trim: true, default: DEFAULT_SRB_REGISTRATION.publisher },
    status: { type: String, trim: true, default: DEFAULT_SRB_REGISTRATION.status },
    registrationNumber: { type: String, trim: true, default: DEFAULT_SRB_REGISTRATION.registrationNumber },
    issueDate: { type: String, trim: true, default: DEFAULT_SRB_REGISTRATION.issueDate },
    validUntil: { type: String, trim: true, default: DEFAULT_SRB_REGISTRATION.validUntil },
  },
  { _id: false }
);

const SrbRegistrationHistorySchema = new mongoose.Schema(
  {
    organization: { type: String, trim: true, default: '' },
    publisher: { type: String, trim: true, default: '' },
    status: { type: String, trim: true, default: '' },
    registrationNumber: { type: String, trim: true, default: '' },
    issueDate: { type: String, trim: true, default: '' },
    validUntil: { type: String, trim: true, default: '' },
    archivedAt: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const ComplianceSettingsSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      default: 'default',
      unique: true,
      trim: true,
    },
    founderName: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.founderName,
    },
    founderDesignation: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.founderDesignation,
    },
    publisherEntity: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.publisherEntity,
    },
    showPublisherEntity: {
      type: Boolean,
      default: DEFAULT_COMPLIANCE_SETTINGS.showPublisherEntity,
    },
    showFounderPublisher: {
      type: Boolean,
      default: DEFAULT_COMPLIANCE_SETTINGS.showFounderPublisher,
    },
    websiteUrl: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.websiteUrl,
    },
    grievanceOfficerName: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.grievanceOfficerName,
    },
    grievanceOfficerDesignation: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.grievanceOfficerDesignation,
    },
    grievanceEmail: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.grievanceEmail,
    },
    grievanceOfficerLocation: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.grievanceOfficerLocation,
    },
    showChiefEditor: {
      type: Boolean,
      default: DEFAULT_COMPLIANCE_SETTINGS.showChiefEditor,
    },
    chiefEditorName: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.chiefEditorName,
    },
    chiefEditorDesignation: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.chiefEditorDesignation,
    },
    editorialEmail: {
      type: String,
      trim: true,
      default: DEFAULT_COMPLIANCE_SETTINGS.editorialEmail,
    },
    srbRegistration: {
      type: SrbRegistrationSchema,
      default: () => cloneJsonValue(DEFAULT_COMPLIANCE_SETTINGS.srbRegistration),
    },
    srbRegistrationHistory: {
      type: [SrbRegistrationHistorySchema],
      default: () => [],
    },
    officerName: {
      type: String,
      trim: true,
      default: undefined,
    },
    officerDesignation: {
      type: String,
      trim: true,
      default: undefined,
    },
    officerLocation: {
      type: String,
      trim: true,
      default: undefined,
    },
  },
  { timestamps: true }
);

ComplianceSettingsSchema.statics.getDefaultSettings = function getDefaultSettings() {
  return cloneJsonValue(DEFAULT_COMPLIANCE_SETTINGS);
};

ComplianceSettingsSchema.statics.normalizeSettings = function normalizeSettings(source = {}) {
  return resolveStoredSettings(source);
};

ComplianceSettingsSchema.statics.getOrCreate = async function getOrCreate() {
  let settings = await this.findOne({ scope: 'default' });
  if (!settings) {
    settings = await this.create({
      scope: 'default',
      ...resolveStoredSettings(DEFAULT_COMPLIANCE_SETTINGS),
    });
    return settings;
  }

  const normalized = resolveStoredSettings(typeof settings.toObject === 'function' ? settings.toObject() : settings);
  let dirty = false;
  for (const [field, value] of Object.entries(normalized)) {
    if (!valuesEqual(settings[field], value)) {
      settings[field] = value;
      dirty = true;
    }
  }

  if (dirty) {
    await settings.save();
  }

  return settings;
};

module.exports = mongoose.models.ComplianceSettings || mongoose.model('ComplianceSettings', ComplianceSettingsSchema);