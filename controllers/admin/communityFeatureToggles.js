// controllers/admin/communityFeatureToggles.js
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

// ---------- FOUNDER / ADMIN ENDPOINTS ----------

// GET /api/admin/founder/feature-toggles
async function getCommunityFeatureToggles(req, res) {
  try {
    let doc = await CommunityFeatureSettings.findOne({ key: 'community' }).lean();

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

// ---------- PUBLIC ENDPOINT ----------

// GET /api/public/feature-toggles
// Used by Next.js: /api/public/feature-toggles.ts
async function getPublicCommunityFeatureToggles(req, res) {
  try {
    let doc = await CommunityFeatureSettings.findOne({ key: 'community' }).lean();

    if (!doc) {
      const created = await CommunityFeatureSettings.create({
        key: 'community',
        ...DEFAULT_SETTINGS,
      });
      doc = created.toObject();
    }

    // Only expose the safe public fields
    const settings = toSettings(doc);

    return res.json({
      ok: true,
      communityReporterEnabled: settings.communityReporterEnabled,
      reporterPortalEnabled: settings.reporterPortalEnabled,
    });
  } catch (err) {
    console.error('getPublicCommunityFeatureToggles error', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Failed to load public feature toggles.' });
  }
}

module.exports = {
  getCommunityFeatureToggles,
  updateCommunityFeatureToggles,
  getPublicCommunityFeatureToggles,
};
