const express = require('express');
const router = express.Router();
const News = require('../models/News');
const { getRequestedLocale, localizeDocStrict } = require('../services/publicStoryLocale.service');
const { buildLocaleEligibilityMatch } = require('../services/publicStoryGroupResolver.service');

// GET /api/feed/for-you
router.get('/for-you', async (req, res) => {
  try {
    const rawLimit = parseInt(req.query.limit || '15', 10);
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const language = getRequestedLocale(req, { defaultLocale: 'en' });
    const region = String(req.query.region || '').toLowerCase();

    const filter = {};
    // Only add filters if fields exist in schema
    if (News.schema.paths.language && language) filter.language = language;
    if (News.schema.paths.status) filter.status = 'published';
    // Region not present in schema currently; ignore for now

    const eligible = buildLocaleEligibilityMatch(language);
    if (eligible) filter.$and = (filter.$and || []).concat([eligible]);

    const items = await News.find(filter).sort({ createdAt: -1, date: -1 }).limit(limit).lean();
    const mapped = (items || [])
      .map((doc) => {
        const localized = localizeDocStrict(doc, language, {
          mode: 'list',
          logger: console,
          logContext: { endpoint: 'GET /api/feed/for-you', region: region || null },
        });
        if (!localized) return null;
        return {
          _id: String(doc._id),
          title: localized.title,
          description: localized.description,
          imageUrl: doc.imageURL || doc.imageUrl || null,
          category: doc.category || null,
          publishedAt: doc.date || doc.createdAt || null,
        };
      })
      .filter(Boolean);

    return res.json({ ok: true, items: mapped, total: mapped.length });
  } catch (e) {
    console.error('[FEED][for-you] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load personalized feed.' });
  }
});

module.exports = router;
