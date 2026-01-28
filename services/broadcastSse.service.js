const { computePublicEnabled, listItemsLast24hByChannel, getOrCreateSettings, adminSettingsResponse } = require('./broadcastCenter.service');
const { getBroadcastVersion, bumpBroadcastVersion } = require('./broadcastVersion.service');
const googleTranslate = require('./googleTranslate.service');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function normalizeLang(v, fallback = 'gu') {
  const s0 = String(v || '').trim().toLowerCase();
  if (!s0) return fallback;
  const s = s0.split(/[-_]/)[0];
  return SUPPORTED_LANGS.has(s) ? s : fallback;
}

function resolvePublicText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = normalizeLang(lang, 'gu');

  const src = SUPPORTED_LANGS.has(String(d.sourceLang || ''))
    ? String(d.sourceLang)
    : (SUPPORTED_LANGS.has(String(d.language || '')) ? String(d.language) : null);

  const translations = d.translations && typeof d.translations === 'object' ? d.translations : null;
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  const pick =
    (translations && typeof translations[target] === 'string' && translations[target].trim() ? translations[target] : null) ||
    (i18n && typeof i18n[target] === 'string' && i18n[target].trim() ? i18n[target] : null) ||
    (legacy && typeof legacy[target] === 'string' && legacy[target].trim() ? legacy[target] : null) ||
    (src && translations && typeof translations[src] === 'string' && translations[src].trim() ? translations[src] : null) ||
    (src && i18n && typeof i18n[src] === 'string' && i18n[src].trim() ? i18n[src] : null) ||
    (src && legacy && typeof legacy[src] === 'string' && legacy[src].trim() ? legacy[src] : null) ||
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (i18n && typeof i18n.hi === 'string' && i18n.hi.trim() ? i18n.hi : null) ||
    (i18n && typeof i18n.en === 'string' && i18n.en.trim() ? i18n.en : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');

  return String(pick || '').trim();
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
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const from = (obj) => (obj && typeof obj[l] === 'string' && obj[l].trim() ? String(obj[l]).trim() : null);
  return from(i18n) || from(legacy);
}

function pickSourceText(doc) {
  // Prefer Gujarati as the canonical stored source for tickers.
  const d = doc && typeof doc === 'object' ? doc : {};
  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;
  const pick =
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (legacy && typeof legacy.gu === 'string' && legacy.gu.trim() ? legacy.gu : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');
  return String(pick || '').trim();
}

async function resolveTextsWithTranslation(docs, targetLang) {
  const dst = normalizeLang(targetLang, 'gu');
  const items = Array.isArray(docs) ? docs : [];

  // Start with best available stored translation.
  const resolved = items.map((d) => pickLangText(d, dst));

  // No translation needed for Gujarati.
  if (dst === 'gu') {
    return resolved.map((t, i) => (t && t.trim() ? t : pickSourceText(items[i])));
  }

  const missingIdx = [];
  const missingSrc = [];
  for (let i = 0; i < resolved.length; i++) {
    const t = resolved[i];
    if (typeof t === 'string' && t.trim()) continue;
    const srcText = pickSourceText(items[i]);
    resolved[i] = srcText;
    if (srcText) {
      missingIdx.push(i);
      missingSrc.push(srcText);
    }
  }

  if (!missingSrc.length) return resolved;

  const tr = await googleTranslate.translateMany(missingSrc, dst).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  if (!tr || !tr.ok || !Array.isArray(tr.items)) {
    try {
      console.warn('[broadcast] translateMany fallback', { lang: dst, count: missingSrc.length, error: tr && tr.error ? tr.error : 'translate_failed' });
    } catch (_) {}
    return resolved;
  }

  for (let j = 0; j < missingIdx.length; j++) {
    const i = missingIdx[j];
    const v = tr.items[j];
    if (typeof v === 'string' && v.trim()) resolved[i] = v.trim().slice(0, 160);
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
