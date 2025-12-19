const mongoose = require('mongoose');

const SettingsVersionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true, index: true },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    note: { type: String, default: '' },
    createdBy: {
      id: { type: String, default: null },
      email: { type: String, default: null },
      role: { type: String, default: null },
    },
  },
  { timestamps: true, collection: 'settings_versions' },
);

module.exports = mongoose.models.SettingsVersion || mongoose.model('SettingsVersion', SettingsVersionSchema);
