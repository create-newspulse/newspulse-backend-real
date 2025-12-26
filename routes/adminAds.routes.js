const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  listAds,
  createAd,
  updateAd,
  toggleAd,
  deleteAd,
} = require('../controllers/admin/adsController');

const router = express.Router();

router.use(requireAdminAuth);

// GET /api/admin/ads?slot=HOME_728x90
router.get('/ads', listAds);

// POST /api/admin/ads
router.post('/ads', createAd);

// PUT /api/admin/ads/:id
router.put('/ads/:id', updateAd);

// PATCH /api/admin/ads/:id/toggle
router.patch('/ads/:id/toggle', toggleAd);

// DELETE /api/admin/ads/:id
router.delete('/ads/:id', deleteAd);

module.exports = router;
