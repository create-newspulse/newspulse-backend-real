const mongoose = require('mongoose');

const PushHistory = require('../../../models/PushHistory');

function ok(res, message, data, status = 200) {
  return res.status(status).json({ ok: true, success: true, status, message, data });
}

function bad(res, message, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, success: false, status, message, data: null, ...extra });
}

function isFounder(req) {
  const roleRaw = String(req.admin && req.admin.role || 'admin').toLowerCase();
  return roleRaw === 'founder';
}

async function listPushHistory(req, res) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return ok(res, 'Push history fetched', { items: [], page: 1, limit: 50, total: 0 });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const skip = (page - 1) * limit;

    const filter = {};
    const type = String(req.query.type || '').trim();
    if (type) filter.type = type;

    const articleId = String(req.query.articleId || '').trim();
    if (articleId) {
      if (!mongoose.isValidObjectId(articleId)) return bad(res, 'Invalid articleId', 400);
      filter.articleId = articleId;
    }

    const [rows, total] = await Promise.all([
      PushHistory.find(filter).sort({ at: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      PushHistory.countDocuments(filter),
    ]);

    const items = (rows || []).map((p) => ({
      id: String(p._id),
      articleId: String(p.articleId),
      type: p.type ?? null,
      action: p.action ?? null,
      titleSnapshot: p.titleSnapshot ?? p.title ?? null,
      slugSnapshot: p.slugSnapshot ?? p.slug ?? null,
      language: p.language ?? null,
      category: p.category ?? null,
      pushedTo: p.pushedTo ?? 'PUBLIC_SITE',
      status: p.status,
      error: p.error ?? null,
      at: p.at,
      by: p.by ?? p.byUserId ?? null,
      meta: p.meta ?? null,
    }));

    return ok(res, 'Push history fetched', { items, page, limit, total });
  } catch (e) {
    console.error('[pushHistory.list] error', e?.message || e);
    return bad(res, 'Failed to load push history', 500);
  }
}

// DELETE /api/admin/push-history (founder only)
async function deleteAllPushHistory(req, res) {
  try {
    if (!isFounder(req)) return bad(res, 'Forbidden', 403);

    if (mongoose.connection.readyState !== 1) {
      return bad(res, 'Database not connected', 503);
    }

    const result = await PushHistory.deleteMany({});
    return ok(res, 'Push history cleared', { deletedCount: result?.deletedCount ?? 0 });
  } catch (e) {
    console.error('[pushHistory.deleteAll] error', e?.message || e);
    return bad(res, 'Failed to clear push history', 500);
  }
}

module.exports = {
  listPushHistory,
  deleteAllPushHistory,
};
