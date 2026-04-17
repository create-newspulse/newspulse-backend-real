const express = require('express');
const { getPublishedSettings } = require('../controllers/publicSiteSettingsController');
const { createJsonCacheMiddleware, buildPublicSettingsCacheKey } = require('../lib/cache');
const noCache = require('../middleware/noCache');

const router = express.Router();

// GET /api/public/settings - get published settings (no auth required)
router.get(
	'/settings',
	noCache,
	createJsonCacheMiddleware({
		ttlSeconds: 60,
		buildKey: () => buildPublicSettingsCacheKey(),
		shouldCache: ({ statusCode, body }) => statusCode === 200 && body && body.ok === true && !!body.published,
	}),
	getPublishedSettings,
);

module.exports = router;
