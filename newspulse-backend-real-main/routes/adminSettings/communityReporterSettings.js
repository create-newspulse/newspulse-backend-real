const express = require('express');
const { requireAdminAuth } = require('../../../middleware/adminAuth');

const router = express.Router();

// In-memory feature flag; can be wired to SystemSettings later
let myCommunityStoriesEnabled = false;

// GET: return current setting (admin protected)
router.get('/settings/community-reporter', requireAdminAuth, (req, res) => {
  return res.json({
    success: true,
    settings: { myCommunityStoriesEnabled },
  });
});

// POST: update setting (admin protected)
router.post('/settings/community-reporter', requireAdminAuth, (req, res) => {
  const { myCommunityStoriesEnabled: next } = req.body || {};
  myCommunityStoriesEnabled = !!next;
  return res.json({
    success: true,
    settings: { myCommunityStoriesEnabled },
  });
});

module.exports = router;