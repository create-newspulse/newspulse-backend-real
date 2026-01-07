const PublicSiteSettings = require('../models/PublicSiteSettings');

/**
 * Get both draft and published settings
 * GET /api/admin/settings/public
 */
async function getPublicSettings(req, res) {
  try {
    const settings = await PublicSiteSettings.getOrCreate();
    const draft = settings.draft || PublicSiteSettings.getDefaultSettings();
    const published = settings.published || PublicSiteSettings.getDefaultSettings();

    return res.status(200).json({
      ok: true,
      draft,
      published,
    });
  } catch (error) {
    console.error('[getPublicSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch public settings',
      error: error.message,
    });
  }
}

/**
 * Get draft settings only
 * GET /api/admin/settings/public/draft
 */
async function getDraftSettings(req, res) {
  try {
    const settings = await PublicSiteSettings.getOrCreate();
    const draft = settings.draft || PublicSiteSettings.getDefaultSettings();

    return res.status(200).json({
      ok: true,
      draft,
    });
  } catch (error) {
    console.error('[getDraftSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch draft settings',
      error: error.message,
    });
  }
}

/**
 * Update draft settings
 * PUT /api/admin/settings/public/draft
 */
async function updateDraftSettings(req, res) {
  try {
    const draftData = req.body;

    if (!draftData || typeof draftData !== 'object') {
      return res.status(400).json({
        ok: false,
        message: 'Invalid draft data: expected an object',
      });
    }

    const settings = await PublicSiteSettings.getOrCreate();
    settings.draft = draftData;
    await settings.save();

    return res.status(200).json({
      ok: true,
      draft: settings.draft,
      message: 'Draft settings saved successfully',
    });
  } catch (error) {
    console.error('[updateDraftSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to update draft settings',
      error: error.message,
    });
  }
}

/**
 * Publish draft settings (copy draft to published)
 * POST /api/admin/settings/public/publish
 */
async function publishSettings(req, res) {
  try {
    const settings = await PublicSiteSettings.getOrCreate();

    // If no draft exists, publish current published or defaults
    if (!settings.draft || Object.keys(settings.draft).length === 0) {
      const currentPublished = settings.published || PublicSiteSettings.getDefaultSettings();
      settings.published = currentPublished;
    } else {
      // Copy draft to published
      settings.published = JSON.parse(JSON.stringify(settings.draft));
    }

    await settings.save();

    return res.status(200).json({
      ok: true,
      published: settings.published,
      message: 'Settings published successfully',
    });
  } catch (error) {
    console.error('[publishSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to publish settings',
      error: error.message,
    });
  }
}

/**
 * Get published settings (public endpoint, no auth)
 * GET /api/public/settings
 */
async function getPublishedSettings(req, res) {
  try {
    const settings = await PublicSiteSettings.getOrCreate();
    const published = settings.published || PublicSiteSettings.getDefaultSettings();

    return res.status(200).json({
      ok: true,
      published,
    });
  } catch (error) {
    console.error('[getPublishedSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch published settings',
      error: error.message,
    });
  }
}

module.exports = {
  getPublicSettings,
  getDraftSettings,
  updateDraftSettings,
  publishSettings,
  getPublishedSettings,
};
