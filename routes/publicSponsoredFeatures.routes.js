const express = require('express');

const noCache = require('../middleware/noCache');
const {
  getActiveSponsoredFeature,
  getHomepageCenterSlot,
} = require('../controllers/publicSponsoredFeaturesController');

const router = express.Router();

router.use(noCache);

router.get('/sponsored-feature', (req, res, next) => {
  getActiveSponsoredFeature(req, res).catch(next);
});
router.get('/sponsored-features', (req, res, next) => {
  getActiveSponsoredFeature(req, res).catch(next);
});
router.get('/sponsored-features/slot/:placementKey', (req, res, next) => {
  getActiveSponsoredFeature(req, res).catch(next);
});
router.get('/homepage/center-slot', (req, res, next) => {
  getHomepageCenterSlot(req, res).catch(next);
});

module.exports = router;