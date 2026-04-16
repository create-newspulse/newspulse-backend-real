const express = require('express');

const { requireAdminAuth } = require('../middleware/adminAuth');
const {
  listSponsoredFeatures,
  createSponsoredFeature,
  updateSponsoredFeature,
  toggleSponsoredFeature,
  deleteSponsoredFeature,
} = require('../controllers/admin/sponsoredFeaturesController');

const router = express.Router();

router.use('/sponsored-features', requireAdminAuth);

router.get('/sponsored-features', listSponsoredFeatures);
router.post('/sponsored-features', createSponsoredFeature);
router.put('/sponsored-features/:id', updateSponsoredFeature);
router.patch('/sponsored-features/:id/toggle', toggleSponsoredFeature);
router.delete('/sponsored-features/:id', deleteSponsoredFeature);

module.exports = router;