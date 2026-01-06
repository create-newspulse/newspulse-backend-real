const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');

const { requireAdminAuth } = require('../middleware/adminAuth');
const SiteSetting = require('../models/SiteSetting');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { defaultPublicSiteSettings } = require('../lib/publicSiteSettings');

const router = express.Router();

const AnyObjectSchema = z.record(z.any());

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

const SCOPE = 'public';
const KEY = 'public';

function coerceVersion(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normalizeBundle(input) {
  // Admin endpoints must return exactly what was saved.
  // Public endpoints can normalize separately for frontend safety.
  return input;
}

async function getLegacyDraftLean() {
  return SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'draft' }).lean();
}

async function getLegacyPublishedLatestLean() {
  return SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'published' })
    .sort({ version: -1, createdAt: -1 })
    .lean();
}

function hasNonEmptyObject(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

async function getPublicDoc(lean = false) {
  const q = PublicSiteSettings.findOne({ scope: SCOPE });
  return lean ? q.lean() : q;
}

async function upsertPublicDoc(setFields, setOnInsertFields = {}) {
  return PublicSiteSettings.findOneAndUpdate(
    { scope: SCOPE },
    { $set: setFields, $setOnInsert: { scope: SCOPE, ...setOnInsertFields } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

async function bestEffortUpdateLegacyDraft(draftPayload) {
  try {
    // Some deployments have legacy indexes that prevent creating additional SiteSetting docs.
    // Only update an existing draft doc; never upsert.
    await SiteSetting.findOneAndUpdate(
      { scope: SCOPE, key: KEY, status: 'draft' },
      { $set: { data: draftPayload } },
      { new: true, upsert: false },
    );
  } catch (_) {
    // Ignore legacy write failures; PublicSiteSettings is authoritative.
  }
}

async function bestEffortUpdateLegacyPublished(publishedPayload, version, publishedAt) {
  try {
    // Only update an existing published doc; never upsert.
    await SiteSetting.findOneAndUpdate(
      { scope: SCOPE, key: KEY, status: 'published' },
      { $set: { data: publishedPayload, version, publishedAt } },
      { new: true, upsert: false, sort: { version: -1, createdAt: -1 } },
    );
  } catch (_) {
    // Ignore legacy write failures; PublicSiteSettings is authoritative.
  }
}

// GET /api/admin/settings/public
async function handleGet(req, res, next) {
  try {
    if (!isDbReady()) {
      const def = defaultPublicSiteSettings();
      return res.status(200).json({
        ok: true,
        success: true,
        status: 200,
        message: 'OK',
        path: req.originalUrl,
        published: def,
        version: 0,
        updatedAt: null,
        data: { draft: def, published: def },
        meta: { scope: 'public', version: 0, updatedAt: null, publishedAt: null },
      });
    }

    const [publicDoc, legacyDraftDoc, legacyPublishedDoc] = await Promise.all([
      getPublicDoc(true),
      getLegacyDraftLean(),
      getLegacyPublishedLatestLean(),
    ]);

    const fallback = defaultPublicSiteSettings();

    const draftRaw = hasNonEmptyObject(publicDoc?.draft) ? publicDoc.draft : legacyDraftDoc?.data;
    const publishedRaw = hasNonEmptyObject(publicDoc?.published) ? publicDoc.published : legacyPublishedDoc?.data;

    const draft = normalizeBundle(draftRaw || fallback);
    const published = normalizeBundle(publishedRaw || fallback);

    // Ensure the singleton doc exists (and backfill empty fields) so future reads are stable.
    if (!publicDoc) {
      await upsertPublicDoc({}, { draft, published, version: 0 });
    } else if (!hasNonEmptyObject(publicDoc?.draft) || !hasNonEmptyObject(publicDoc?.published)) {
      await upsertPublicDoc({
        ...(hasNonEmptyObject(publicDoc?.draft) ? {} : { draft }),
        ...(hasNonEmptyObject(publicDoc?.published) ? {} : { published }),
      });
    }

    const version = coerceVersion(publicDoc?.version ?? legacyPublishedDoc?.version);
    const updatedAt = publicDoc?.updatedAt || legacyDraftDoc?.updatedAt || legacyPublishedDoc?.updatedAt || null;
    const publishedAt = publicDoc?.publishedAt || legacyPublishedDoc?.publishedAt || null;

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      path: req.originalUrl,
      published,
      version,
      updatedAt,
      data: { draft, published },
      meta: { scope: 'public', version, updatedAt, publishedAt },
    });
  } catch (e) {
    return next(e);
  }
}

router.get('/public', requireAdminAuth, handleGet);

// GET /api/admin/settings/public/draft
async function handleGetDraft(req, res, next) {
  try {
    if (!isDbReady()) {
      const def = defaultPublicSiteSettings();
      return res.status(200).json({
        ok: true,
        success: true,
        status: 200,
        message: 'OK',
        path: req.originalUrl,
        data: { draft: def },
        meta: { scope: 'public', version: 0, updatedAt: null, publishedAt: null },
      });
    }

    const [publicDoc, legacyDraftDoc, legacyPublishedDoc] = await Promise.all([
      getPublicDoc(true),
      getLegacyDraftLean(),
      getLegacyPublishedLatestLean(),
    ]);

    const fallback = defaultPublicSiteSettings();
    const draftRaw = hasNonEmptyObject(publicDoc?.draft) ? publicDoc.draft : legacyDraftDoc?.data;
    const draft = normalizeBundle(draftRaw || fallback);

    // Ensure the singleton doc exists, and ensure draft is initialized.
    if (!publicDoc) {
      await upsertPublicDoc({}, { draft, published: fallback, version: 0 });
    } else if (!hasNonEmptyObject(publicDoc?.draft)) {
      await upsertPublicDoc({ draft });
    }
    const version = coerceVersion(publicDoc?.version ?? legacyPublishedDoc?.version);
    const updatedAt = publicDoc?.updatedAt || legacyDraftDoc?.updatedAt || null;
    const publishedAt = publicDoc?.publishedAt || legacyPublishedDoc?.publishedAt || null;

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      path: req.originalUrl,
      data: { draft },
      meta: { scope: 'public', version, updatedAt, publishedAt },
    });
  } catch (e) {
    return next(e);
  }
}

// PUT /api/admin/settings/public/draft
async function handlePutDraft(req, res, next) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({
        ok: false,
        success: false,
        status: 503,
        message: 'Database unavailable',
        data: null,
        path: req.originalUrl,
      });
    }

    const parsed = AnyObjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        success: false,
        status: 400,
        message: 'Invalid public settings draft payload',
        data: null,
        path: req.originalUrl,
      });
    }

    const draftPayload = normalizeBundle(parsed.data);
    const [doc, legacyPublishedDoc] = await Promise.all([
      upsertPublicDoc({ draft: draftPayload }, { published: defaultPublicSiteSettings() }),
      getLegacyPublishedLatestLean(),
    ]);

    await bestEffortUpdateLegacyDraft(draftPayload);

    const version = coerceVersion(doc?.version ?? legacyPublishedDoc?.version);
    const updatedAt = doc?.updatedAt || null;
    const publishedAt = doc?.publishedAt || legacyPublishedDoc?.publishedAt || null;

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      path: req.originalUrl,
      data: { draft: normalizeBundle(doc?.draft || draftPayload) },
      meta: { scope: 'public', version, updatedAt, publishedAt },
    });
  } catch (e) {
    return next(e);
  }
}

router.put(['/public/draft', '/public-settings/draft', '/public-setting/draft'], requireAdminAuth, handlePutDraft);
router.get(['/public/draft', '/public-settings/draft', '/public-setting/draft'], requireAdminAuth, handleGetDraft);

// POST /api/admin/settings/public/publish
async function handlePublish(req, res, next) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({
        ok: false,
        success: false,
        status: 503,
        message: 'Database unavailable',
        data: null,
        path: req.originalUrl,
      });
    }

    const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
    const [publicDoc, legacyDraftDoc, legacyPublishedDoc] = await Promise.all([
      getPublicDoc(false),
      getLegacyDraftLean(),
      getLegacyPublishedLatestLean(),
    ]);

    // Source draft: request body > PublicSiteSettings.draft > legacy SiteSetting draft
    const draftRaw = hasBody ? req.body : (hasNonEmptyObject(publicDoc?.draft) ? publicDoc.draft : legacyDraftDoc?.data);
    if (!draftRaw) {
      return res.status(400).json({
        ok: false,
        success: false,
        status: 400,
        message: 'No draft exists to publish',
        data: null,
        path: req.originalUrl,
      });
    }

    const draftPayload = normalizeBundle(draftRaw);

    // If the admin panel posts a body directly to /publish, treat it as the new draft as well.
    if (hasBody) {
      await bestEffortUpdateLegacyDraft(draftPayload);
    }

    const publishedAt = new Date();
    const nextVersion = coerceVersion(publicDoc?.version ?? legacyPublishedDoc?.version) + 1;

    const updated = await upsertPublicDoc({
      draft: draftPayload,
      published: draftPayload,
      version: nextVersion,
      publishedAt,
    }, {
      draft: defaultPublicSiteSettings(),
      published: defaultPublicSiteSettings(),
    });

    await bestEffortUpdateLegacyPublished(draftPayload, nextVersion, publishedAt);

    const version = coerceVersion(updated?.version ?? nextVersion);
    const updatedAt = updated?.updatedAt || null;

    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      message: 'OK',
      path: req.originalUrl,
      published: normalizeBundle(updated?.published || draftPayload),
      version,
      updatedAt,
      data: { published: normalizeBundle(updated?.published || draftPayload) },
      meta: { scope: 'public', version, updatedAt, publishedAt },
    });
  } catch (e) {
    return next(e);
  }
}

router.post(['/public/publish', '/public-settings/publish', '/public-setting/publish'], requireAdminAuth, handlePublish);

module.exports = router;
