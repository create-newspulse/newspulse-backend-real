const express = require('express');
const mongoose = require('mongoose');
const Series = require('../models/PulseDialogueSeries');
const { requireAdminAuth } = require('../middleware/adminAuth');
const { slugifyUnicode } = require('../lib/slug');
const { assertContributorExists, createWithUniqueDialogueSlug } = require('../services/pulseDialogue.service');

const router = express.Router();
router.use(requireAdminAuth);

function invalid(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}

async function parsePayload(body, partial = false) {
  const input = body || {};
  const value = {};
  if (!partial || Object.prototype.hasOwnProperty.call(input, 'title')) {
    if (typeof input.title !== 'string' || !input.title.trim()) throw invalid('title is required');
    value.title = input.title.trim().slice(0, 200);
  }
  if (partial && Object.prototype.hasOwnProperty.call(input, 'slug')) throw invalid('Series slug is permanent');
  if (!partial) {
    value.slug = slugifyUnicode(input.slug || value.title, { maxLength: 120 }) || 'series';
    if (Object.prototype.hasOwnProperty.call(input, 'slug') && !slugifyUnicode(input.slug)) throw invalid('Invalid series slug');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'description')) {
    if (input.description !== null && typeof input.description !== 'string') throw invalid('Invalid description');
    value.description = input.description?.trim().slice(0, 1000) || null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'profileVisible')) {
    if (typeof input.profileVisible !== 'boolean') throw invalid('profileVisible must be a boolean');
    value.profileVisible = input.profileVisible;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'ownerContributorId')) {
    value.ownerContributorId = input.ownerContributorId || null;
    if (value.ownerContributorId) await assertContributorExists(value.ownerContributorId);
  }
  return value;
}

function respondError(error, res, next) {
  if (error.code === 11000) return res.status(409).json({ ok: false, message: 'Series slug already exists' });
  if (error.statusCode === 400 || error.name === 'ValidationError') return res.status(400).json({ ok: false, message: error.message });
  return next(error);
}

router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
    const page = Math.min(Math.max(Number.parseInt(req.query.page, 10) || 1, 1), 10000);
    const [items, total] = await Promise.all([
      Series.find({}).sort({ title: 1, _id: 1 }).skip((page - 1) * limit).limit(limit).lean(),
      Series.countDocuments({}),
    ]);
    return res.json({ ok: true, items, total, page, limit });
  } catch (error) { return next(error); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const filter = mongoose.isValidObjectId(req.params.id) ? { _id: req.params.id } : { slug: req.params.id };
    const series = await Series.findOne(filter).lean();
    if (!series) return res.status(404).json({ ok: false, message: 'Series not found' });
    return res.json({ ok: true, series });
  } catch (error) { return next(error); }
});

router.post('/', async (req, res, next) => {
  try {
    const payload = await parsePayload(req.body);
    const series = await createWithUniqueDialogueSlug(Series, payload, {
      explicitSlug: Object.prototype.hasOwnProperty.call(req.body, 'slug'),
    });
    return res.status(201).json({ ok: true, series });
  } catch (error) { return respondError(error, res, next); }
});

async function update(req, res, next) {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw invalid('Invalid series id');
    const payload = await parsePayload(req.body, true);
    const series = await Series.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true });
    if (!series) return res.status(404).json({ ok: false, message: 'Series not found' });
    return res.json({ ok: true, series });
  } catch (error) { return respondError(error, res, next); }
}

router.patch('/:id', update);
router.put('/:id', update);
module.exports = router;