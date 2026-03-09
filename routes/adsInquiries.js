const express = require('express');

const {
  submitPublicAdInquiry,
} = require('../controllers/adsInquiriesController');

const publicAdsInquiriesRouter = express.Router();
publicAdsInquiriesRouter.post('/inquiry', submitPublicAdInquiry);

const adminAdsInquiriesRouter = require('./admin/adInquiries');

module.exports = {
  publicAdsInquiriesRouter,
  adminAdsInquiriesRouter,
};
