// routes/communityReporterSettings.js
const express = require('express');
const router = express.Router();

const CommunityReporterSettings = require('../models/CommunityReporterSettings');
const { requireAdminAuth } = require('../middleware/adminAuth');

// GET  /api/admin/settings/community-reporter
router.get(
  '/settings/community-reporter',
  requireAdminAuth,
  async (req, res) => {
    try {
      let doc = await CommunityReporterSettings.findOne();
      if (!doc) {
        doc = await CommunityReporterSettings.create({});
      }

      return res.json({
        success: true,
        settings: {
          myCommunityStoriesEnabled: !!doc.myCommunityStoriesEnabled,
        },
      });
    } catch (err) {
      console.error('GET community-reporter settings error', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to load settings',
      });
    }
  }
);

// POST  /api/admin/settings/community-reporter
router.post(
  '/settings/community-reporter',
  requireAdminAuth,
  async (req, res) => {
    try {
      const { myCommunityStoriesEnabled } = req.body || {};
      if (typeof myCommunityStoriesEnabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'Invalid payload: myCommunityStoriesEnabled must be a boolean',
        });
      }

      let doc = await CommunityReporterSettings.findOne();
      if (!doc) {
        doc = new CommunityReporterSettings({ myCommunityStoriesEnabled });
      } else {
        doc.myCommunityStoriesEnabled = myCommunityStoriesEnabled;
      }
      await doc.save();

      return res.json({
        success: true,
        settings: {
          myCommunityStoriesEnabled: !!doc.myCommunityStoriesEnabled,
        },
      });
    } catch (err) {
      console.error('POST community-reporter settings error', err);
      return res.status(500).json({
        success: false,
        message: 'Failed to save settings',
      });
    }
  }
);

module.exports = router;
