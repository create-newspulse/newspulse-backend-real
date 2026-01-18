const express = require('express');

const router = express.Router();

// GET /api/public/translation/health
router.get('/health', (_req, res) => {
  const googleConfigured = !!String(process.env.GOOGLE_TRANSLATE_API_KEY || '').trim();
  const cacheEnabled = String(process.env.TRANSLATION_CACHE_ENABLED || '1').trim() !== '0';
  const safeMode = String(process.env.TRANSLATION_SAFE_MODE || '1').trim() !== '0';

  return res.status(200).json({
    googleConfigured,
    cacheEnabled,
    safeMode,
  });
});

module.exports = router;
