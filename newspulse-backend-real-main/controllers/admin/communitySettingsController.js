const { getCommunitySettings, updateCommunitySettings } = require('../../../services/communitySettingsService');

async function getAdminCommunitySettings(req, res) {
  try {
    const settings = await getCommunitySettings();
    res.json({ ok: true, settings });
  } catch (err) {
    console.error('getAdminCommunitySettings error', err);
    res.status(500).json({ ok: false, message: 'Failed to load settings' });
  }
}

async function patchAdminCommunitySettings(req, res) {
  try {
    const patch = req.body || {};
    const updated = await updateCommunitySettings(patch);
    res.json({ ok: true, settings: updated });
  } catch (err) {
    console.error('patchAdminCommunitySettings error', err);
    res.status(500).json({ ok: false, message: 'Failed to save settings' });
  }
}

module.exports = { getAdminCommunitySettings, patchAdminCommunitySettings };
