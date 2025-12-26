const express = require('express');
const { requireAdminAuth } = require('../../../middleware/adminAuth');
const {
  getWorkflowQueue,
  getWorkflowBoard,
  getWorkflowArticle,
  patchWorkflowStage,
} = require('../../controllers/admin/workflow.controller');

const router = express.Router();

// Supporting endpoint for workflow board
// GET /api/admin/workflow/queue?stage=&q=&page=&limit=&language=&category=
router.get('/workflow/queue', requireAdminAuth, getWorkflowQueue);

// Workflow board grouped columns
// GET /api/admin/workflow/board?mode=simple|advanced
router.get('/workflow/board', requireAdminAuth, getWorkflowBoard);

// Inspector panel
// GET /api/admin/workflow/articles/:id
router.get('/workflow/articles/:id', requireAdminAuth, getWorkflowArticle);

// Stage actions
// PATCH /api/admin/workflow/articles/:id/stage
router.patch('/workflow/articles/:id/stage', requireAdminAuth, patchWorkflowStage);

module.exports = router;
