// Team Management API (TypeScript route file)
// Note: Runtime routing is currently handled by CommonJS mounts in server.js.
// This file exists for Admin Panel feature parity and future TS routing consolidation.

import { Router } from 'express';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { requireAdminAuth, requireFounderAuth } = require('../../../middleware/adminAuth');

const router = Router();

// GET /api/admin/team/users
router.get('/users', requireAdminAuth, async (_req, res) => {
  return res.status(200).json({ ok: true, users: [] });
});

// Mutating endpoints are founder-only by spec (placeholders for future TS consolidation)
router.post('/users', requireFounderAuth, async (_req, res) => {
  return res.status(501).json({ ok: false, status: 501, message: 'Not implemented in TS route file', path: '/api/admin/team/users' });
});

router.patch('/users/:id/status', requireFounderAuth, async (req, res) => {
  return res.status(501).json({ ok: false, status: 501, message: 'Not implemented in TS route file', path: req.originalUrl });
});

router.post('/users/:id/force-reset', requireFounderAuth, async (req, res) => {
  return res.status(501).json({ ok: false, status: 501, message: 'Not implemented in TS route file', path: req.originalUrl });
});

export default router;
