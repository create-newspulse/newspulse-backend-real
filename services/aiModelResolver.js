const https = require('https');
const mongoose = require('mongoose');

const SETTINGS_KEY = 'ai_models_config';

const OPENAI_ALLOWLIST = ['gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o'];
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

const DEFAULTS = {
  openaiMode: 'auto',
  openaiPinnedModel: 'gpt-5.2',
  geminiMode: 'latest',
  geminiPinnedModel: 'gemini-2.5-pro',
};

const _REASONS = new Set(['auto-refresh', 'manual-refresh', 'settings-change', 'rollback', 'deploy', 'error-fallback']);

const _cache = {
  openai: {
    model: null,
    source: null,
    mode: null,
    pinnedModel: null,
    lastRefreshedAt: null,
    expiresAt: 0,
    lastError: null,
  },
  gemini: {
    model: null,
    fastModel: null,
    source: null,
    mode: null,
    pinnedModel: null,
    lastRefreshedAt: null,
    expiresAt: 0,
    lastError: null,
  },
};

function _now() {
  return Date.now();
}

function _isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function _envLabel() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? 'production' : 'development';
}

function _sanitizeReason(v, fallback = 'auto-refresh') {
  const s = String(v || '').trim();
  return _REASONS.has(s) ? s : fallback;
}

async function _writeChangeLog(entry) {
  // Best-effort only; never block request/resolution.
  try {
    if (!_isDbReady()) return;
    let AiModelChangeLog = null;
    try {
      AiModelChangeLog = require('../models/AiModelChangeLog');
    } catch (_) {
      return;
    }

    await AiModelChangeLog.create(entry);
  } catch (_) {
    // ignore
  }
}

async function _maybeLogChange({ provider, modeBefore, modeAfter, modelBefore, modelAfter, reason, context }) {
  try {
    const before = modelBefore != null ? String(modelBefore) : null;
    const after = modelAfter != null ? String(modelAfter) : null;
    const mBefore = modeBefore != null ? String(modeBefore) : null;
    const mAfter = modeAfter != null ? String(modeAfter) : null;

    const changed = (before !== after) || (mBefore !== mAfter);
    if (!changed) return;
    if (!after) return;

    const changedBy = context && context.changedBy ? context.changedBy : null;
    const ip = context && context.ip ? String(context.ip) : null;

    let finalReason = _sanitizeReason(reason, 'auto-refresh');
    // If this is the first time we ever resolved a model in this process (common after deploy),
    // and we don't have a request/user context, classify as deploy.
    if (!before && after && !changedBy && (finalReason === 'auto-refresh' || finalReason === 'settings-change')) {
      finalReason = 'deploy';
    }

    await _writeChangeLog({
      provider,
      modeBefore: mBefore,
      modeAfter: mAfter,
      modelBefore: before,
      modelAfter: after,
      reason: finalReason,
      env: _envLabel(),
      changedBy: changedBy || undefined,
      ip: ip || undefined,
    });
  } catch (_) {
    // ignore
  }
}

function _isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function _normalizeOpenaiMode(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'pinned' ? 'pinned' : 'auto';
}

function _normalizeGeminiMode(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'pinned' ? 'pinned' : 'latest';
}

async function _readDbConfig() {
  if (!_isDbReady()) return null;
  let SystemSetting = null;
  try {
    SystemSetting = require('../models/SystemSetting');
  } catch (_) {
    return null;
  }

  const doc = await SystemSetting.findOne({ key: SETTINGS_KEY }).lean();
  const value = doc && _isPlainObject(doc.value) ? doc.value : null;
  return value;
}

async function updateAiModelConfig(patch) {
  if (!_isDbReady()) {
    const err = new Error('DB_UNAVAILABLE');
    err.code = 'DB_UNAVAILABLE';
    throw err;
  }
  if (!_isPlainObject(patch)) return;
  let SystemSetting = null;
  try {
    SystemSetting = require('../models/SystemSetting');
  } catch (_) {
    const err = new Error('SYSTEM_SETTING_MODEL_MISSING');
    err.code = 'SYSTEM_SETTING_MODEL_MISSING';
    throw err;
  }

  const existing = await SystemSetting.findOne({ key: SETTINGS_KEY }).lean();
  const prev = existing && _isPlainObject(existing.value) ? existing.value : {};
  const next = { ...prev, ...patch };

  await SystemSetting.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { key: SETTINGS_KEY, value: next } },
    { upsert: true, new: true }
  );
}

function _readEnvConfig() {
  // Backward-compat: OPENAI_MODEL historically pinned the model.
  const legacyOpenaiModel = String(process.env.OPENAI_MODEL || '').trim();
  const openaiModeEnv = String(process.env.OPENAI_MODE || '').trim();

  const openaiMode = openaiModeEnv
    ? _normalizeOpenaiMode(openaiModeEnv)
    : (legacyOpenaiModel ? 'pinned' : null);

  const openaiPinnedModel = String(
    process.env.OPENAI_PINNED_MODEL
    || legacyOpenaiModel
    || ''
  ).trim() || null;

  const geminiMode = process.env.GEMINI_MODE ? _normalizeGeminiMode(process.env.GEMINI_MODE) : null;
  const geminiPinnedModel = String(process.env.GEMINI_PINNED_MODEL || '').trim() || null;

  return {
    ...(openaiMode ? { openaiMode } : {}),
    ...(openaiPinnedModel ? { openaiPinnedModel } : {}),
    ...(geminiMode ? { geminiMode } : {}),
    ...(geminiPinnedModel ? { geminiPinnedModel } : {}),
  };
}

function _normalizeConfig(raw) {
  const src = _isPlainObject(raw) ? raw : {};

  const out = {
    openaiMode: _normalizeOpenaiMode(src.openaiMode || DEFAULTS.openaiMode),
    openaiPinnedModel: String(src.openaiPinnedModel || DEFAULTS.openaiPinnedModel).trim() || DEFAULTS.openaiPinnedModel,
    geminiMode: _normalizeGeminiMode(src.geminiMode || DEFAULTS.geminiMode),
    geminiPinnedModel: String(src.geminiPinnedModel || DEFAULTS.geminiPinnedModel).trim() || DEFAULTS.geminiPinnedModel,
  };

  return out;
}

async function getAiModelConfig() {
  const [db, env] = await Promise.all([
    _readDbConfig(),
    Promise.resolve(_readEnvConfig()),
  ]);

  // Env overrides DB overrides defaults.
  return _normalizeConfig({ ...DEFAULTS, ...(db || {}), ...(env || {}) });
}

function _shouldAvoidExternalCalls() {
  const env = String(process.env.NODE_ENV || 'development').toLowerCase();
  const isNodeTestRunner = Array.isArray(process.argv) && process.argv.includes('--test');
  const npmEvent = String(process.env.npm_lifecycle_event || '').toLowerCase();
  const isTestLifecycle = npmEvent === 'test' || npmEvent.startsWith('test:');
  if (env === 'test') return true;
  if (isNodeTestRunner) return true;
  if (isTestLifecycle) return true;
  if (String(process.env.DISABLE_OPENAI || '').trim() === '1') return true;
  return false;
}

function _fetchJson(url, { headers, timeoutMs = 15_000 } = {}) {
  // Prefer global fetch when available (Node 18+).
  if (typeof fetch === 'function') {
    return (async () => {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
        const text = await res.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = { raw: text };
        }
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} from ${url}`);
          err.status = res.status;
          err.body = json;
          throw err;
        }
        return json;
      } finally {
        clearTimeout(t);
      }
    })();
  }

  // Fallback: https request.
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = { raw: text };
        }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        const err = new Error(`HTTP ${res.statusCode || 0} from ${url}`);
        err.status = res.statusCode;
        err.body = json;
        return reject(err);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'));
    });
    req.end();
  });
}

async function _listOpenAiModelIds() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY not set');
    err.code = 'OPENAI_API_KEY_MISSING';
    throw err;
  }

  const json = await _fetchJson('https://api.openai.com/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  const data = json && Array.isArray(json.data) ? json.data : [];
  return data.map((m) => String(m && m.id ? m.id : '')).filter(Boolean);
}

function _cacheValid(entry) {
  return !!(entry && entry.model && typeof entry.expiresAt === 'number' && entry.expiresAt > _now());
}

async function resolveOpenAIModel({ forceRefresh = false, reason = null, context = null } = {}) {
  const cfg = await getAiModelConfig();

  const prevModel = _cache.openai && _cache.openai.model ? String(_cache.openai.model) : null;
  const prevMode = _cache.openai && _cache.openai.mode ? String(_cache.openai.mode) : null;

  const pinnedModel = String(cfg.openaiPinnedModel || '').trim() || DEFAULTS.openaiPinnedModel;

  if (cfg.openaiMode === 'pinned') {
    const model = pinnedModel;
    _cache.openai = {
      model,
      source: 'pinned',
      mode: 'pinned',
      pinnedModel: model,
      lastRefreshedAt: new Date().toISOString(),
      expiresAt: _now() + CACHE_TTL_MS,
      lastError: null,
    };
    await _maybeLogChange({
      provider: 'openai',
      modeBefore: prevMode,
      modeAfter: 'pinned',
      modelBefore: prevModel,
      modelAfter: model,
      reason: _sanitizeReason(reason, 'settings-change'),
      context,
    });
    return { model, mode: 'pinned', pinnedModel: model, source: 'pinned', lastRefreshedAt: _cache.openai.lastRefreshedAt };
  }

  // auto
  if (!forceRefresh && _cacheValid(_cache.openai) && _cache.openai.mode === 'auto') {
    return {
      model: _cache.openai.model,
      mode: 'auto',
      pinnedModel,
      source: _cache.openai.source || 'cache',
      lastRefreshedAt: _cache.openai.lastRefreshedAt,
      cacheExpiresAt: new Date(_cache.openai.expiresAt).toISOString(),
      lastError: _cache.openai.lastError || null,
    };
  }

  const fallbackModel = String(process.env.OPENAI_FALLBACK_MODEL || '').trim() || 'gpt-5';

  if (_shouldAvoidExternalCalls()) {
    const model = fallbackModel;
    _cache.openai = {
      model,
      source: 'fallback-disabled',
      mode: 'auto',
      pinnedModel,
      lastRefreshedAt: new Date().toISOString(),
      expiresAt: _now() + CACHE_TTL_MS,
      lastError: null,
    };
    await _maybeLogChange({
      provider: 'openai',
      modeBefore: prevMode,
      modeAfter: 'auto',
      modelBefore: prevModel,
      modelAfter: model,
      reason: _sanitizeReason(reason, 'auto-refresh'),
      context,
    });
    return { model, mode: 'auto', pinnedModel, source: 'fallback-disabled', lastRefreshedAt: _cache.openai.lastRefreshedAt };
  }

  try {
    const ids = await _listOpenAiModelIds();
    const set = new Set(ids);

    let picked = null;
    for (const candidate of OPENAI_ALLOWLIST) {
      if (set.has(candidate)) {
        picked = candidate;
        break;
      }
    }

    const model = picked || fallbackModel;
    _cache.openai = {
      model,
      source: picked ? 'models-api' : 'fallback-no-match',
      mode: 'auto',
      pinnedModel,
      lastRefreshedAt: new Date().toISOString(),
      expiresAt: _now() + CACHE_TTL_MS,
      lastError: null,
    };

    await _maybeLogChange({
      provider: 'openai',
      modeBefore: prevMode,
      modeAfter: 'auto',
      modelBefore: prevModel,
      modelAfter: model,
      reason: _sanitizeReason(reason, 'auto-refresh'),
      context,
    });

    return {
      model,
      mode: 'auto',
      pinnedModel,
      source: _cache.openai.source,
      allowlist: OPENAI_ALLOWLIST.slice(),
      lastRefreshedAt: _cache.openai.lastRefreshedAt,
      cacheExpiresAt: new Date(_cache.openai.expiresAt).toISOString(),
      lastError: null,
    };
  } catch (e) {
    const model = fallbackModel;
    _cache.openai = {
      model,
      source: 'fallback-error',
      mode: 'auto',
      pinnedModel,
      lastRefreshedAt: new Date().toISOString(),
      expiresAt: _now() + CACHE_TTL_MS,
      lastError: e && e.message ? String(e.message) : String(e),
    };

    await _maybeLogChange({
      provider: 'openai',
      modeBefore: prevMode,
      modeAfter: 'auto',
      modelBefore: prevModel,
      modelAfter: model,
      reason: 'error-fallback',
      context,
    });
    return {
      model,
      mode: 'auto',
      pinnedModel,
      source: 'fallback-error',
      lastRefreshedAt: _cache.openai.lastRefreshedAt,
      cacheExpiresAt: new Date(_cache.openai.expiresAt).toISOString(),
      lastError: _cache.openai.lastError,
    };
  }
}

async function resolveGeminiModels({ forceRefresh = false, reason = null, context = null } = {}) {
  const cfg = await getAiModelConfig();

  const prevModel = _cache.gemini && _cache.gemini.model ? String(_cache.gemini.model) : null;
  const prevMode = _cache.gemini && _cache.gemini.mode ? String(_cache.gemini.mode) : null;

  if (!forceRefresh && _cacheValid(_cache.gemini) && _cache.gemini.mode === cfg.geminiMode) {
    return {
      model: _cache.gemini.model,
      fastModel: _cache.gemini.fastModel,
      mode: _cache.gemini.mode,
      pinnedModel: _cache.gemini.pinnedModel,
      source: _cache.gemini.source || 'cache',
      lastRefreshedAt: _cache.gemini.lastRefreshedAt,
      cacheExpiresAt: new Date(_cache.gemini.expiresAt).toISOString(),
      lastError: _cache.gemini.lastError || null,
    };
  }

  const pinnedModel = String(cfg.geminiPinnedModel || '').trim() || DEFAULTS.geminiPinnedModel;

  const model = cfg.geminiMode === 'pinned' ? pinnedModel : 'gemini-pro-latest';
  const fastModel = cfg.geminiMode === 'pinned' ? pinnedModel : 'gemini-flash-latest';

  _cache.gemini = {
    model,
    fastModel,
    source: cfg.geminiMode === 'pinned' ? 'pinned' : 'latest-alias',
    mode: cfg.geminiMode,
    pinnedModel,
    lastRefreshedAt: new Date().toISOString(),
    expiresAt: _now() + CACHE_TTL_MS,
    lastError: null,
  };

  await _maybeLogChange({
    provider: 'gemini',
    modeBefore: prevMode,
    modeAfter: cfg.geminiMode,
    modelBefore: prevModel,
    modelAfter: model,
    reason: _sanitizeReason(reason, 'settings-change'),
    context,
  });

  return {
    model,
    fastModel,
    mode: cfg.geminiMode,
    pinnedModel,
    source: _cache.gemini.source,
    lastRefreshedAt: _cache.gemini.lastRefreshedAt,
    cacheExpiresAt: new Date(_cache.gemini.expiresAt).toISOString(),
    lastError: null,
  };
}

async function getAiModelsStatus({ forceRefresh = false, reason = null, context = null } = {}) {
  const cfg = await getAiModelConfig();
  const [openai, gemini] = await Promise.all([
    resolveOpenAIModel({ forceRefresh, reason, context }),
    resolveGeminiModels({ forceRefresh, reason, context }),
  ]);

  const openaiAt = openai && openai.lastRefreshedAt ? Date.parse(openai.lastRefreshedAt) : 0;
  const geminiAt = gemini && gemini.lastRefreshedAt ? Date.parse(gemini.lastRefreshedAt) : 0;
  const last = Math.max(openaiAt || 0, geminiAt || 0);

  return {
    // Required top-level fields for admin panel
    openaiMode: cfg.openaiMode,
    openaiPinnedModel: cfg.openaiPinnedModel,
    lastOpenAIRefreshAt: openai.lastRefreshedAt || null,
    resolvedOpenAIModel: openai.model,
    geminiMode: cfg.geminiMode,
    geminiPinnedModel: cfg.geminiPinnedModel,
    lastGeminiRefreshAt: gemini.lastRefreshedAt || null,
    resolvedGeminiModel: gemini.model,
    modes: {
      openaiMode: cfg.openaiMode,
      geminiMode: cfg.geminiMode,
    },
    lastRefreshedAt: last ? new Date(last).toISOString() : null,
    openai: {
      mode: cfg.openaiMode,
      pinnedModel: cfg.openaiPinnedModel,
      resolvedModel: openai.model,
      source: openai.source || null,
      allowlist: openai.allowlist || OPENAI_ALLOWLIST.slice(),
      lastRefreshedAt: openai.lastRefreshedAt || null,
      cacheExpiresAt: openai.cacheExpiresAt || null,
      lastError: openai.lastError || null,
    },
    gemini: {
      mode: cfg.geminiMode,
      pinnedModel: cfg.geminiPinnedModel,
      resolvedModel: gemini.model,
      resolvedFastModel: gemini.fastModel,
      source: gemini.source || null,
      lastRefreshedAt: gemini.lastRefreshedAt || null,
      cacheExpiresAt: gemini.cacheExpiresAt || null,
      lastError: gemini.lastError || null,
    },
  };
}

async function refreshAiModels({ reason = 'manual-refresh', context = null } = {}) {
  return getAiModelsStatus({ forceRefresh: true, reason, context });
}

module.exports = {
  SETTINGS_KEY,
  OPENAI_ALLOWLIST,
  CACHE_TTL_MS,
  getAiModelConfig,
  updateAiModelConfig,
  resolveOpenAIModel,
  resolveGeminiModels,
  getAiModelsStatus,
  refreshAiModels,
};
