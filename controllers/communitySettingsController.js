// controllers/communitySettingsController.js

const CommunitySettings = require('../models/CommunitySettings');

// Make sure there is always exactly ONE settings document
async function getOrCreateSettings() {
  let doc = await CommunitySettings.findOne();
  if (!doc) {
    doc = await CommunitySettings.create({});
  }
  return doc;
}

// GET /api/admin/community/settings
async function getAdminCommunitySettings(req, res, next) {
  try {
    const settings = await getOrCreateSettings();

    res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Community settings fetched',
      data: {
        portalOpen: settings.portalOpen,
        acceptCommunityStories: settings.acceptCommunityStories,
        allowAnonymousTips: settings.allowAnonymousTips,
        allowUnder18Stories: settings.allowUnder18Stories,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/community/settings
async function patchAdminCommunitySettings(req, res, next) {
  try {
    const settings = await getOrCreateSettings();

    const {
      portalOpen,
      acceptCommunityStories,
      allowAnonymousTips,
      allowUnder18Stories,
    } = req.body || {};

    if (typeof portalOpen === 'boolean') {
      settings.portalOpen = portalOpen;
    }
    if (typeof acceptCommunityStories === 'boolean') {
      settings.acceptCommunityStories = acceptCommunityStories;
    }
    if (typeof allowAnonymousTips === 'boolean') {
      settings.allowAnonymousTips = allowAnonymousTips;
    }
    if (typeof allowUnder18Stories === 'boolean') {
      settings.allowUnder18Stories = allowUnder18Stories;
    }

    await settings.save();

    res.json({
      ok: true,
      success: true,
      status: 200,
      message: 'Community settings updated',
      data: {
        portalOpen: settings.portalOpen,
        acceptCommunityStories: settings.acceptCommunityStories,
        allowAnonymousTips: settings.allowAnonymousTips,
        allowUnder18Stories: settings.allowUnder18Stories,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAdminCommunitySettings,
  patchAdminCommunitySettings,
};
