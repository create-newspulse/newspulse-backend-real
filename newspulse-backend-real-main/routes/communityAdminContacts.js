const express = require('express');
// Use middleware from root workspace (one level above nested project)
const { requireAdminAuth } = require('../../middleware/adminAuth');

const router = express.Router();

// Admin reporter contacts (stub/minimal) - mirrors root implementation placeholder
router.get('/reporter-contacts', requireAdminAuth, async (req, res) => {
  try {
    // For now return empty list; real aggregation lives in root app.
    return res.json({
      ok: true,
      success: true,
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    });
  } catch (err) {
    console.error('[nested][reporter-contacts] error', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load community contacts' });
  }
});

// List stories for a single reporter (stub)
router.get('/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const reporterKey = String(req.query.reporterKey || '').trim();
    if (!reporterKey) {
      return res.status(400).json({ ok: false, message: 'Missing reporterKey' });
    }
    return res.json({ ok: true, items: [], total: 0 });
  } catch (err) {
    console.error('[nested][reporter-stories] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter stories' });
  }
});

module.exports = router;
