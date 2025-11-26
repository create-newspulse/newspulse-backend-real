// routes/system/monitorHub.js
// Returns lightweight monitoring stats; uses mock data until DB is connected.

const express = require('express');
const state = require('../../lib/state');
const router = express.Router();

router.get('/', (_req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const payload = {
    ok: true,
    success: true,
    activeUsers: state.activeUsers || 0,
    mobilePercent: 72,
    avgSession: '2m 10s',
    newsApi: 99,
    weatherApi: 98,
    twitterApi: 97,
    loginAttempts: 3,
    autoPatches: 1,
    topRegions: ['IN', 'US', 'AE'],
    aiTools: ['Classifier', 'Summarizer', 'SEO-Assist'],
    ptiScore: 100,
    flags: 0,
  };
  res.status(200).json(payload);
});

module.exports = router;
