const { computePublicEnabled, listItemsLast24hByChannel, getOrCreateSettings, adminSettingsResponse } = require('./broadcastCenter.service');
const { getBroadcastVersion, bumpBroadcastVersion } = require('./broadcastVersion.service');
const googleTranslate = require('./googleTranslate.service');
const mongoose = require('mongoose');
const BroadcastItem = require('../models/BroadcastItem');
const { isGoogleTranslateConfigured } = require('./translationEnabled');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function normalizeLangOrNull(v) {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return null;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : null;
}

function normalizeLang(v, fallback = 'gu') {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return fallback;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : fallback;
}

function resolvePublicText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = normalizeLang(lang, 'gu');

  // IMPORTANT: never fall back to a different language in the response.
  // If target text is missing, callers should translate (and cache) or return original.
  const bucket = d.i18n && typeof d.i18n === 'object' ? d.i18n[target] : null;
  if (bucket && typeof bucket.text === 'string' && bucket.text.trim()) return String(bucket.text).trim();

  const legacyI18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  if (legacyI18n && typeof legacyI18n[target] === 'string' && legacyI18n[target].trim()) return String(legacyI18n[target]).trim();

  const legacyTranslations = d.translations && typeof d.translations === 'object' ? d.translations : null;
  if (legacyTranslations && typeof legacyTranslations[target] === 'string' && legacyTranslations[target].trim()) return String(legacyTranslations[target]).trim();

  return typeof d.text === 'string' ? String(d.text).trim() : '';
}

// Snapshot cache: key -> { exp, payload }
const _snapshotCache = new Map();
const DEFAULT_SNAPSHOT_TTL_MS = 30 * 1000;

function snapshotTtlMs() {
  const v = Number(process.env.PUBLIC_BROADCAST_SNAPSHOT_CACHE_TTL_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_SNAPSHOT_TTL_MS;
}

function getSnapshotCacheKey({ lang, version }) {
  return `broadcast:snapshot:${String(version ?? 0)}:${normalizeLang(lang, 'gu')}`;
}

function getSnapshotCached(key) {
  const hit = _snapshotCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) {
    _snapshotCache.delete(key);
    return null;
  }
  return hit.payload;
}

function setSnapshotCached(key, payload) {
  _snapshotCache.set(key, { exp: Date.now() + snapshotTtlMs(), payload });
}

function pickLangText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const l = normalizeLang(lang, 'gu');
  const bucket = d.i18n && typeof d.i18n === 'object' ? d.i18n[l] : null;
  if (bucket && typeof bucket.text === 'string' && bucket.text.trim()) return String(bucket.text).trim();
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const from = (obj) => (obj && typeof obj[l] === 'string' && obj[l].trim() ? String(obj[l]).trim() : null);
  return from(i18n) || from(legacy);
}

function pickSourceText(doc) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const src = normalizeLangOrNull(d.lang) || normalizeLangOrNull(d.sourceLang) || normalizeLangOrNull(d.language);
  if (src) {
    const srcBucket = d.i18n && typeof d.i18n === 'object' ? d.i18n[src] : null;
    if (srcBucket && typeof srcBucket.text === 'string' && srcBucket.text.trim()) return String(srcBucket.text).trim();
    const srcLegacy = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
    if (srcLegacy && typeof srcLegacy[src] === 'string' && srcLegacy[src].trim()) return String(srcLegacy[src]).trim();
  }

  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const pick =
    (d.i18n && typeof d.i18n === 'object' && d.i18n.gu && typeof d.i18n.gu.text === 'string' && d.i18n.gu.text.trim() ? d.i18n.gu.text : null) ||
    (d.i18n && typeof d.i18n === 'object' && d.i18n.hi && typeof d.i18n.hi.text === 'string' && d.i18n.hi.text.trim() ? d.i18n.hi.text : null) ||
    (d.i18n && typeof d.i18n === 'object' && d.i18n.en && typeof d.i18n.en.text === 'string' && d.i18n.en.text.trim() ? d.i18n.en.text : null) ||
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (legacy && typeof legacy.gu === 'string' && legacy.gu.trim() ? legacy.gu : null) ||
    (i18n && typeof i18n.hi === 'string' && i18n.hi.trim() ? i18n.hi : null) ||
    (legacy && typeof legacy.hi === 'string' && legacy.hi.trim() ? legacy.hi : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');
  return String(pick || '').trim();
}

function _isRateLimitErrorMessage(msg) {
  return /(rate\s*limit\s*exceeded|too\s*many\s*requests|resource\s*exhausted|http[_\s-]*429|\b429\b)/i.test(String(msg || ''));
}

function _addMinutes(d, minutes) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Date(dt.getTime() + (minutes * 60 * 1000));
}

function _canWriteDb() {
  // Avoid Mongoose buffering/hanging in test/import mode.
  const env = String(process.env.NODE_ENV || '').trim().toLowerCase();
  if (env === 'test') return false;
  return Boolean(mongoose.connection && mongoose.connection.readyState === 1);
}

function _getI18nBucket(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const l = normalizeLangOrNull(lang);
  if (!l) return null;
  const i18n = d.i18n && typeof d.i18n === 'object' ? d.i18n : null;
  const b = i18n && typeof i18n[l] === 'object' ? i18n[l] : null;
  return b && !Array.isArray(b) ? b : null;
}

async function resolveTextsWithTranslation(docs, targetLang) {
  const dst = normalizeLang(targetLang, 'gu');
  const items = Array.isArray(docs) ? docs : [];

  const now = new Date();

  // Start with stored translation (canonical i18n -> legacy).
  const resolved = items.map((d) => pickLangText(d, dst));

  // Identify which items need translation.
  const needs = [];
  for (let i = 0; i < items.length; i++) {
    const d = items[i];
    const srcLang =
      normalizeLangOrNull(d?.lang) ||
      normalizeLangOrNull(d?.sourceLang) ||
      normalizeLangOrNull(d?.language) ||
      (pickLangText(d, 'gu') ? 'gu' : (pickLangText(d, 'hi') ? 'hi' : (pickLangText(d, 'en') ? 'en' : null))) ||
      'gu';

    const srcText = pickSourceText(d);
    const t = resolved[i];

    // If we have target stored, or no source, just use what we have.
    if (typeof t === 'string' && t.trim()) continue;
    if (!srcText) {
      resolved[i] = '';
      continue;
    }

    // If target is the source lang, return original.
    if (dst === srcLang) {
      resolved[i] = srcText;
      continue;
    }

    // Cooldown/locking state from canonical bucket only.
    const bucket = _getI18nBucket(d, dst);
    const status = bucket && typeof bucket.status === 'string' ? bucket.status : null;
    const retryAtRaw = bucket ? bucket.nextRetryAt : null;
    const retryAt = retryAtRaw ? new Date(retryAtRaw) : null;

    if (status === 'pending' || (status === 'failed' && retryAt && now < retryAt)) {
      resolved[i] = srcText;
      continue;
    }

    // Translation disabled/misconfigured: return original.
    if (!isGoogleTranslateConfigured()) {
      resolved[i] = srcText;
      continue;
    }

    needs.push({ idx: i, id: d && d._id ? String(d._id) : null, srcLang, srcText });
    resolved[i] = srcText;
  }

  if (!needs.length) return resolved;

  // Acquire atomic locks (best-effort). If DB isn't writable, translate without persisting.
  const lockable = [];
  if (_canWriteDb()) {
    for (const n of needs) {
      if (!n.id) continue;
      try {
        const lockRes = await BroadcastItem.updateOne(
          {
            _id: n.id,
            $and: [
              { [`i18n.${dst}.status`]: { $ne: 'pending' } },
              {
                $or: [
                  { [`i18n.${dst}.status`]: { $ne: 'failed' } },
                  { [`i18n.${dst}.nextRetryAt`]: { $exists: false } },
                  { [`i18n.${dst}.nextRetryAt`]: null },
                  { [`i18n.${dst}.nextRetryAt`]: { $lte: now } },
                ],
              },
            ],
          },
          {
            $set: {
              [`i18n.${dst}.status`]: 'pending',
              [`i18n.${dst}.error`]: null,
              [`i18n.${dst}.nextRetryAt`]: null,
              [`i18n.${dst}.updatedAt`]: now,
            },
          }
        );

        const modified = typeof lockRes?.modifiedCount === 'number'
          ? lockRes.modifiedCount
          : (typeof lockRes?.nModified === 'number' ? lockRes.nModified : 0);
        if (modified === 1) lockable.push(n);
      } catch (_) {
        // ignore
      }
    }
  } else {
    lockable.push(...needs);
  }

  if (!lockable.length) return resolved;

  // Group by source lang so we can pass sourceLang to the API.
  const groups = new Map();
  for (const n of lockable) {
    const k = normalizeLangOrNull(n.srcLang) || 'auto';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }

  for (const [srcLang, arr] of groups.entries()) {
    const texts = arr.map((n) => String(n.srcText || '').trim().slice(0, 160));
    let tr = null;
    try {
      tr = await googleTranslate.translateMany(texts, dst, { ...(srcLang !== 'auto' ? { sourceLang: srcLang } : {}) });
    } catch (e) {
      tr = { ok: false, error: e?.message || String(e) };
    }

    if (!tr || tr.ok !== true || !Array.isArray(tr.items) || tr.items.length !== texts.length) {
      const errMsg = tr && tr.error ? tr.error : 'Translate failed';
      const isRateLimit = _isRateLimitErrorMessage(errMsg);
      if (_canWriteDb()) {
        await Promise.all(arr.map(async (n) => {
          if (!n.id) return;
          try {
            await BroadcastItem.updateOne(
              { _id: n.id },
              {
                $set: {
                  [`i18n.${dst}.status`]: 'failed',
                  [`i18n.${dst}.error`]: errMsg,
                  [`i18n.${dst}.nextRetryAt`]: isRateLimit ? _addMinutes(now, 30) : null,
                  [`i18n.${dst}.updatedAt`]: now,
                },
              }
            );
          } catch (_) {}
        }));
      }
      continue;
    }

    // Persist + apply to response.
    const writes = [];
    for (let j = 0; j < arr.length; j++) {
      const n = arr[j];
      const translated = typeof tr.items[j] === 'string' ? tr.items[j].trim().slice(0, 160) : '';
      if (!translated) continue;

      resolved[n.idx] = translated;

      if (_canWriteDb() && n.id) {
        writes.push(
          BroadcastItem.updateOne(
            { _id: n.id },
            {
              $set: {
                [`i18n.${dst}.text`]: translated,
                [`i18n.${dst}.status`]: 'ready',
                [`i18n.${dst}.error`]: null,
                [`i18n.${dst}.nextRetryAt`]: null,
                [`i18n.${dst}.updatedAt`]: now,
                // Backward-compat caches
                [`text_i18n.${dst}`]: translated,
                [`translations.${dst}`]: translated,
                [`textByLang.${dst}`]: translated,
              },
            }
          ).catch(() => null)
        );
      }
    }

    if (writes.length) await Promise.all(writes);
  }

  return resolved;
}

async function buildBroadcastSnapshot({ lang, version } = {}) {
  const requestedLang = normalizeLang(lang, 'gu');
  const resolvedVersion = typeof version === 'number' ? version : await getBroadcastVersion();

  const cacheKey = getSnapshotCacheKey({ lang: requestedLang, version: resolvedVersion });
  const cached = getSnapshotCached(cacheKey);
  if (cached) return cached;

  const doc = await getOrCreateSettings();
  const settings = adminSettingsResponse(doc);
  const itemsBy = await listItemsLast24hByChannel();

  const limit = 20;
  const breakingItems = (Array.isArray(itemsBy.breaking) ? itemsBy.breaking : [])
    .filter(i => i && i.isLive !== false)
    .slice(0, limit);
  const liveItems = (Array.isArray(itemsBy.live) ? itemsBy.live : [])
    .filter(i => i && i.isLive !== false)
    .slice(0, limit);

  const breakingEnabled = computePublicEnabled(settings.breaking.enabled, settings.breaking.mode);
  const liveEnabled = computePublicEnabled(settings.live.enabled, settings.live.mode);

  // Resolve text with lang-aware fallback translation.
  const [breakingTexts, liveTexts] = await Promise.all([
    resolveTextsWithTranslation(breakingItems, requestedLang),
    resolveTextsWithTranslation(liveItems, requestedLang),
  ]);

  const mapItem = (d, text) => {
    const id = d && d._id ? String(d._id) : undefined;
    return {
      id,
      type: d && (d.type === 'breaking' || d.type === 'live') ? d.type : undefined,
      text: String(text || '').trim(),
      createdAt: (d && d.createdAt) || null,
      expiresAt: (d && d.expiresAt) || null,
    };
  };

  const payload = {
    version: resolvedVersion,
    breaking: {
      enabled: breakingEnabled,
      mode: settings.breaking.mode,
      durationSeconds: settings.breaking.durationSeconds ?? settings.breaking.speedSec,
      scrollDurationSeconds: settings.breaking.durationSeconds ?? settings.breaking.speedSec,
      items: breakingItems.map((d, idx) => mapItem(d, breakingTexts[idx])),
    },
    live: {
      enabled: liveEnabled,
      mode: settings.live.mode,
      durationSeconds: settings.live.durationSeconds ?? settings.live.speedSec,
      scrollDurationSeconds: settings.live.durationSeconds ?? settings.live.speedSec,
      items: liveItems.map((d, idx) => mapItem(d, liveTexts[idx])),
    },
  };

  setSnapshotCached(cacheKey, payload);
  return payload;
}

// ─────────────────────────────────────────────
// SSE hub
// ─────────────────────────────────────────────

const clients = new Map();
let nextId = 1;

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function writeEvent(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function addClient({ res, lang }) {
  const id = String(nextId++);
  const normalizedLang = normalizeLang(lang, 'gu');

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  setNoCacheHeaders(res);
  res.setHeader('Connection', 'keep-alive');
  // Avoid proxy buffering (nginx)
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    res.flushHeaders && res.flushHeaders();
  } catch (_) {}

  const pingInterval = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch (_) {}
  }, 25_000);

  const client = { id, res, lang: normalizedLang, pingInterval };
  clients.set(id, client);

  const cleanup = () => {
    try { clearInterval(pingInterval); } catch (_) {}
    clients.delete(id);
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  return client;
}

async function emitBroadcastUpdated({ reason } = {}) {
  const version = await bumpBroadcastVersion({ reason: reason || 'broadcast_change' });

  // Compute snapshots per lang once.
  const langs = Array.from(SUPPORTED_LANGS.values());
  const snapshots = new Map();
  await Promise.all(langs.map(async (l) => {
    try {
      snapshots.set(l, await buildBroadcastSnapshot({ lang: l, version }));
    } catch (_) {
      snapshots.set(l, { version, breaking: { enabled: false, mode: 'auto', durationSeconds: 12, items: [] }, live: { enabled: false, mode: 'auto', durationSeconds: 12, items: [] } });
    }
  }));

  for (const client of clients.values()) {
    const payload = snapshots.get(client.lang) || snapshots.get('gu');
    try {
      writeEvent(client.res, 'broadcast_updated', payload);
    } catch (_) {
      try { client.res.end(); } catch (_) {}
      try { clearInterval(client.pingInterval); } catch (_) {}
      clients.delete(client.id);
    }
  }

  return version;
}

module.exports = {
  normalizeLang,
  buildBroadcastSnapshot,
  addClient,
  emitBroadcastUpdated,
  setNoCacheHeaders,
};
