const mongoose = require('mongoose');

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
};

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
  };
}

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
  return { ...DEFAULT_COMPLIANCE_SETTINGS };
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
    if (settings[field] !== value) {
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