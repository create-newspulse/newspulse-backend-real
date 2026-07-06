const mongoose = require('mongoose');
const {
  getViralVideosSettings,
  isViralVideosFrontendEnabled,
} = require('../lib/viralVideosSettings');

const {
  listPublishedViralVideos,
  listPublishedViralVideosFromFile,
  listFeaturedViralVideos,
  getPublishedViralVideoBySlug,
  getPublishedViralVideoBySlugFromFile,
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
    success: true,
    enabled: false,
    viralVideosFrontendEnabled: false,
    items: [],
    videos: [],
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

function logViralVideosFetchFailure(scope, error) {
  try {
    // eslint-disable-next-line no-console
    console.error('[viral-videos][public-fetch-failed]', {
      scope,
      message: error?.message || String(error),
      ...(error?.name ? { name: error.name } : {}),
      ...(error?.code ? { code: error.code } : {}),
    });
  } catch (_) {}
}

async function getPublicViralVideosSettings(_req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');
    const settings = await getViralVideosSettings();
    const enabled = settings.viralVideosFrontendEnabled !== false;

    return res.status(200).json({
      ok: true,
      enabled,
      viralVideosFrontendEnabled: enabled,
      data: { enabled, viralVideosFrontendEnabled: enabled },
      settings: { enabled, viralVideosFrontendEnabled: enabled },
    });
  } catch (error) {
    logViralVideosFetchFailure('settings', error);
    return next(error);
  }
}

async function listPublicViralVideos(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (!isDbReady()) {
      const result = await listPublishedViralVideosFromFile(req.query);
      return res.status(200).json({ ok: true, success: true, enabled: true, ...result, videos: result.items });
    }

    if (!(await isViralVideosFrontendEnabled())) {
      return res.status(200).json(buildEmptyArchiveResponse());
    }

    const result = await listPublishedViralVideos(req.query);
    return res.status(200).json({ ok: true, success: true, enabled: true, ...result, videos: result.items });
  } catch (error) {
    logViralVideosFetchFailure('archive', error);
    return next(error);
  }
}

async function listFeaturedPublicViralVideos(req, res, next) {
  try {
    setFeaturedNoCacheHeaders(res);
    const settings = await getViralVideosSettings();
    const frontendEnabled = settings.viralVideosFrontendEnabled !== false;
    const responseSettings = { frontendEnabled, viralVideosFrontendEnabled: frontendEnabled };

    if (!isDbReady()) {
      return res.status(200).json({ ok: true, success: true, enabled: frontendEnabled, settings: responseSettings, video: null, items: [], videos: [] });
    }

    if (!frontendEnabled) {
      return res.status(200).json({ ok: true, success: true, enabled: false, settings: responseSettings, video: null, items: [], videos: [] });
    }

    const items = await listFeaturedViralVideos(req.query);
    return res.status(200).json({ ok: true, success: true, enabled: true, settings: responseSettings, video: items[0] || null, items, videos: items });
  } catch (error) {
    logViralVideosFetchFailure('featured', error);
    return next(error);
  }
}

async function getPublicViralVideoBySlug(req, res, next) {
  try {
    res.set('Cache-Control', 'no-store');

    if (!isDbReady()) {
      const item = await getPublishedViralVideoBySlugFromFile(req.params.slug);
      if (!item) return res.status(404).json({ ok: false, success: false, message: 'Viral video not found' });
      return res.status(200).json({ ok: true, success: true, item, video: item });
    }

    if (!(await isViralVideosFrontendEnabled())) {
      return res.status(404).json({ ok: false, message: 'Viral videos are currently unavailable' });
    }

    const item = await getPublishedViralVideoBySlug(req.params.slug);
    if (!item) {
      return res.status(404).json({ ok: false, success: false, message: 'Viral video not found' });
    }

    return res.status(200).json({ ok: true, success: true, item, video: item });
  } catch (error) {
    logViralVideosFetchFailure('detail', error);
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
    logViralVideosFetchFailure('related', error);
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
