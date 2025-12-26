const express = require('express');

const {
  getActiveAd,
  postImpression,
  postClick,
} = require('../controllers/publicAdsController');

const router = express.Router();

// GET /api/public/ads?slot=HOME_728x90
router.get('/ads', getActiveAd);

// GET /api/public/ads/slot/:slot
router.get('/ads/slot/:slot', (req, res, next) => {
  req.query = req.query || {};
  req.query.slot = req.params.slot;
  return getActiveAd(req, res, next);
});

// POST /api/public/ads/:id/impression
router.post('/ads/:id/impression', postImpression);

// POST /api/public/ads/:id/click
router.post('/ads/:id/click', postClick);

module.exports = router;
