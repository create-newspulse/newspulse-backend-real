// controllers/admin/communityFeatureToggles.js
const {
  getEffectiveCommunityAccessState,
  getFounderToggleDoc,
  updateFounderToggles,
} = require('../../services/communityAccessToggleService');

function toAdminResponse(doc) {
  const s = doc || {};
  return {
    communityReporterClosed: !!s.communityReporterClosed,
    reporterPortalClosed: !!s.reporterPortalClosed,
    communityReporterEnabled: s.communityReporterEnabled !== false,
    reporterPortalEnabled: s.reporterPortalEnabled !== false,
    updatedAt: s.updatedAt || null,
  };
}

function toPublicResponse(doc) {
  const s = doc || {};
  return {
    communityReporterClosed: !!s.communityReporterClosed,
    reporterPortalClosed: !!s.reporterPortalClosed,
    communityReporterEnabled: s.communityReporterEnabled !== false,
    reporterPortalEnabled: s.reporterPortalEnabled !== false,
    updatedAt: s.updatedAt || null,
  };
}

// ---------- ADMIN ENDPOINTS ----------

// GET /api/admin/feature-toggles
async function getCommunityFeatureToggles(req, res) {
  try {
    await getFounderToggleDoc({ createIfMissing: true });
    const state = await getEffectiveCommunityAccessState();
    return res.json({ ok: true, settings: toAdminResponse(state) });
  } catch (err) {
    console.error('getCommunityFeatureToggles error', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Failed to load feature toggles.' });
  }
}

// PATCH /api/admin/feature-toggles
async function updateCommunityFeatureToggles(req, res) {
  try {
    const patch = {
      communityReporterClosed: req.body && req.body.communityReporterClosed,
      reporterPortalClosed: req.body && req.body.reporterPortalClosed,
    };

    await updateFounderToggles(patch);
    const state = await getEffectiveCommunityAccessState();

    console.log('[feature-toggles] updated', patch);
    return res.json({ ok: true, settings: toAdminResponse(state) });
  } catch (err) {
    console.error('updateCommunityFeatureToggles error', err);
    return res
      .status(500)
      .json({ ok: false, message: 'Failed to save feature toggles.' });
  }
}

// ---------- PUBLIC ENDPOINT ----------

// GET /api/public/feature-toggles
async function getPublicCommunityFeatureToggles(req, res) {
  try {
    const state = await getEffectiveCommunityAccessState();
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, settings: toPublicResponse(state) });
  } catch (err) {
    console.error('getPublicCommunityFeatureToggles error', err);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      ok: true,
      settings: toPublicResponse({
        communityReporterClosed: false,
        reporterPortalClosed: false,
        communityReporterEnabled: true,
        reporterPortalEnabled: true,
      }),
    });
  }
}

module.exports = {
  getCommunityFeatureToggles,
  updateCommunityFeatureToggles,
  getPublicCommunityFeatureToggles,
};
