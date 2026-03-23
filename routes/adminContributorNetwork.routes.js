const express = require('express');

const { requireAdminAuth, requireFounderOrAdmin } = require('../middleware/adminAuth');
const {
  queueUnresolved,
  queueMissingEmail,
  queueMissingPhone,
  queueMissingLocation,
  listInactiveContributors,
  highContributionUnverified,
  topContributors,
  addNote,
  createTask,
  backfillProfiles,
  runMergeSuggestions,
} = require('../controllers/adminContributorNetworkController');

const router = express.Router();

// Queues
router.get('/queues/unresolved', requireAdminAuth, queueUnresolved);
router.get('/queues/missing-email', requireAdminAuth, queueMissingEmail);
router.get('/queues/missing-phone', requireAdminAuth, queueMissingPhone);
router.get('/queues/missing-location', requireAdminAuth, queueMissingLocation);

// Lists/insights
router.get('/inactive', requireAdminAuth, listInactiveContributors);
router.get('/insights/high-contribution-unverified', requireAdminAuth, highContributionUnverified);
router.get('/insights/top-contributors', requireAdminAuth, topContributors);

// CRM primitives
router.post('/profiles/:profileId/notes', requireAdminAuth, addNote);
router.post('/profiles/:profileId/tasks', requireAdminAuth, createTask);

// Founder/Admin ops
router.post('/backfill', requireFounderOrAdmin, backfillProfiles);
router.post('/merge/suggestions/run', requireFounderOrAdmin, runMergeSuggestions);

module.exports = router;
