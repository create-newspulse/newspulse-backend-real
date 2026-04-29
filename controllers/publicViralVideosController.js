const mongoose = require('mongoose');
const {
  getViralVideosSettings,
  isViralVideosFrontendEnabled,
} = require('../lib/viralVideosSettings');

const {
  listPublishedViralVideos,
  listFeaturedViralVideos,
  getPublishedViralVideoBySlug,
  listRelatedPublishedViralVideos,
} = require('../services/viralVideos.service');

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function buildEmptyArchiveResponse() {
  return {
    ok: true,
    enabled: false,
    items: [],
    page: 1,
    limit: 0,
    total: 0,
    totalPages: 1,
    filters: { lang: null, category: null, year: null, month: null, tag: null },
  };
}

function setFeaturedNoCacheHeaders(res) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
}

async function getPublicViralVideosSettings(_req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const settings = await getViralVideosSettings();
    const enabled = settings.frontendEnabled !== false;

    return res.status(200).json({
      ok: true,
      enabled,
      data: { enabled },
      settings: { enabled },
    });
  } catch (error) {
    return next(error);
  }
}

async function listPublicViralVideos(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (!isDbReady()) {
      return res.status(200).json(buildEmptyArchiveResponse());
    }

    if (!(await isViralVideosFrontendEnabled())) {
      return res.status(200).json(buildEmptyArchiveResponse());
    }

    const result = await listPublishedViralVideos(req.query);
    return res.status(200).json({ ok: true, enabled: true, ...result });
  } catch (error) {
    return next(error);
  }
}

async function listFeaturedPublicViralVideos(req, res, next) {
  try {
    setFeaturedNoCacheHeaders(res);
    const settings = await getViralVideosSettings();
    const frontendEnabled = settings.frontendEnabled !== false;

    if (!isDbReady()) {
      return res.status(200).json({ ok: true, settings: { frontendEnabled }, video: null });
    }

    if (!frontendEnabled) {
      return res.status(200).json({ ok: true, settings: { frontendEnabled: false }, video: null });
    }

    const items = await listFeaturedViralVideos(req.query);
    return res.status(200).json({ ok: true, settings: { frontendEnabled: true }, video: items[0] || null });
  } catch (error) {
    return next(error);
  }
}

async function getPublicViralVideoBySlug(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database not connected' });
    }

    if (!(await isViralVideosFrontendEnabled())) {
      return res.status(404).json({ ok: false, message: 'Viral videos are currently unavailable' });
    }

    const item = await getPublishedViralVideoBySlug(req.params.slug);
    if (!item) {
      return res.status(404).json({ ok: false, message: 'Viral video not found' });
    }

    return res.status(200).json({ ok: true, item });
  } catch (error) {
    return next(error);
  }
}

async function listRelatedPublicViralVideos(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database not connected' });
    }

    if (!(await isViralVideosFrontendEnabled())) {
      return res.status(404).json({ ok: false, message: 'Viral videos are currently unavailable' });
    }

    const items = await listRelatedPublishedViralVideos(req.params.slug, req.query);
    if (items === null) {
      return res.status(404).json({ ok: false, message: 'Viral video not found' });
    }

    return res.status(200).json({ ok: true, items });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  getPublicViralVideosSettings,
  listPublicViralVideos,
  listFeaturedPublicViralVideos,
  getPublicViralVideoBySlug,
  listRelatedPublicViralVideos,
};
