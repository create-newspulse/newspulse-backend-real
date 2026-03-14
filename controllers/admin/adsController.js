const mongoose = require('mongoose');

const Ad = require('../../models/Ad');
const {
  AD_SLOTS,
  normalizeSlot,
  isValidObjectId,
  validateImageUrl,
  validateTargetUrl,
  validateOptionalTargetUrl,
  parseOptionalDate,
  parseOptionalNumber,
} = require('../../lib/ads');

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function toAdminAdDto(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    slot: doc.slot,
    title: doc.title || '',
    imageUrl: doc.imageUrl,
    isClickable: doc.isClickable !== false,
    targetUrl: doc.targetUrl,
    isActive: !!doc.isActive,
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    priority: typeof doc.priority === 'number' ? doc.priority : 0,
    createdBy: doc.createdBy || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    stats: {
      impressions: doc.stats && typeof doc.stats.impressions === 'number' ? doc.stats.impressions : 0,
      clicks: doc.stats && typeof doc.stats.clicks === 'number' ? doc.stats.clicks : 0,
    },
  };
}

function buildAdPayload(body) {
  const b = body && typeof body === 'object' ? body : {};

  const slot = normalizeSlot(b.slot);
  if (!slot) return { ok: false, status: 400, message: `slot must be one of: ${AD_SLOTS.join(', ')}` };

  const title = b.title != null ? String(b.title || '').trim() : '';

  const image = validateImageUrl(b.imageUrl);
  if (!image.ok) return { ok: false, status: 400, message: image.message };

  const targetUrlRaw = b.targetUrl;
  const targetUrlTrimmed = String(targetUrlRaw || '').trim();
  // If the client doesn't explicitly control clickability, infer it from targetUrl.
  const isClickable = typeof b.isClickable === 'boolean' ? b.isClickable : !!targetUrlTrimmed;

  const target = isClickable ? validateTargetUrl(targetUrlRaw) : validateOptionalTargetUrl(targetUrlRaw);
  if (!target.ok) return { ok: false, status: 400, message: target.message };

  const startAt = parseOptionalDate(b.startAt, 'startAt');
  if (!startAt.ok) return { ok: false, status: 400, message: startAt.message };

  const endAt = parseOptionalDate(b.endAt, 'endAt');
  if (!endAt.ok) return { ok: false, status: 400, message: endAt.message };

  if (startAt.value && endAt.value && endAt.value.getTime() < startAt.value.getTime()) {
    return { ok: false, status: 400, message: 'endAt must be greater than or equal to startAt' };
  }

  const priority = parseOptionalNumber(b.priority, 'priority');
  if (!priority.ok) return { ok: false, status: 400, message: priority.message };

  // Only allow boolean if explicitly provided
  const isActive = typeof b.isActive === 'boolean' ? b.isActive : undefined;

  return {
    ok: true,
    value: {
      slot,
      title,
      imageUrl: image.value,
      isClickable,
      targetUrl: target.value,
      ...(isActive !== undefined ? { isActive } : {}),
      ...(startAt.value !== null ? { startAt: startAt.value } : { startAt: null }),
      ...(endAt.value !== null ? { endAt: endAt.value } : { endAt: null }),
      ...(priority.value !== undefined ? { priority: priority.value } : {}),
    },
  };
}

// GET /api/admin/ads?slot=HOME_728x90
async function listAds(req, res) {
  const slotRaw = req.query && req.query.slot ? String(req.query.slot) : '';
  const slot = slotRaw ? normalizeSlot(slotRaw) : null;
  const activeOnly = String(req.query && req.query.activeOnly || '').trim();

  if (!isDbReady()) {
    return res.status(503).json({ ok: false, message: 'Database unavailable' });
  }

  if (slotRaw && !slot) {
    return res.status(400).json({
      ok: false,
      message: `Invalid slot. Expected one of: ${AD_SLOTS.join(', ')}`,
    });
  }

  const filter = {};
  if (slot) filter.slot = slot;
  if (activeOnly === '1' || activeOnly.toLowerCase() === 'true') filter.isActive = true;

  const docs = await Ad.find(filter).sort({ updatedAt: -1 }).lean();
  return res.status(200).json({ ok: true, ads: docs.map(toAdminAdDto) });
}

// POST /api/admin/ads
async function createAd(req, res) {
  if (!isDbReady()) {
    return res.status(503).json({ ok: false, message: 'Database unavailable' });
  }

  const payload = buildAdPayload(req.body);
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  const createdBy = (req.admin && (req.admin.email || req.admin.id)) ? String(req.admin.email || req.admin.id) : null;

  const created = await Ad.create({
    ...payload.value,
    createdBy,
    stats: { impressions: 0, clicks: 0 },
  });

  return res.status(201).json({ ok: true, ad: toAdminAdDto(created) });
}

// PUT /api/admin/ads/:id
async function updateAd(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const payload = buildAdPayload(req.body);
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  // Never allow stats overwrite via PUT
  delete payload.value.stats;

  const updated = await Ad.findByIdAndUpdate(id, { $set: payload.value }, { new: true });
  if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

  return res.status(200).json({ ok: true, ad: toAdminAdDto(updated) });
}

// PATCH /api/admin/ads/:id/toggle  body optional: { isActive: true|false }
async function toggleAd(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const explicit = typeof body.isActive === 'boolean' ? body.isActive : null;

  const doc = await Ad.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  doc.isActive = explicit === null ? !doc.isActive : explicit;
  await doc.save();

  return res.status(200).json({ ok: true, ad: toAdminAdDto(doc) });
}

// DELETE /api/admin/ads/:id
async function deleteAd(req, res) {
  const { id } = req.params;
  if (!isValidObjectId(id)) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const deleted = await Ad.findByIdAndDelete(id);
  if (!deleted) return res.status(404).json({ ok: false, message: 'Not found' });

  return res.status(200).json({ ok: true });
}

module.exports = {
  listAds,
  createAd,
  updateAd,
  toggleAd,
  deleteAd,
};
