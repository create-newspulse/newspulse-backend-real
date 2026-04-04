// controllers/communitySettingsController.js

const CommunitySettings = require('../models/CommunitySettings');
const { getEffectiveCommunityAccessState } = require('../services/communityAccessToggleService');

// Defaults if we don't yet have a CommunityFeatureSettings document
// Make sure there is always exactly ONE settings document
async function getOrCreateSettings() {
  let doc = await CommunitySettings.findOne();
  if (!doc) {
    doc = await CommunitySettings.create({});
  }
  return doc;
}

/**
 * ADMIN ENDPOINTS
 * ----------------
 * GET  /api/admin/community/settings
 * PATCH /api/admin/community/settings
 */

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

/**
 * PUBLIC ENDPOINT
 * ---------------
 * GET /api/public/community/settings
 *
 * Returns:
 * {
 *   ok: true,
 *   settings: { ...community text / config... },
 *   featureToggles: {
 *     communityReporterClosed: boolean,
 *     reporterPortalClosed: boolean
 *   }
 * }
 */
async function getPublicCommunitySettings(req, res) {
  try {
    const settingsDoc = await CommunitySettings.findOne().lean();
    const state = await getEffectiveCommunityAccessState();
    const settings = {
      ...(settingsDoc || {}),
      communityReporterEnabled: state.communityReporterEnabled,
      reporterPortalEnabled: state.reporterPortalEnabled,
      allowNewSubmissions: state.allowNewSubmissions,
      allowMyStoriesPortal: state.allowMyStoriesPortal,
      allowJournalistApplications: state.allowJournalistApplications,
      safeModeManualReviewOnly: state.safeModeManualReviewOnly,
      communityReporterClosed: state.communityReporterClosed,
      reporterPortalClosed: state.reporterPortalClosed,
      communityMyStoriesEnabled: state.communityMyStoriesEnabled,
    };

    return res.json({
      ok: true,
      settings,
      featureToggles: {
        communityReporterClosed: state.communityReporterClosed,
        reporterPortalClosed: state.reporterPortalClosed,
      },
    });
  } catch (err) {
    console.error('getPublicCommunitySettings error', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Could not load community settings.' });
  }
}

module.exports = {
  getAdminCommunitySettings,
  patchAdminCommunitySettings,
  getPublicCommunitySettings,
};
