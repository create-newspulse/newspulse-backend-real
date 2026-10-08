const {
  ingestView,
  ingestEngagement,
  ingestScroll,
  ingestHeartbeat,
} = require('../services/articleAnalytics.service');

function respond(req, res, result) {
  if (result.reason === 'db-not-ready') return fail(req, res, 503);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    skipped: !!result.skipped,
    ...(wantsDebug(req) ? { reason: result.reason || null } : {}),
  });
}

function wantsDebug(req) {
  if (String(req.query?.debug || '') === '1') return true;
  const h = String(req.headers['x-analytics-debug'] || '').trim();
  return h === '1' || h.toLowerCase() === 'true';
}

function fail(req, res, statusCode) {
  const unavailable = statusCode === 503;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(statusCode).json({
    ok: false,
    skipped: true,
    message: unavailable ? 'Analytics temporarily unavailable' : 'Failed to record analytics event',
    ...(wantsDebug(req) ? { reason: unavailable ? 'db-not-ready' : 'error' } : {}),
  });
}

async function postArticleView(req, res) {
  try {
    const result = await ingestView(req, req.body || {});
    return respond(req, res, result);
  } catch (_) {
    console.warn('[analytics][view] failed');
    return fail(req, res, 500);
  }
}

async function postArticleEngagement(req, res) {
  try {
    const result = await ingestEngagement(req, req.body || {});
    return respond(req, res, result);
  } catch (_) {
    console.warn('[analytics][engagement] failed');
    return fail(req, res, 500);
  }
}

async function postArticleScroll(req, res) {
  try {
    const result = await ingestScroll(req, req.body || {});
    return respond(req, res, result);
  } catch (_) {
    console.warn('[analytics][scroll] failed');
    return fail(req, res, 500);
  }
}

async function postArticleHeartbeat(req, res) {
  try {
    const result = await ingestHeartbeat(req, req.body || {});
    return respond(req, res, result);
  } catch (_) {
    console.warn('[analytics][heartbeat] failed');
    return fail(req, res, 500);
  }
}

module.exports = {
  postArticleView,
  postArticleEngagement,
  postArticleScroll,
  postArticleHeartbeat,
};
