const { logAudit } = require('../lib/audit');
const { readSettings } = require('../services/adSettingsStore');
const {
  AD_SLOT_MEDIA_KIT_METADATA,
  PACKAGE_AD_OPPORTUNITIES,
} = require('../src/constants/adSlots');
const { normalizeRole } = require('../lib/teamAccess');
const { FOUNDER_STAFF_ID } = require('../lib/staffId');

const OFFICIAL_FOUNDER_EMAIL = 'kiran@newspulse.co.in';
const DEFAULT_CONTACT_EMAIL = 'ads@newspulse.co.in';

function listIncludes(list, value) {
  if (!Array.isArray(list)) return false;
  return list.map((item) => String(item || '').trim()).includes(value);
}

function hasMediaKitRight(admin, right) {
  return listIncludes(admin?.specialRights, right)
    || listIncludes(admin?.permissions, right);
}

function isFounderAdmin(admin) {
  const role = normalizeRole(admin?.role);
  const email = String(admin?.email || '').trim().toLowerCase();
  const staffId = String(admin?.staffId || '').trim().toUpperCase();
  return Boolean(admin?.isFounder)
    || role === 'founder'
    || email === OFFICIAL_FOUNDER_EMAIL
    || staffId === FOUNDER_STAFF_ID;
}

function canViewMediaKit(admin) {
  const role = normalizeRole(admin?.role);
  if (isFounderAdmin(admin)) return true;
  if (role === 'ads & revenue growth manager') return true;
  return hasMediaKitRight(admin, 'media_kit_view')
    || hasMediaKitRight(admin, 'media_kit_manage');
}

async function auditMediaKit(req, action, result, reason = null) {
  await logAudit(req, action, null, {
    module: 'media_kit',
    targetType: 'media_kit',
    result,
    ...(reason ? { reason } : {}),
  });
}

function buildPlacements(slotEnabled) {
  if (!slotEnabled || typeof slotEnabled !== 'object' || Array.isArray(slotEnabled)) return [];
  return Object.entries(slotEnabled)
    .filter(([, enabled]) => enabled === true)
    .map(([slot]) => {
      const metadata = AD_SLOT_MEDIA_KIT_METADATA[slot] || {};
      return {
        slot,
        enabled: true,
        displayName: metadata.displayName || slot,
        ...(metadata.dimensions ? { dimensions: metadata.dimensions } : {}),
        ...(metadata.rateCard ? { rateCard: metadata.rateCard } : {}),
      };
    });
}

function buildPackages() {
  return PACKAGE_AD_OPPORTUNITIES.map((key) => ({ key }));
}

async function getAdminMediaKit(req, res) {
  try {
    if (!canViewMediaKit(req.admin)) {
      await auditMediaKit(req, 'media_kit_access_denied', 'blocked', 'missing_media_kit_permission');
      return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
    }

    let slotEnabled = null;
    try {
      slotEnabled = await readSettings();
    } catch (_) {
      slotEnabled = null;
    }

    const data = {
      title: 'News Pulse Media Kit',
      status: 'internal',
      confidential: true,
      contactEmail: String(process.env.MEDIA_KIT_CONTACT_EMAIL || process.env.ADS_CONTACT_EMAIL || DEFAULT_CONTACT_EMAIL).trim() || DEFAULT_CONTACT_EMAIL,
      sections: [],
      placements: buildPlacements(slotEnabled),
      packages: buildPackages(),
      metrics: {
        status: 'Analytics not connected',
        items: [],
      },
      updatedAt: new Date().toISOString(),
    };

    await auditMediaKit(req, 'media_kit_viewed', 'success');
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error?.message || 'Failed to load media kit' });
  }
}

module.exports = {
  canViewMediaKit,
  getAdminMediaKit,
};