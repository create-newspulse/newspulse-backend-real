const express = require('express');

const noCache = require('../middleware/noCache');
const {
  getPublicViralVideosSettings,
  listPublicViralVideos,
  listFeaturedPublicViralVideos,
  getPublicViralVideoBySlug,
  listRelatedPublicViralVideos,
} = require('../controllers/publicViralVideosController');

const router = express.Router();

router.use(noCache);

router.get('/viral-videos/settings', getPublicViralVideosSettings);
router.get('/viral-videos', listPublicViralVideos);
router.get('/viral-videos/featured', listFeaturedPublicViralVideos);
router.get('/viral-videos/:slug/related', listRelatedPublicViralVideos);
router.get('/viral-videos/:slug', getPublicViralVideoBySlug);

module.exports = router;
