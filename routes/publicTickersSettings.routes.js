const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const SiteSetting = require('../models/SiteSetting');
const { DEFAULT_TICKERS_CONFIG, TickersConfigSchema } = require('../schemas/tickersConfig.schema');

const router = express.Router();

const SCOPE = 'public';
const KEY = 'tickers';

function isDbConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function getPreviewSecret() {
  return String(process.env.UI_PREVIEW_SECRET || '').trim();
}

async function getLatestPublished() {
  return SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'published' }).sort({ version: -1, createdAt: -1 });
}

async function getDraft() {
  return SiteSetting.findOne({ scope: SCOPE, key: KEY, status: 'draft' });
}

// GET /api/public/settings/tickers
// GET /api/public/settings/tickers?preview=TOKEN
router.get('/settings/tickers', async (req, res) => {
  try {
    const previewToken = String(req.query.preview || '').trim();

    // Preview mode: valid token -> return draft (no cache)
    if (previewToken) {
      const secret = getPreviewSecret();
      if (!secret) {
        return res.status(400).json({ ok: false, success: false, status: 400, message: 'UI_PREVIEW_SECRET missing' });
      }

      let payload = null;
      try {
        payload = jwt.verify(previewToken, secret);
      } catch (e) {
        return res.status(401).json({ ok: false, success: false, message: 'Invalid preview token' });
      }

      if (!payload || payload.type !== 'ui_preview' || payload.scope !== SCOPE || payload.key !== KEY) {
        return res.status(401).json({ ok: false, success: false, message: 'Invalid preview token' });
      }

      res.set('Cache-Control', 'no-store');

      if (!isDbConnected()) {
        return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, data: DEFAULT_TICKERS_CONFIG, source: 'default' });
      }

      const draft = await getDraft();
      const data = draft && draft.data ? draft.data : DEFAULT_TICKERS_CONFIG;

      // Safety: never emit invalid configs
      const parsed = TickersConfigSchema.safeParse(data);
      if (!parsed.success) {
        return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, data: DEFAULT_TICKERS_CONFIG, source: 'default' });
      }

      return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, data: parsed.data, source: draft ? 'draft' : 'default' });
    }

    // Normal public mode: published-only + cache headers
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    if (!isDbConnected()) {
      return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, data: DEFAULT_TICKERS_CONFIG, source: 'default' });
    }

    const published = await getLatestPublished();
    const data = published && published.data ? published.data : DEFAULT_TICKERS_CONFIG;

    // Safety: never emit invalid configs
    const parsed = TickersConfigSchema.safeParse(data);
    if (!parsed.success) {
      return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, data: DEFAULT_TICKERS_CONFIG, source: 'default' });
    }

    return res.json({ ok: true, success: true, status: 200, scope: SCOPE, key: KEY, data: parsed.data, source: published ? 'published' : 'default' });
  } catch (e) {
    console.error('[public][settings/tickers] error', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load tickers settings' });
  }
});

module.exports = router;

/*
Curl examples:

# Published (cached)
curl -i "http://localhost:5000/api/public/settings/tickers"

# Preview draft (no-cache)
curl -i "http://localhost:5000/api/public/settings/tickers?preview=<TOKEN>"
*/
