const express = require('express');

const {
  submitPublicAdInquiry,
} = require('../controllers/adsInquiriesController');

const publicAdsInquiriesRouter = express.Router();
publicAdsInquiriesRouter.post('/inquiry', submitPublicAdInquiry);
// Backward/forward compatible alias (some frontends use plural)
publicAdsInquiriesRouter.post('/inquiries', submitPublicAdInquiry);

const adminAdsInquiriesRouter = require('./admin/adInquiries');

module.exports = {
  publicAdsInquiriesRouter,
  adminAdsInquiriesRouter,
};
