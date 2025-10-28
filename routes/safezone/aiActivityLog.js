// routes/safezone/aiActivityLog.js
// Returns lightweight AI activity metrics for the Admin panel.
// Safe for schemas that don't yet include the AI-specific fields; it will return zeros.

const express = require('express');
const router = express.Router();

let News = null;
try {
  News = require('../../models/News');
} catch (_) {
  // model not found; we will fall back to zeros
}

const countDocs = async (query) => {
  if (!News) return 0;
  try { return await News.countDocuments(query); } catch { return 0; }
};

router.get('/', async (_req, res) => {
  try {
    // Your current schema (models/News.js) doesn't have AI marker fields.
    // We'll compute zeros by default; adjust these predicates if/when you add fields.
    const [autoPublished, flagged, suggestedHeadlines] = await Promise.all([
      countDocs({ publishedBy: 'AI' }),          // field may not exist → 0
      countDocs({ isFlagged: true }),            // field may not exist → 0
      countDocs({ isSuggested: true }),          // field may not exist → 0
    ]);

    res.status(200).json({
      autoPublished: autoPublished || 0,
      flagged: flagged || 0,
      suggestedHeadlines: suggestedHeadlines || 0,
      lastTrustUpdate: new Date().toISOString(),
    });
  } catch (err) {
    console.error('ai-activity-log error:', err?.stack || err?.message || err);
    // Soft-success zeros so UI stays clean even if DB hiccups.
    res.status(200).json({
      autoPublished: 0,
      flagged: 0,
      suggestedHeadlines: 0,
      lastTrustUpdate: new Date(0).toISOString(),
    });
  }
});

module.exports = router;
