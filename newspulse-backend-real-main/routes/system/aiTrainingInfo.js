const express = require('express');
const router = express.Router();

function _hasNonEmpty(v) {
  return !!String(v || '').trim();
}

// When mounted at /system/ai-training-info, respond at the root
router.get('/', (_req, res) => {
  const hasUrl = _hasNonEmpty(process.env.COMMUNITY_AI_URL);
  const hasKey = _hasNonEmpty(process.env.COMMUNITY_AI_API_KEY);
  const enabled = hasUrl && hasKey;

  if (!enabled) {
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      enabled: false,
      message: 'AI not configured',
      data: {
        hasUrl,
        hasKey,
        lastUpdated: null,
        sources: [],
        notes: '',
      },
    });
  }

  return res.status(200).json({
    ok: true,
    success: true,
    status: 200,
    message: 'AI training info',
    data: {
      mode: 'online',
      lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString(),
      notes: 'Admin panel using unified backend.',
    },
  });
});

module.exports = router;
