const express = require('express');
const SiteSettings = require('../models/SiteSettings');

const router = express.Router();

// ✅ PUBLIC settings for frontend
router.get('/public', async (req, res) => {
  try {
    let settings = await SiteSettings.findOne();

    // if no settings exist, auto-create defaults
    if (!settings) {
      settings = await SiteSettings.create({});
    }

    return res.json({
      success: true,
      data: {
        brandName: settings.brandName,
        liveTvEnabled: settings.liveTvEnabled,
        liveTvUrl: settings.liveTvUrl,
        defaultLanguage: settings.defaultLanguage,
        maintenanceMode: settings.maintenanceMode,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
