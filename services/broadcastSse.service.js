const { computePublicEnabled, listItemsLast24hByChannel, getOrCreateSettings, adminSettingsResponse } = require('./broadcastCenter.service');
const { getBroadcastVersion, bumpBroadcastVersion } = require('./broadcastVersion.service');

const SUPPORTED_LANGS = new Set(['en', 'hi', 'gu']);

function normalizeLang(v, fallback = 'gu') {
  const s = String(v || '').trim().toLowerCase();
  return SUPPORTED_LANGS.has(s) ? s : fallback;
}

function resolvePublicText(doc, lang) {
  const d = doc && typeof doc === 'object' ? doc : {};
  const target = normalizeLang(lang, 'gu');

  const src = SUPPORTED_LANGS.has(String(d.sourceLang || ''))
    ? String(d.sourceLang)
    : (SUPPORTED_LANGS.has(String(d.language || '')) ? String(d.language) : null);

  const i18n = d.text_i18n && typeof d.text_i18n === 'object' ? d.text_i18n : null;
  const legacy = d.textByLang && typeof d.textByLang === 'object' ? d.textByLang : null;

  const pick =
    (i18n && typeof i18n[target] === 'string' && i18n[target].trim() ? i18n[target] : null) ||
    (legacy && typeof legacy[target] === 'string' && legacy[target].trim() ? legacy[target] : null) ||
    (src && i18n && typeof i18n[src] === 'string' && i18n[src].trim() ? i18n[src] : null) ||
    (src && legacy && typeof legacy[src] === 'string' && legacy[src].trim() ? legacy[src] : null) ||
    (i18n && typeof i18n.gu === 'string' && i18n.gu.trim() ? i18n.gu : null) ||
    (i18n && typeof i18n.hi === 'string' && i18n.hi.trim() ? i18n.hi : null) ||
    (i18n && typeof i18n.en === 'string' && i18n.en.trim() ? i18n.en : null) ||
    (typeof d.text === 'string' && d.text.trim() ? d.text : '');

  return String(pick || '').trim();
}

async function buildBroadcastSnapshot({ lang, version } = {}) {
  const requestedLang = normalizeLang(lang, 'gu');
  const resolvedVersion = typeof version === 'number' ? version : await getBroadcastVersion();

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

  const mapItem = (d) => {
    const id = d && d._id ? String(d._id) : undefined;
    return {
      id,
      type: d && (d.type === 'breaking' || d.type === 'live') ? d.type : undefined,
      text: resolvePublicText(d, requestedLang),
      createdAt: (d && d.createdAt) || null,
      expiresAt: (d && d.expiresAt) || null,
    };
  };

  return {
    version: resolvedVersion,
    breaking: {
      enabled: breakingEnabled,
      mode: settings.breaking.mode,
      durationSeconds: settings.breaking.durationSeconds ?? settings.breaking.speedSec,
      scrollDurationSeconds: settings.breaking.durationSeconds ?? settings.breaking.speedSec,
      items: breakingItems.map(mapItem),
    },
    live: {
      enabled: liveEnabled,
      mode: settings.live.mode,
      durationSeconds: settings.live.durationSeconds ?? settings.live.speedSec,
      scrollDurationSeconds: settings.live.durationSeconds ?? settings.live.speedSec,
      items: liveItems.map(mapItem),
    },
  };
}

// ─────────────────────────────────────────────
// SSE hub
// ─────────────────────────────────────────────

const clients = new Map();
let nextId = 1;

function setNoCacheHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
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
