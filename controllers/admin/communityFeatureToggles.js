// controllers/admin/communityFeatureToggles.js
const FeatureToggles = require('../../models/FeatureToggles');

const DEFAULT_TOGGLES = {
  communityReporterClosed: false,
  reporterPortalClosed: false,
};

function toAdminResponse(doc) {
  const s = doc || {};
  return {
    communityReporterClosed: !!s.communityReporterClosed,
    reporterPortalClosed: !!s.reporterPortalClosed,
    updatedAt: s.updatedAt || null,
  };
}

function toPublicResponse(doc) {
  const s = doc || {};
  return {
    communityReporterClosed: !!s.communityReporterClosed,
    reporterPortalClosed: !!s.reporterPortalClosed,
    updatedAt: s.updatedAt || null,
  };
}

// ---------- ADMIN ENDPOINTS ----------

// GET /api/admin/feature-toggles
async function getCommunityFeatureToggles(req, res) {
  try {
    let doc = await FeatureToggles.findOne({}).lean();
    if (!doc) {
      const created = await FeatureToggles.create({ ...DEFAULT_TOGGLES });
      doc = created.toObject();
    }
    return res.json({ ok: true, settings: toAdminResponse(doc) });
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
    const patch = {};
    for (const key of Object.keys(DEFAULT_TOGGLES)) {
      if (req.body && typeof req.body[key] === 'boolean') {
        patch[key] = req.body[key];
      }
    }

    const updatedDoc = await FeatureToggles.findOneAndUpdate(
      {},
      { $set: patch },
      { new: true, upsert: true }
    ).lean();

    console.log('[feature-toggles] updated', patch);
    return res.json({ ok: true, settings: toAdminResponse(updatedDoc) });
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
    let doc = await FeatureToggles.findOne({}).lean();
    if (!doc) {
      doc = { ...DEFAULT_TOGGLES };
    }
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, settings: toPublicResponse(doc) });
  } catch (err) {
    console.error('getPublicCommunityFeatureToggles error', err);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, settings: toPublicResponse(DEFAULT_TOGGLES) });
  }
}

module.exports = {
  getCommunityFeatureToggles,
  updateCommunityFeatureToggles,
  getPublicCommunityFeatureToggles,
};
