const mongoose = require('mongoose');

const SponsoredFeature = require('../../models/SponsoredFeature');
const News = require('../../models/News');
const Article = require('../../models/Article');
const { bumpPublicConfigVersion } = require('../../services/publicConfigVersion.service');
const {
  SPONSORED_FEATURE_PLACEMENT_KEYS,
  normalizePlacementKey,
  normalizeOptionalString,
  normalizeOptionalBoolean,
  parseOptionalDate,
  parseOptionalNumber,
  validateOptionalUrlLike,
  normalizeCoverImageInput,
} = require('../../lib/sponsoredFeatures');
const {
  findLinkedArticleByAnyId,
  buildLinkedArticleDto,
} = require('../../services/sponsoredFeatures.service');

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function syncLinkedArticleFeatureReference({ featureId, prevLinkedArticleId, nextLinkedArticleId }) {
  const oldId = String(prevLinkedArticleId || '').trim();
  const newId = String(nextLinkedArticleId || '').trim();

  try {
    if (oldId && oldId !== newId) {
      await Promise.all([
        News.updateMany({ _id: oldId, sponsorFeatureLinkedId: featureId }, { $set: { sponsorFeatureLinkedId: null } }),
        Article.updateMany(
          {
            $or: [{ _id: oldId }, { sourceNewsId: oldId }],
            sponsorFeatureLinkedId: featureId,
          },
          { $set: { sponsorFeatureLinkedId: null } }
        ),
      ]);
    }

    if (newId) {
      await Promise.all([
        News.updateMany({ _id: newId }, { $set: { sponsorFeatureLinkedId: featureId } }),
        Article.updateMany({ $or: [{ _id: newId }, { sourceNewsId: newId }] }, { $set: { sponsorFeatureLinkedId: featureId } }),
      ]);
    }
  } catch (_) {
    // Best-effort only. Sponsored Feature should not fail because of back-reference sync.
  }
}

function toAdminSponsoredFeatureDto(doc, linkedArticle) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    sponsorName: doc.sponsorName || null,
    internalTitle: doc.internalTitle || null,
    headline: doc.headline || null,
    summary: doc.summary || null,
    ctaText: doc.ctaText || null,
    destinationUrl: doc.destinationUrl || null,
    coverImage: doc.coverImage || null,
    isActive: doc.isActive === true,
    startAt: doc.startAt || null,
    endAt: doc.endAt || null,
    placementKey: doc.placementKey || null,
    labelText: doc.labelText || 'Sponsored Feature',
    linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
    linkedArticleUrl: doc.linkedArticleUrl || null,
    priority: typeof doc.priority === 'number' ? doc.priority : 0,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
    linkedArticle: linkedArticle ? buildLinkedArticleDto(linkedArticle) : null,
  };
}

async function buildPayload(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const placementKey = b.placementKey === undefined ? undefined : normalizePlacementKey(b.placementKey);
  const sponsorName = normalizeOptionalString(b.sponsorName);
  const internalTitle = normalizeOptionalString(b.internalTitle);
  const headline = normalizeOptionalString(b.headline);
  const summary = normalizeOptionalString(b.summary);
  const ctaText = normalizeOptionalString(b.ctaText);
  const isActive = normalizeOptionalBoolean(b.isActive);
  const labelText = normalizeOptionalString(b.labelText);
  const linkedArticleIdRaw = normalizeOptionalString(b.linkedArticleId);
  const linkedArticleId = linkedArticleIdRaw && mongoose.Types.ObjectId.isValid(linkedArticleIdRaw)
    ? linkedArticleIdRaw
    : (linkedArticleIdRaw ? undefined : (b.linkedArticleId === undefined ? undefined : null));

  if (b.placementKey !== undefined && !placementKey) {
    return { ok: false, status: 400, message: `placementKey must be one of: ${SPONSORED_FEATURE_PLACEMENT_KEYS.join(', ')}` };
  }
  if (b.isActive !== undefined && isActive === undefined) {
    return { ok: false, status: 400, message: 'isActive must be a boolean' };
  }
  if (b.linkedArticleId !== undefined && linkedArticleId === undefined) {
    return { ok: false, status: 400, message: 'linkedArticleId must be a valid id' };
  }

  const destinationUrl = validateOptionalUrlLike(b.destinationUrl, 'destinationUrl');
  if (!destinationUrl.ok) return { ok: false, status: 400, message: destinationUrl.message };

  const linkedArticleUrl = validateOptionalUrlLike(b.linkedArticleUrl, 'linkedArticleUrl');
  if (!linkedArticleUrl.ok) return { ok: false, status: 400, message: linkedArticleUrl.message };

  const coverImage = normalizeCoverImageInput(b.coverImage);
  if (!coverImage.ok) return { ok: false, status: 400, message: coverImage.message };

  const startAt = parseOptionalDate(b.startAt, 'startAt');
  if (!startAt.ok) return { ok: false, status: 400, message: startAt.message };

  const endAt = parseOptionalDate(b.endAt, 'endAt');
  if (!endAt.ok) return { ok: false, status: 400, message: endAt.message };

  if (startAt.value && endAt.value && endAt.value.getTime() < startAt.value.getTime()) {
    return { ok: false, status: 400, message: 'endAt must be greater than or equal to startAt' };
  }

  const priority = parseOptionalNumber(b.priority, 'priority', partial ? undefined : 0);
  if (!priority.ok) return { ok: false, status: 400, message: priority.message };

  if (!partial) {
    for (const [field, value] of Object.entries({ sponsorName, internalTitle, headline, summary, ctaText })) {
      if (!value) return { ok: false, status: 400, message: `${field} is required` };
    }
    if (!placementKey) return { ok: false, status: 400, message: 'placementKey is required' };
    if (!coverImage.value || !coverImage.value.url) return { ok: false, status: 400, message: 'coverImage is required' };
    if (!destinationUrl.value && !linkedArticleId && !linkedArticleUrl.value) {
      return { ok: false, status: 400, message: 'destinationUrl or linkedArticleId or linkedArticleUrl is required' };
    }
  }

  let linkedArticle = null;
  if (linkedArticleId) {
    linkedArticle = await findLinkedArticleByAnyId(linkedArticleId, { publicOnly: true });
    if (!linkedArticle) {
      return { ok: false, status: 400, message: 'linkedArticleId must reference a published public article' };
    }
  }

  return {
    ok: true,
    value: {
      ...(placementKey !== undefined ? { placementKey } : {}),
      ...(sponsorName !== undefined ? { sponsorName } : {}),
      ...(internalTitle !== undefined ? { internalTitle } : {}),
      ...(headline !== undefined ? { headline } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(ctaText !== undefined ? { ctaText } : {}),
      ...(destinationUrl.value !== undefined ? { destinationUrl: destinationUrl.value } : {}),
      ...(coverImage.value !== undefined ? { coverImage: coverImage.value } : {}),
      ...(isActive !== undefined ? { isActive: Boolean(isActive) } : {}),
      ...(startAt.value !== undefined ? { startAt: startAt.value } : {}),
      ...(endAt.value !== undefined ? { endAt: endAt.value } : {}),
      ...(labelText !== undefined ? { labelText: labelText || 'Sponsored Feature' } : (!partial ? { labelText: 'Sponsored Feature' } : {})),
      ...(linkedArticleId !== undefined ? { linkedArticleId } : {}),
      ...(linkedArticleUrl.value !== undefined ? { linkedArticleUrl: linkedArticleUrl.value } : {}),
      ...(priority.value !== undefined ? { priority: priority.value === null ? 0 : priority.value } : {}),
    },
    linkedArticle,
  };
}

async function listSponsoredFeatures(req, res) {
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const placementRaw = req.query && req.query.placementKey ? String(req.query.placementKey) : '';
  const placementKey = placementRaw ? normalizePlacementKey(placementRaw) : null;
  if (placementRaw && !placementKey) {
    return res.status(400).json({ ok: false, message: `Invalid placementKey. Expected one of: ${SPONSORED_FEATURE_PLACEMENT_KEYS.join(', ')}` });
  }

  const activeOnly = String(req.query && req.query.activeOnly || '').trim().toLowerCase();
  const filter = {};
  if (placementKey) filter.placementKey = placementKey;
  if (activeOnly === '1' || activeOnly === 'true') filter.isActive = true;

  const docs = await SponsoredFeature.find(filter).sort({ updatedAt: -1 }).lean();
  const items = await Promise.all((docs || []).map(async (doc) => {
    const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
    return toAdminSponsoredFeatureDto(doc, linkedArticle);
  }));

  return res.status(200).json({ ok: true, items });
}

async function createSponsoredFeature(req, res) {
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const payload = await buildPayload(req.body, { partial: false });
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  const created = await SponsoredFeature.create(payload.value);
  await syncLinkedArticleFeatureReference({ featureId: created._id, prevLinkedArticleId: null, nextLinkedArticleId: created.linkedArticleId });
  bumpPublicConfigVersion().catch(() => {});

  return res.status(201).json({ ok: true, feature: toAdminSponsoredFeatureDto(created, payload.linkedArticle) });
}

async function updateSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const existing = await SponsoredFeature.findById(id).lean();
  if (!existing) return res.status(404).json({ ok: false, message: 'Not found' });

  const payload = await buildPayload(req.body, { partial: true });
  if (!payload.ok) return res.status(payload.status).json({ ok: false, message: payload.message });

  const updated = await SponsoredFeature.findByIdAndUpdate(id, { $set: payload.value }, { new: true, runValidators: true });
  if (!updated) return res.status(404).json({ ok: false, message: 'Not found' });

  await syncLinkedArticleFeatureReference({
    featureId: updated._id,
    prevLinkedArticleId: existing.linkedArticleId,
    nextLinkedArticleId: updated.linkedArticleId,
  });
  bumpPublicConfigVersion().catch(() => {});

  const linkedArticle = updated.linkedArticleId ? await findLinkedArticleByAnyId(updated.linkedArticleId, { publicOnly: false }) : null;
  return res.status(200).json({ ok: true, feature: toAdminSponsoredFeatureDto(updated, linkedArticle) });
}

async function toggleSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const doc = await SponsoredFeature.findById(id);
  if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });

  const explicit = normalizeOptionalBoolean(req.body && req.body.isActive);
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'isActive') && explicit === undefined) {
    return res.status(400).json({ ok: false, message: 'isActive must be a boolean' });
  }

  doc.isActive = explicit === null || explicit === undefined ? !doc.isActive : explicit;
  await doc.save();
  bumpPublicConfigVersion().catch(() => {});

  const linkedArticle = doc.linkedArticleId ? await findLinkedArticleByAnyId(doc.linkedArticleId, { publicOnly: false }) : null;
  return res.status(200).json({ ok: true, feature: toAdminSponsoredFeatureDto(doc, linkedArticle) });
}

async function deleteSponsoredFeature(req, res) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || '').trim())) return res.status(400).json({ ok: false, message: 'Invalid id' });
  if (!isDbReady()) return res.status(503).json({ ok: false, message: 'Database unavailable' });

  const existing = await SponsoredFeature.findByIdAndDelete(id).lean();
  if (!existing) return res.status(404).json({ ok: false, message: 'Not found' });

  await syncLinkedArticleFeatureReference({ featureId: id, prevLinkedArticleId: existing.linkedArticleId, nextLinkedArticleId: null });
  bumpPublicConfigVersion().catch(() => {});

  return res.status(200).json({ ok: true, deleted: true });
}

module.exports = {
  listSponsoredFeatures,
  createSponsoredFeature,
  updateSponsoredFeature,
  toggleSponsoredFeature,
  deleteSponsoredFeature,
};