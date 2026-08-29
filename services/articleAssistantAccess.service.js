// Shared read-only helper for the News Pulse Article Assistant staff toggle.
// Single source of truth: SystemSetting key used by routes/adminSettings.routes.js.
const mongoose = require('mongoose');
const SystemSetting = require('../models/SystemSetting');

const ADMIN_SETTINGS_KEY = 'settings_center_admin';

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// Missing setting / DB unavailable => backward-compatible default (enabled).
async function isArticleAssistantEnabledForStaff() {
  if (!isDbReady()) return true;

  try {
    const doc = await SystemSetting.findOne({ key: ADMIN_SETTINGS_KEY }).lean();
    const adminPanel = doc && doc.value && typeof doc.value === 'object' ? doc.value.adminPanel : null;
    if (adminPanel && typeof adminPanel === 'object' && adminPanel.articleAssistantForStaff === false) {
      return false;
    }
    return true;
  } catch (_e) {
    return true;
  }
}

module.exports = { ADMIN_SETTINGS_KEY, isArticleAssistantEnabledForStaff };
