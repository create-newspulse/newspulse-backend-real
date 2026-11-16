const express = require('express');

const { requireAdminModule } = require('../middleware/adminAuth');
const { requireSpecialRight } = require('../middleware/requireAuth');
const {
  listSponsoredFeatures,
  listEligibleSponsoredArticles,
  getSponsoredFeaturesDashboard,
  getSponsoredFeature,
  createSponsoredFeature,
  updateSponsoredFeature,
  toggleSponsoredFeature,
  toggleSponsoredFeatureCombo,
  deleteSponsoredFeature,
} = require('../controllers/admin/sponsoredFeaturesController');

const router = express.Router();
const viewAds = requireSpecialRight('ads_view');
const manageCampaigns = requireSpecialRight('ads_manage_campaigns');

router.use('/sponsored-features', requireAdminModule('ads_manager'));

router.get('/sponsored-features/dashboard', viewAds, (req, res, next) => {
  getSponsoredFeaturesDashboard(req, res).catch(next);
});
router.get('/sponsored-features/eligible-articles', viewAds, listEligibleSponsoredArticles);
router.get('/sponsored-features', viewAds, (req, res, next) => {
  listSponsoredFeatures(req, res).catch(next);
});
router.get('/sponsored-features/:id', viewAds, getSponsoredFeature);
router.post('/sponsored-features', manageCampaigns, createSponsoredFeature);
router.put('/sponsored-features/:id', manageCampaigns, updateSponsoredFeature);
router.patch('/sponsored-features/:id/toggle', manageCampaigns, toggleSponsoredFeature);
router.patch('/sponsored-features/:id/combo-toggle', manageCampaigns, toggleSponsoredFeatureCombo);
router.delete('/sponsored-features/:id', manageCampaigns, deleteSponsoredFeature);

module.exports = router;