const express = require('express');
const mongoose = require('mongoose');

const Contributor = require('../models/Contributor');
const publicCache = require('../lib/cache');
const { normalizeContributorSlug, normalizeContributorSlugHistory } = require('../lib/contributorSlugHistory');
const { contributorSlugCapabilities, initializeLegacyContributorHistory } = require('../lib/contributorSlugReadiness');
const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  buildPublicContributor,
  createWithUniqueDialogueSlug,
  normalizeContributorPayload,
} = require('../services/pulseDialogue.service');

const router = express.Router();

function parseLimit(value) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(n)) return 20;
  return Math.min(Math.max(n, 1), 100);
}

function parsePage(value) {
  const n = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(n)) return 1;
  return Math.max(n, 1);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toAdminContributorDto(doc) {
  if (!doc) return null;
  const source = typeof doc.toObject === 'function' ? doc.toObject({ virtuals: true }) : doc;
  return {
    id: source._id ? String(source._id) : (source.id ? String(source.id) : null),
    _id: source._id,
    canonicalName: source.canonicalName || null,
    displayNameHi: source.displayNameHi || null,
    displayNameGu: source.displayNameGu || null,
    photo: source.photo || null,
    publicDesignation: source.publicDesignation || null,
    contributorType: source.contributorType || null,
    affiliation: source.affiliation || null,
    shortBio: source.shortBio || null,
    location: source.location || null,
    slug: source.slug || null,
    slugHistory: source.slugHistory || [],
    website: source.website || null,
    socialLinks: source.socialLinks instanceof Map ? Object.fromEntries(source.socialLinks.entries()) : (source.socialLinks || {}),
    status: source.status || 'draft',
    profileVisible: source.profileVisible === true,
    internalEmail: source.internalEmail || null,
    internalNotes: source.internalNotes || null,
    rightsConsent: source.rightsConsent || {},
    publicContributor: buildPublicContributor(source, null),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null,
  };
}

function duplicateSlugMessage(error) {
  if (error && (error.code === 11000 || error.code === 11001)) return 'Contributor slug already exists';
  return null;
}

router.use(requireAdminAuth);

router.get('/capabilities', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  const capabilities = await contributorSlugCapabilities(Contributor);
  return res.json({ ok: true, success: true, capabilities, data: { capabilities } });
});

router.get('/', async (req, res, next) => {
  try {
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    const skip = (page - 1) * limit;
    const status = String(req.query.status || '').trim().toLowerCase();
    const q = String(req.query.q || req.query.search || '').trim();

    const filter = {};
    if (status) filter.status = status;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      filter.$or = [
        { canonicalName: rx },
        { displayNameHi: rx },
        { displayNameGu: rx },
        { publicDesignation: rx },
        { affiliation: rx },
        { shortBio: rx },
        { slug: rx },
      ];
    }

    const [itemsRaw, total] = await Promise.all([
      Contributor.find(filter).sort({ updatedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Contributor.countDocuments(filter),
    ]);
    const items = (itemsRaw || []).map(toAdminContributorDto);
    return res.json({ ok: true, success: true, data: { items, page, limit, total }, items, contributors: items, page, limit, total });
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id || '').trim();
    const query = mongoose.Types.ObjectId.isValid(id) ? { _id: id } : { slug: id.toLowerCase() };
    const contributor = await Contributor.findOne(query).lean();
    if (!contributor) return res.status(404).json({ ok: false, success: false, message: 'Contributor not found' });
    return res.json({ ok: true, success: true, contributor: toAdminContributorDto(contributor), data: { contributor: toAdminContributorDto(contributor) } });
  } catch (error) {
    return next(error);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const parsed = normalizeContributorPayload(req.body, { partial: false });
    if (!parsed.ok) return res.status(parsed.status || 400).json({ ok: false, success: false, message: parsed.message });
    const contributor = await createWithUniqueDialogueSlug(Contributor, parsed.value, {
      explicitSlug: Object.prototype.hasOwnProperty.call(req.body, 'slug'),
      reservedSlugField: 'slugHistory',
    });
    const dto = toAdminContributorDto(contributor);
    return res.status(201).json({ ok: true, success: true, status: 201, contributor: dto, data: { contributor: dto } });
  } catch (error) {
    const duplicateMessage = duplicateSlugMessage(error);
    if (duplicateMessage) return res.status(409).json({ ok: false, success: false, message: duplicateMessage });
    if (error && error.name === 'ValidationError') return res.status(400).json({ ok: false, success: false, message: error.message });
    return next(error);
  }
});

async function updateContributor(req, res, next) {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid contributor id' });
    }
    const parsed = normalizeContributorPayload(req.body, { partial: true });
    if (!parsed.ok) return res.status(parsed.status || 400).json({ ok: false, success: false, message: parsed.message });
    let contributor = await Contributor.findByIdAndUpdate(id, { $set: parsed.value }, { new: true, runValidators: true });
    if (!contributor) return res.status(404).json({ ok: false, success: false, message: 'Contributor not found' });
    contributor = await initializeLegacyContributorHistory(Contributor, contributor);
    if (['status', 'profileVisible'].some((field) => Object.prototype.hasOwnProperty.call(parsed.value, field))) {
      await publicCache.safeDeleteByPrefix('np:v1:category:pulse-dialogue:');
    }
    const dto = toAdminContributorDto(contributor);
    return res.json({ ok: true, success: true, contributor: dto, data: { contributor: dto } });
  } catch (error) {
    const duplicateMessage = duplicateSlugMessage(error);
    if (duplicateMessage) return res.status(409).json({ ok: false, success: false, message: duplicateMessage });
    if (error && error.name === 'ValidationError') return res.status(400).json({ ok: false, success: false, message: error.message });
    return next(error);
  }
}

router.put('/:id', updateContributor);
router.patch('/:id', updateContributor);

router.patch('/:id/slug', async (req, res, next) => {
  try {
    const capabilities = await contributorSlugCapabilities(Contributor);
    if (!capabilities.slugRename) return res.status(503).json({
      ok: false, success: false, code: 'CONTRIBUTOR_SLUG_RENAME_UNAVAILABLE', capabilities,
      message: 'Contributor slug changes are temporarily unavailable pending release readiness.',
    });
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid contributor id' });
    }
    if (typeof req.body?.slug !== 'string' || Object.keys(req.body).some((field) => field !== 'slug')) {
      return res.status(400).json({ ok: false, success: false, message: 'Provide only a slug string' });
    }
    const slug = normalizeContributorSlug(req.body.slug, { maxLength: 120 });
    if (!slug) return res.status(400).json({ ok: false, success: false, message: 'slug must contain letters or numbers' });
    const existing = await Contributor.findById(id).select('slug slugHistory').lean();
    if (!existing) return res.status(404).json({ ok: false, success: false, message: 'Contributor not found' });
    const slugHistory = normalizeContributorSlugHistory([...(Array.isArray(existing.slugHistory) ? existing.slugHistory : []), existing.slug], slug);
    const reserved = await Contributor.exists({ _id: { $ne: id }, $or: [{ slug: { $in: slugHistory } }, { slugHistory: { $in: slugHistory } }] });
    if (reserved) return res.status(409).json({ ok: false, success: false, message: 'Contributor slug already exists' });
    const contributor = await Contributor.findOneAndUpdate(
      { _id: id, slug: existing.slug, $expr: { $eq: [{ $ifNull: ['$slugHistory', null] }, { $literal: existing.slugHistory ?? null }] } },
      { $set: { slug, slugHistory } },
      { new: true, runValidators: true }
    );
    if (!contributor) return res.status(409).json({ ok: false, success: false, message: 'Contributor slug changed; reload and retry' });
    await publicCache.safeDeleteByPrefix('np:v1:category:pulse-dialogue:');
    const dto = toAdminContributorDto(contributor);
    return res.json({ ok: true, success: true, contributor: dto, data: { contributor: dto } });
  } catch (error) {
    const duplicateMessage = duplicateSlugMessage(error);
    if (duplicateMessage) return res.status(409).json({ ok: false, success: false, message: duplicateMessage });
    if (error?.name === 'ValidationError') return res.status(400).json({ ok: false, success: false, message: error.message });
    return next(error);
  }
});

module.exports = router;