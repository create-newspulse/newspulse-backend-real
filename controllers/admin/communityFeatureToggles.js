const CommunityFeatureSettings = require('../../models/CommunityFeatureSettings');

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

// GET /api/admin/founder/feature-toggles
async function getCommunityFeatureToggles(req, res) {
  try {
    let doc = await CommunityFeatureSettings.findOne({ key: 'community' }).lean();

    // First time: create a default document
    if (!doc) {
      const created = await CommunityFeatureSettings.create({
        key: 'community',
        ...DEFAULT_SETTINGS,
      });
      doc = created.toObject();
    }

    return res.json({ ok: true, settings: toSettings(doc) });
  } catch (err) {
    console.error('getCommunityFeatureToggles error', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Failed to load feature toggles.' });
  }
}

// PATCH /api/admin/founder/feature-toggles
async function updateCommunityFeatureToggles(req, res) {
  try {
    // Only accept known boolean fields
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
    console.error('updateCommunityFeatureToggles error', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Failed to save feature toggles.' });
  }
}

module.exports = { getCommunityFeatureToggles, updateCommunityFeatureToggles };
