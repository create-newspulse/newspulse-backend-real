const CommunityFeatureSettings = require('../models/CommunityFeatureSettings');

const DEFAULT_SETTINGS = {
  communityReporterEnabled: true,
  reporterPortalEnabled: true,
  allowNewSubmissions: true,
  allowMyStoriesPortal: true,
  allowJournalistApplications: true,
  safeModeManualReviewOnly: false,
};

function toSettings(doc) {
  const s = doc || {};
  return {
    communityReporterEnabled: !!s.communityReporterEnabled,
    reporterPortalEnabled: !!s.reporterPortalEnabled,
    allowNewSubmissions: !!s.allowNewSubmissions,
    allowMyStoriesPortal: !!s.allowMyStoriesPortal,
    allowJournalistApplications: !!s.allowJournalistApplications,
    safeModeManualReviewOnly: !!s.safeModeManualReviewOnly,
  };
}

async function getFounderFeatureToggles(req, res) {
  try {
    let doc = await CommunityFeatureSettings.findOne({ key: 'community' }).lean();

    if (!doc) {
      const created = await CommunityFeatureSettings.create({ key: 'community', ...DEFAULT_SETTINGS });
      doc = created.toObject();
    }

    return res.json({ ok: true, settings: toSettings(doc) });
  } catch (err) {
    console.error('getFounderFeatureToggles error', err);
    return res.status(500).json({ ok: false, message: 'Failed to load feature toggles.' });
  }
}

async function updateFounderFeatureToggles(req, res) {
  try {
    const patch = {};
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (req.body && typeof req.body[key] === 'boolean') {
        patch[key] = req.body[key];
      }
    }

    const updated = await CommunityFeatureSettings.findOneAndUpdate(
      { key: 'community' },
      { $set: patch },
      { new: true, upsert: true }
    ).lean();

    return res.json({ ok: true, settings: toSettings(updated) });
  } catch (err) {
    console.error('updateFounderFeatureToggles error', err);
    return res.status(500).json({ ok: false, message: 'Failed to save feature toggles.' });
  }
}

// Export with both naming conventions for compatibility
async function getCommunityFeatureToggles(req, res) {
  return getFounderFeatureToggles(req, res);
}

async function updateCommunityFeatureToggles(req, res) {
  return updateFounderFeatureToggles(req, res);
}

module.exports = {
  getFounderFeatureToggles,
  updateFounderFeatureToggles,
  getCommunityFeatureToggles,
  updateCommunityFeatureToggles,
};
