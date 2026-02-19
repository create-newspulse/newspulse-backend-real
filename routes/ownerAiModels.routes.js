const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../middleware/adminAuth');
const { requireOwnerKey } = require('../middleware/requireOwnerKey');
const { getAiModelsStatus, refreshAiModels, updateAiModelConfig } = require('../services/aiModelResolver');

let AiModelChangeLog = null;
try { AiModelChangeLog = require('../models/AiModelChangeLog'); } catch (_) {}

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function getRequestIp(req) {
  const xfwd = String(req.headers['x-forwarded-for'] || '').trim();
  if (xfwd) return xfwd.split(',')[0].trim();
  return String(req.ip || '').trim() || null;
}

function getChangedBy(req) {
  if (req && req.admin) {
    return {
      userId: req.admin.id ? String(req.admin.id) : null,
      email: req.admin.email ? String(req.admin.email) : null,
      role: req.admin.role ? String(req.admin.role) : null,
    };
  }
  if (req && req.ownerKey) {
    return {
      userId: req.ownerKey.ownerId ? String(req.ownerKey.ownerId) : null,
      email: null,
      role: 'founder',
    };
  }
  return null;
}

function requireFounderOrOwner(req, res, next) {
  // 1) Try founder via admin auth (Bearer/cookie). Swallow failures.
  return requireAdminAuth(
    req,
    {
      status: () => ({ json: () => {
        // If admin auth fails, fallback to owner key.
        return requireOwnerKey(req, res, next);
      }}),
      json: () => {
        // If admin auth fails, fallback to owner key.
        return requireOwnerKey(req, res, next);
      },
    },
    () => {
      const role = String(req.admin && req.admin.role ? req.admin.role : '').toLowerCase();
      if (role === 'founder') return next();

      // 2) If authenticated but not founder, only allow if owner key cookie exists/valid.
      const hasOwnerCookie = String(req.headers.cookie || '').includes('owner_key=');
      if (!hasOwnerCookie) {
        return res.status(403).json({ ok: false, success: false, status: 403, code: 'FORBIDDEN', message: 'Forbidden' });
      }
      return requireOwnerKey(req, res, next);
    }
  );
}

function bad(res, status, message, code = null) {
  return res.status(status).json({ ok: false, success: false, status, code: code || undefined, message });
}

function ok(res, data) {
  return res.status(200).json({ ok: true, success: true, status: 200, data });
}

function normalizeProvider(raw) {
  const p = String(raw || '').trim().toLowerCase();
  if (p === 'openai' || p === 'gemini') return p;
  return null;
}

function sanitizePinnedModel(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.length > 120) return null;
  return s;
}

// GET /admin-api/owner/ai-model-log?provider=openai|gemini&limit=50
router.get('/ai-model-log', requireFounderOrOwner, async (req, res) => {
  try {
    const provider = normalizeProvider(req.query.provider);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 200);

    if (!provider) return bad(res, 400, 'Invalid provider', 'INVALID_PROVIDER');

    if (!isDbReady() || !AiModelChangeLog) {
      return ok(res, { provider, items: [], message: 'Database unavailable' });
    }

    const docs = await AiModelChangeLog.find({ provider }).sort({ createdAt: -1 }).limit(limit).lean();
    return ok(res, { provider, items: docs });
  } catch (e) {
    console.error('[owner][ai-model-log] failed', e?.message || e);
    return bad(res, 500, 'Failed to load AI model change log', 'LOAD_FAILED');
  }
});

// POST /admin-api/owner/ai-model-rollback
// Body: { provider: "openai"|"gemini", pinnedModel: string }
router.post('/ai-model-rollback', requireFounderOrOwner, async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const provider = normalizeProvider(body.provider);
    const pinnedModel = sanitizePinnedModel(body.pinnedModel);

    if (!provider) return bad(res, 400, 'Invalid provider', 'INVALID_PROVIDER');
    if (!pinnedModel) return bad(res, 400, 'Invalid pinnedModel', 'INVALID_PINNED_MODEL');

    if (!isDbReady()) return bad(res, 503, 'Database unavailable', 'DB_UNAVAILABLE');

    const patch = provider === 'openai'
      ? { openaiMode: 'pinned', openaiPinnedModel: pinnedModel }
      : { geminiMode: 'pinned', geminiPinnedModel: pinnedModel };

    const ctx = { changedBy: getChangedBy(req), ip: getRequestIp(req) };

    await updateAiModelConfig(patch);

    const status = await refreshAiModels({ reason: 'rollback', context: ctx });
    return res.status(200).json({ ok: true, success: true, status: 200, ...status });
  } catch (e) {
    console.error('[owner][ai-model-rollback] failed', e?.message || e);
    return bad(res, 500, 'Failed to rollback AI model', 'ROLLBACK_FAILED');
  }
});

// Optional: owner view of current status (Safe Owner Zone screen can reuse)
router.get('/ai-model-status', requireFounderOrOwner, async (req, res) => {
  try {
    const ctx = { changedBy: getChangedBy(req), ip: getRequestIp(req) };
    const status = await getAiModelsStatus({ forceRefresh: false, reason: 'auto-refresh', context: ctx });
    return res.status(200).json({ ok: true, success: true, status: 200, ...status });
  } catch (e) {
    console.error('[owner][ai-model-status] failed', e?.message || e);
    return bad(res, 500, 'Failed to resolve AI models', 'STATUS_FAILED');
  }
});

module.exports = router;
