const {
  ingestView,
  ingestEngagement,
  ingestScroll,
  ingestHeartbeat,
} = require('../services/articleAnalytics.service');

function ok(res, data = {}) {
  // Keep response small and cache-unfriendly.
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ ok: true, ...data });
}

function wantsDebug(req) {
  if (String(req.query?.debug || '') === '1') return true;
  const h = String(req.headers['x-analytics-debug'] || '').trim();
  return h === '1' || h.toLowerCase() === 'true';
}

async function postArticleView(req, res) {
  try {
    const result = await ingestView(req, req.body || {});
    return ok(res, wantsDebug(req) ? { skipped: !!result.skipped, reason: result.reason || null } : { skipped: !!result.skipped });
  } catch (e) {
    console.warn('[analytics][view] failed', e?.message || e);
    return ok(res, wantsDebug(req) ? { skipped: true, reason: 'error' } : { skipped: true });
  }
}

async function postArticleEngagement(req, res) {
  try {
    const result = await ingestEngagement(req, req.body || {});
    return ok(res, wantsDebug(req) ? { skipped: !!result.skipped, reason: result.reason || null } : { skipped: !!result.skipped });
  } catch (e) {
    console.warn('[analytics][engagement] failed', e?.message || e);
    return ok(res, wantsDebug(req) ? { skipped: true, reason: 'error' } : { skipped: true });
  }
}

async function postArticleScroll(req, res) {
  try {
    const result = await ingestScroll(req, req.body || {});
    return ok(res, wantsDebug(req) ? { skipped: !!result.skipped, reason: result.reason || null } : { skipped: !!result.skipped });
  } catch (e) {
    console.warn('[analytics][scroll] failed', e?.message || e);
    return ok(res, wantsDebug(req) ? { skipped: true, reason: 'error' } : { skipped: true });
  }
}

async function postArticleHeartbeat(req, res) {
  try {
    const result = await ingestHeartbeat(req, req.body || {});
    return ok(res, wantsDebug(req) ? { skipped: !!result.skipped, reason: result.reason || null } : { skipped: !!result.skipped });
  } catch (e) {
    console.warn('[analytics][heartbeat] failed', e?.message || e);
    return ok(res, wantsDebug(req) ? { skipped: true, reason: 'error' } : { skipped: true });
  }
}

module.exports = {
  postArticleView,
  postArticleEngagement,
  postArticleScroll,
  postArticleHeartbeat,
};
