const express = require('express');

const noCache = require('../middleware/noCache');
const {
  getActiveSponsoredFeature,
  getHomepageCenterSlot,
} = require('../controllers/publicSponsoredFeaturesController');

const router = express.Router();

router.use(noCache);

router.get('/sponsored-features', getActiveSponsoredFeature);
router.get('/sponsored-features/slot/:placementKey', getActiveSponsoredFeature);
router.get('/homepage/center-slot', getHomepageCenterSlot);

module.exports = router;