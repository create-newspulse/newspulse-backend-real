// controllers/communitySettingsController.js

const CommunitySettings = require('../models/CommunitySettings');
const CommunityFeatureSettings = require('../models/CommunityFeatureSettings');

// Defaults if we don't yet have a CommunityFeatureSettings document
const DEFAULT_FEATURE_SETTINGS = {
  communityReporterEnabled: true,
  reporterPortalEnabled: true,
  allowNewSubmissions: true,
  allowMyStoriesPortal: true,
  allowJournalistApplications: true,
  safeModeManualReviewOnly: false,
};

// Map DB fields → public flags
// IMPORTANT: in the UI, ON = closed / hidden, OFF = open / visible.
function normaliseFeatureFlags(doc) {
  const s = doc || {};
  return {
    // When true → Community Reporter page is CLOSED / HIDDEN for public
    communityReporterClosed: !!s.communityReporterEnabled,
    // When true → Reporter Portal login/dashboard is CLOSED / HIDDEN
    reporterPortalClosed: !!s.reporterPortalEnabled,
  };
}

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
    // Public content: guidelines, notes, etc.  (don't auto-create here)
    const settingsDoc = await CommunitySettings.findOne().lean();

    // Feature toggles stored in separate collection
    let featureDoc = await CommunityFeatureSettings.findOne({ key: 'community' }).lean();
    if (!featureDoc) {
      featureDoc = DEFAULT_FEATURE_SETTINGS;
    }

    const featureToggles = normaliseFeatureFlags(featureDoc);

    return res.json({
      ok: true,
      settings: settingsDoc || {},
      featureToggles,
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
