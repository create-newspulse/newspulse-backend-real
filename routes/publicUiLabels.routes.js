const express = require('express');

const { safeTranslateText, normalizeLang } = require('../services/translate/safeTranslate');

const router = express.Router();

const BASE_LABELS_EN = {
  home: 'Home',
  latest: 'Latest',
  national: 'National',
  world: 'World',
  business: 'Business',
  sports: 'Sports',
  entertainment: 'Entertainment',
  technology: 'Technology',
  politics: 'Politics',
  health: 'Health',
  live: 'Live',
  breaking: 'Breaking',
  search: 'Search',
};

function langFromReq(req) {
  return normalizeLang(req.query.lang) || normalizeLang(req.headers['x-lang']) || 'en';
}

// GET /api/public/ui-labels?lang=hi
router.get('/ui-labels', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const targetLang = langFromReq(req);
  if (targetLang === 'en') {
    return res.status(200).json({ lang: 'en', labels: BASE_LABELS_EN });
  }

  const labels = {};
  for (const [k, v] of Object.entries(BASE_LABELS_EN)) {
    const r = await safeTranslateText({
      text: v,
      sourceLang: 'en',
      targetLang,
      context: `ui-label:${k}`,
      strict: false,
    });
    labels[k] = r.text;
  }

  return res.status(200).json({ lang: targetLang, labels });
});

module.exports = router;
