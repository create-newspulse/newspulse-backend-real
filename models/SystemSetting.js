const mongoose = require('mongoose');

const SystemSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedBy: {
      id: { type: String, default: null },
      email: { type: String, default: null },
      role: { type: String, default: null },
    },
  },
  { timestamps: true, collection: 'system_settings' },
);

module.exports = mongoose.models.SystemSetting || mongoose.model('SystemSetting', SystemSettingSchema);
