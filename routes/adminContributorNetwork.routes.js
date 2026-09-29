const express = require('express');

const { requireAdminAuth, requireAdminModule, requireFounderOrAdmin } = require('../middleware/adminAuth');
const requireQueueAccess = requireAdminModule('communityReporterQueue');
const {
  queueUnresolved,
  queueMissingEmail,
  queueMissingPhone,
  queueMissingLocation,
  listInactiveContributors,
  highContributionUnverified,
  topContributors,
  getReporterDirectory,
  profileDebug,
  addNote,
  createTask,
  backfillProfiles,
  runMergeSuggestions,
} = require('../controllers/adminContributorNetworkController');

const router = express.Router();

// Queues
router.get('/queues/unresolved', requireQueueAccess, queueUnresolved);
router.get('/queues/missing-email', requireQueueAccess, queueMissingEmail);
router.get('/queues/missing-phone', requireQueueAccess, queueMissingPhone);
router.get('/queues/missing-location', requireQueueAccess, queueMissingLocation);

// Lists/insights
router.get('/inactive', requireQueueAccess, listInactiveContributors);
router.get('/insights/high-contribution-unverified', requireQueueAccess, highContributionUnverified);
router.get('/insights/top-contributors', requireQueueAccess, topContributors);

// Reporter Contact Directory (unified reporter-centric dataset)
router.get('/directory', requireQueueAccess, getReporterDirectory);

// CRM primitives
router.get('/profiles/:profileId/debug', requireQueueAccess, profileDebug);
router.post('/profiles/:profileId/notes', requireAdminAuth, addNote);
router.post('/profiles/:profileId/tasks', requireAdminAuth, createTask);

// Founder/Admin ops
router.post('/backfill', requireFounderOrAdmin, backfillProfiles);
router.post('/merge/suggestions/run', requireFounderOrAdmin, runMergeSuggestions);

module.exports = router;
