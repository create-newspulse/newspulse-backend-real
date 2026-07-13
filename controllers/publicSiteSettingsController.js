const mongoose = require('mongoose');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { invalidatePublicSettingsCaches } = require('../lib/cache');
const { bumpPublicConfigVersion } = require('../services/publicConfigVersion.service');

const INSPIRATION_HUB_BOOLEAN_FIELDS = [
  'enabled',
  'enableInspirationHub',
  'isEnabled',
  'droneTvEnabled',
  'enableDroneTVVideo',
  'autoplayMuted',
  'showOnHomepage',
  'homepageEnabled',
  'showOnInspirationHubPage',
  'showOnCategoryPage',
];

const INSPIRATION_HUB_TEXT_FIELDS = [
  'youtubeUrl',
  'droneTvYoutubeUrl',
  'embedUrl',
  'droneTvEmbedUrl',
  'title',
  'subtitle',
  'videoTitle',
  'videoSubtitle',
  'droneTvTitle',
  'droneTvSubtitle',
  'dailyWondersTitle',
  'dailyWondersSubtitle',
  'narrationText',
];

const INSPIRATION_HUB_CONTENT_TEXT_FIELDS = [
  'title',
  'subtitle',
  'droneTvTitle',
  'droneTvSubtitle',
  'dailyWondersTitle',
  'dailyWondersSubtitle',
  'narrationText',
];

const INSPIRATION_HUB_COLLECTION_FIELDS = [
  'quotes',
  'cards',
];

const INSPIRATION_HUB_LANGS = ['en', 'hi', 'gu'];

const DAILY_WONDERS_BOOLEAN_FIELDS = [
  'enabled',
  'showOnHomepage',
];

const DAILY_WONDERS_TEXT_FIELDS = [
  'label',
  'title',
  'subtitle',
  'thoughtLabel',
  'thoughtText',
  'reminderLabel',
  'reminderText',
  'footerText',
  'publishDate',
];

const LIVE_TV_MODE_VALUES = Object.freeze([
  'News Pulse Live',
  'AIRA Bulletin',
  'Offline Replay',
  'Scheduled Show',
  'Breaking Mode',
  'Maintenance / Coming Soon',
]);

const LIVE_TV_STATUS_VALUES = Object.freeze(['live', 'replay', 'offline', 'scheduled', 'maintenance']);
const LIVE_TV_PROVIDER_VALUES = Object.freeze(['YouTube', 'Custom Embed']);
const LIVE_TV_LANGUAGE_VALUES = Object.freeze(['English', 'Hindi', 'Gujarati']);
const LIVE_TV_TEXT_FIELDS = Object.freeze([
  'mode',
  'provider',
  'embedUrl',
  'fallbackVideoUrl',
  'title',
  'subtitle',
  'language',
  'offlinePosterImageUrl',
  'offlineLoopVideoUrl',
  'offlineMessage',
  'startTime',
  'endTime',
  'nextLiveTime',
  'updatedAt',
]);

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeLiveTvStatus(value, fallback = 'offline') {
  const status = normalizeOptionalString(value).toLowerCase();
  return LIVE_TV_STATUS_VALUES.includes(status) ? status : fallback;
}

function inferLiveTvStatusFromMode(mode) {
  const normalizedMode = normalizeOptionalString(mode).toLowerCase();
  if (!normalizedMode) return 'offline';
  if (normalizedMode.includes('maintenance') || normalizedMode.includes('coming soon')) return 'maintenance';
  if (normalizedMode.includes('scheduled')) return 'scheduled';
  if (normalizedMode.includes('replay')) return 'replay';
  if (normalizedMode.includes('live') || normalizedMode.includes('breaking') || normalizedMode.includes('bulletin')) return 'live';
  return 'offline';
}

function firstDefined(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    if (hasOwn(source, key) && source[key] !== undefined) return source[key];
  }
  return undefined;
}

function firstNonEmptyString(source, keys, fallback = '') {
  const value = firstDefined(source, keys);
  const normalized = normalizeOptionalString(value);
  return normalized || fallback;
}

function firstBoolean(source, keys, fallback = false) {
  const value = firstDefined(source, keys);
  if (typeof value === 'boolean') return value;
  return fallback;
}

function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasNonEmptyStringField(obj, field) {
  return normalizeOptionalString(obj && obj[field]).length > 0;
}

function hasCollectionItems(obj, field) {
  return Array.isArray(obj && obj[field]) && obj[field].length > 0;
}

function shouldIncludeContentEntry(entry) {
  if (!isPlainObject(entry)) return false;
  for (const field of INSPIRATION_HUB_CONTENT_TEXT_FIELDS) {
    if (hasNonEmptyStringField(entry, field)) return true;
  }
  for (const field of INSPIRATION_HUB_COLLECTION_FIELDS) {
    if (hasCollectionItems(entry, field)) return true;
  }
  return false;
}

function normalizeInspirationHubContentEntry(entry, fallbackSource) {
  const sourceEntry = isPlainObject(entry) ? { ...entry } : {};
  const fallback = isPlainObject(fallbackSource) ? fallbackSource : {};
  const normalized = { ...sourceEntry };

  for (const field of INSPIRATION_HUB_CONTENT_TEXT_FIELDS) {
    if (hasOwn(sourceEntry, field)) {
      normalized[field] = normalizeOptionalString(sourceEntry[field]);
      continue;
    }

    if (hasOwn(fallback, field)) {
      normalized[field] = normalizeOptionalString(fallback[field]);
    }
  }

  for (const field of INSPIRATION_HUB_COLLECTION_FIELDS) {
    if (hasOwn(sourceEntry, field)) {
      normalized[field] = Array.isArray(sourceEntry[field]) ? cloneJsonValue(sourceEntry[field]) : [];
      continue;
    }

    if (hasOwn(fallback, field) && Array.isArray(fallback[field])) {
      normalized[field] = cloneJsonValue(fallback[field]);
    }
  }

  return normalized;
}

function normalizeInspirationHubContent(content, fallbackSource) {
  const rawContent = isPlainObject(content) ? content : {};
  const normalizedContent = {};
  const langKeys = new Set([...Object.keys(rawContent), ...INSPIRATION_HUB_LANGS]);

  for (const lang of langKeys) {
    const normalizedEntry = normalizeInspirationHubContentEntry(rawContent[lang], fallbackSource);
    if (shouldIncludeContentEntry(normalizedEntry)) {
      normalizedContent[lang] = normalizedEntry;
    }
  }

  return normalizedContent;
}

function extractYouTubeVideoId(rawUrl) {
  const trimmedUrl = normalizeOptionalString(rawUrl);
  if (!trimmedUrl) {
    return { ok: true, videoId: '', normalizedUrl: '' };
  }

  let parsed;
  try {
    parsed = new URL(trimmedUrl);
  } catch (_) {
    return { ok: false, message: 'Invalid inspirationHub.youtubeUrl: expected a valid YouTube URL' };
  }

  const hostname = String(parsed.hostname || '').toLowerCase().replace(/^www\./, '');
  const pathParts = String(parsed.pathname || '').split('/').filter(Boolean);
  let videoId = '';

  if (hostname === 'youtu.be') {
    videoId = pathParts[0] || '';
  } else if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'].includes(hostname)) {
    if (parsed.pathname === '/watch') {
      videoId = parsed.searchParams.get('v') || '';
    } else if (['embed', 'shorts', 'live'].includes(pathParts[0])) {
      videoId = pathParts[1] || '';
    } else {
      videoId = parsed.searchParams.get('v') || '';
    }
  } else {
    return { ok: false, message: 'Invalid inspirationHub.youtubeUrl: unsupported host' };
  }

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return { ok: false, message: 'Invalid inspirationHub.youtubeUrl: unsupported YouTube video id' };
  }

  return { ok: true, videoId, normalizedUrl: trimmedUrl };
}

function buildYouTubeEmbedUrl(videoId, autoplayMuted) {
  if (!videoId) return '';

  const params = new URLSearchParams({ rel: '0' });
  if (autoplayMuted) {
    params.set('autoplay', '1');
    params.set('mute', '1');
    params.set('playsinline', '1');
  }

  return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
}

function validateInspirationHubPayload(payload) {
  const hub = getNested(payload, 'inspirationHub');
  if (!hub.exists) return null;

  if (hub.value === null) return null;

  if (!hub.value || typeof hub.value !== 'object' || Array.isArray(hub.value)) {
    return { ok: false, message: 'Invalid value for inspirationHub: expected object' };
  }

  for (const field of INSPIRATION_HUB_BOOLEAN_FIELDS) {
    if (hasOwn(hub.value, field) && hub.value[field] !== undefined && typeof hub.value[field] !== 'boolean') {
      return { ok: false, message: `Invalid type for inspirationHub.${field}: expected boolean` };
    }
  }

  for (const field of INSPIRATION_HUB_TEXT_FIELDS) {
    if (hasOwn(hub.value, field) && hub.value[field] !== undefined && hub.value[field] !== null && typeof hub.value[field] !== 'string') {
      return { ok: false, message: `Invalid type for inspirationHub.${field}: expected string` };
    }
  }

  for (const field of INSPIRATION_HUB_COLLECTION_FIELDS) {
    if (hasOwn(hub.value, field) && hub.value[field] !== undefined && hub.value[field] !== null && !Array.isArray(hub.value[field])) {
      return { ok: false, message: `Invalid type for inspirationHub.${field}: expected array` };
    }
  }

  if (hasOwn(hub.value, 'content') && hub.value.content !== undefined && hub.value.content !== null) {
    if (!isPlainObject(hub.value.content)) {
      return { ok: false, message: 'Invalid value for inspirationHub.content: expected object' };
    }

    for (const [lang, contentValue] of Object.entries(hub.value.content)) {
      if (contentValue === null || contentValue === undefined) continue;
      if (!isPlainObject(contentValue)) {
        return { ok: false, message: `Invalid value for inspirationHub.content.${lang}: expected object` };
      }

      for (const field of INSPIRATION_HUB_CONTENT_TEXT_FIELDS) {
        if (hasOwn(contentValue, field) && contentValue[field] !== undefined && contentValue[field] !== null && typeof contentValue[field] !== 'string') {
          return { ok: false, message: `Invalid type for inspirationHub.content.${lang}.${field}: expected string` };
        }
      }

      for (const field of INSPIRATION_HUB_COLLECTION_FIELDS) {
        if (hasOwn(contentValue, field) && contentValue[field] !== undefined && contentValue[field] !== null && !Array.isArray(contentValue[field])) {
          return { ok: false, message: `Invalid type for inspirationHub.content.${lang}.${field}: expected array` };
        }
      }
    }
  }

  for (const field of ['youtubeUrl', 'droneTvYoutubeUrl']) {
    if (hasOwn(hub.value, field)) {
      const parsed = extractYouTubeVideoId(hub.value[field]);
      if (!parsed.ok) return { ok: false, message: parsed.message.replace('inspirationHub.youtubeUrl', `inspirationHub.${field}`) };
    }
  }

  return null;
}

function normalizeInspirationHub(settingsObj) {
  const base = (settingsObj && typeof settingsObj === 'object') ? settingsObj : {};
  if (!hasOwn(base, 'inspirationHub')) return base;

  if (!base.inspirationHub || typeof base.inspirationHub !== 'object' || Array.isArray(base.inspirationHub)) {
    delete base.inspirationHub;
    return base;
  }

  const source = base.inspirationHub;
  const youtubeUrlInput = firstNonEmptyString(source, ['youtubeUrl', 'droneTvYoutubeUrl']);
  const embedUrlInput = firstNonEmptyString(source, ['embedUrl', 'droneTvEmbedUrl']);
  const parsed = extractYouTubeVideoId(youtubeUrlInput);
  const autoplayMuted = firstBoolean(source, ['autoplayMuted'], false);
  const derivedEmbedUrl = parsed.ok ? buildYouTubeEmbedUrl(parsed.videoId, autoplayMuted) : '';
  const resolvedEmbedUrl = derivedEmbedUrl || embedUrlInput;

  const normalizedContent = normalizeInspirationHubContent(source.content, source);
  const title = firstNonEmptyString(source, ['title', 'videoTitle', 'droneTvTitle'], 'Inspiration Hub');
  const subtitle = firstNonEmptyString(source, ['subtitle', 'videoSubtitle', 'droneTvSubtitle'], 'A calm space for perspective, clarity, and meaningful stories.');
  const showOnInspirationHubPage = firstBoolean(source, ['showOnInspirationHubPage', 'showOnCategoryPage'], false);
  const normalizedHub = {
    ...source,
    enabled: firstBoolean(source, ['enabled', 'enableInspirationHub', 'isEnabled'], false),
    droneTvEnabled: firstBoolean(source, ['droneTvEnabled', 'enableDroneTVVideo'], false),
    youtubeUrl: parsed.ok ? parsed.normalizedUrl : youtubeUrlInput,
    embedUrl: resolvedEmbedUrl,
    title,
    subtitle,
    videoTitle: firstNonEmptyString(source, ['videoTitle', 'title', 'droneTvTitle'], title),
    videoSubtitle: firstNonEmptyString(source, ['videoSubtitle', 'subtitle', 'droneTvSubtitle'], subtitle),
    droneTvTitle: normalizeOptionalString(source.droneTvTitle),
    droneTvSubtitle: normalizeOptionalString(source.droneTvSubtitle),
    dailyWondersTitle: normalizeOptionalString(source.dailyWondersTitle),
    dailyWondersSubtitle: normalizeOptionalString(source.dailyWondersSubtitle),
    narrationText: normalizeOptionalString(source.narrationText),
    autoplayMuted,
    showOnHomepage: firstBoolean(source, ['showOnHomepage', 'homepageEnabled'], false),
    showOnInspirationHubPage,
    showOnCategoryPage: firstBoolean(source, ['showOnCategoryPage', 'showOnInspirationHubPage'], false),
    quotes: Array.isArray(source.quotes) ? cloneJsonValue(source.quotes) : [],
    cards: Array.isArray(source.cards) ? cloneJsonValue(source.cards) : [],
  };

  if (Object.keys(normalizedContent).length > 0) {
    normalizedHub.content = normalizedContent;
  } else {
    delete normalizedHub.content;
  }

  base.inspirationHub = normalizedHub;

  return base;
}

function getDefaultDailyWonders() {
  const defaults = PublicSiteSettings.getDefaultSettings();
  return cloneJsonValue(defaults.dailyWonders || {});
}

function getDefaultLiveTv() {
  const defaults = PublicSiteSettings.getDefaultSettings();
  return cloneJsonValue(defaults.liveTv || {});
}

function validateLiveTvPayload(payload) {
  const liveTv = getNested(payload, 'liveTv');
  if (!liveTv.exists) return null;

  if (liveTv.value === null) return null;

  if (!isPlainObject(liveTv.value)) {
    return { ok: false, message: 'Invalid value for liveTv: expected object' };
  }

  if (hasOwn(liveTv.value, 'enabled') && liveTv.value.enabled !== undefined && typeof liveTv.value.enabled !== 'boolean') {
    return { ok: false, message: 'Invalid type for liveTv.enabled: expected boolean' };
  }

  if (hasOwn(liveTv.value, 'showOnHomepage') && liveTv.value.showOnHomepage !== undefined && typeof liveTv.value.showOnHomepage !== 'boolean') {
    return { ok: false, message: 'Invalid type for liveTv.showOnHomepage: expected boolean' };
  }

  if (hasOwn(liveTv.value, 'status') && liveTv.value.status !== undefined) {
    const status = normalizeOptionalString(liveTv.value.status).toLowerCase();
    if (!LIVE_TV_STATUS_VALUES.includes(status)) {
      return { ok: false, message: `Invalid value for liveTv.status: expected one of ${LIVE_TV_STATUS_VALUES.join(' | ')}` };
    }
  }

  for (const field of LIVE_TV_TEXT_FIELDS) {
    if (hasOwn(liveTv.value, field) && liveTv.value[field] !== undefined && liveTv.value[field] !== null && typeof liveTv.value[field] !== 'string') {
      return { ok: false, message: `Invalid type for liveTv.${field}: expected string` };
    }
  }

  return null;
}

function normalizeLiveTv(settingsObj) {
  const base = (settingsObj && typeof settingsObj === 'object') ? settingsObj : {};
  const defaults = getDefaultLiveTv();
  const source = isPlainObject(base.liveTv) ? base.liveTv : {};
  const defaultMode = normalizeOptionalString(defaults.mode) || 'Offline Replay';
  const mode = hasOwn(source, 'mode') ? normalizeOptionalString(source.mode) : defaultMode;
  const defaultStatus = normalizeLiveTvStatus(defaults.status, inferLiveTvStatusFromMode(defaultMode));

  base.liveTv = {
    ...source,
    enabled: typeof source.enabled === 'boolean' ? source.enabled : Boolean(defaults.enabled),
    status: normalizeLiveTvStatus(source.status, defaultStatus || inferLiveTvStatusFromMode(mode)),
    mode,
    provider: hasOwn(source, 'provider') ? normalizeOptionalString(source.provider) : normalizeOptionalString(defaults.provider),
    embedUrl: hasOwn(source, 'embedUrl') ? normalizeOptionalString(source.embedUrl) : normalizeOptionalString(defaults.embedUrl),
    fallbackVideoUrl: hasOwn(source, 'fallbackVideoUrl') ? normalizeOptionalString(source.fallbackVideoUrl) : normalizeOptionalString(defaults.fallbackVideoUrl),
    title: hasOwn(source, 'title') ? normalizeOptionalString(source.title) : normalizeOptionalString(defaults.title),
    subtitle: hasOwn(source, 'subtitle') ? normalizeOptionalString(source.subtitle) : normalizeOptionalString(defaults.subtitle),
    language: hasOwn(source, 'language') ? normalizeOptionalString(source.language) : normalizeOptionalString(defaults.language),
    showOnHomepage: typeof source.showOnHomepage === 'boolean' ? source.showOnHomepage : Boolean(defaults.showOnHomepage),
    offlinePosterImageUrl: hasOwn(source, 'offlinePosterImageUrl') ? normalizeOptionalString(source.offlinePosterImageUrl) : normalizeOptionalString(defaults.offlinePosterImageUrl),
    offlineLoopVideoUrl: hasOwn(source, 'offlineLoopVideoUrl') ? normalizeOptionalString(source.offlineLoopVideoUrl) : normalizeOptionalString(defaults.offlineLoopVideoUrl),
    offlineMessage: hasOwn(source, 'offlineMessage') ? normalizeOptionalString(source.offlineMessage) : normalizeOptionalString(defaults.offlineMessage),
    startTime: hasOwn(source, 'startTime') ? normalizeOptionalString(source.startTime) : normalizeOptionalString(defaults.startTime),
    endTime: hasOwn(source, 'endTime') ? normalizeOptionalString(source.endTime) : normalizeOptionalString(defaults.endTime),
    nextLiveTime: hasOwn(source, 'nextLiveTime') ? normalizeOptionalString(source.nextLiveTime) : normalizeOptionalString(defaults.nextLiveTime),
    updatedAt: hasOwn(source, 'updatedAt') ? normalizeOptionalString(source.updatedAt) : normalizeOptionalString(defaults.updatedAt),
  };

  return base;
}

function extractLiveTvPayload(payload) {
  if (!isPlainObject(payload)) return null;
  if (hasOwn(payload, 'liveTv')) return isPlainObject(payload.liveTv) ? payload.liveTv : null;
  return payload;
}

function normalizeLiveTvOnly(liveTv) {
  return ensureCategoryStripEnabled({ liveTv }).liveTv;
}

function getAdminLiveTvAction(req) {
  const raw = firstNonEmptyString(
    { body: req.body?.action, query: req.query?.action, operation: req.body?.operation },
    ['body', 'query', 'operation'],
  ).toLowerCase();
  return raw;
}

async function saveAdminLiveTvPayload(req, res, options = {}) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }

    const settings = await PublicSiteSettings.getOrCreate();
    const baseDraft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
    const basePublished = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());
    const providedLiveTv = extractLiveTvPayload(req.body || {});
    const action = options.action || getAdminLiveTvAction(req);
    const shouldDeactivate = action === 'deactivate';
    const shouldPublish = options.publish === true || action === 'publish' || action === 'published' || shouldDeactivate;

    let liveTvPatch = providedLiveTv || {};
    if (!isPlainObject(liveTvPatch)) {
      return res.status(400).json({ ok: false, message: 'Invalid liveTv payload: expected object' });
    }

    liveTvPatch = { ...liveTvPatch };
    delete liveTvPatch.action;
    delete liveTvPatch.operation;

    if (shouldDeactivate) {
      liveTvPatch.enabled = false;
      liveTvPatch.status = 'offline';
    }

    if (!hasOwn(liveTvPatch, 'updatedAt')) {
      liveTvPatch.updatedAt = new Date().toISOString();
    }

    const liveTvValidationErr = validateLiveTvPayload({ liveTv: liveTvPatch });
    if (liveTvValidationErr) return res.status(400).json(liveTvValidationErr);

    const mergedDraftLiveTv = normalizeLiveTvOnly(deepMerge(baseDraft.liveTv || {}, liveTvPatch));
    const draft = ensureCategoryStripEnabled(deepMerge(baseDraft, { liveTv: mergedDraftLiveTv }));
    settings.draft = draft;

    if (shouldPublish) {
      const publishedLiveTv = normalizeLiveTvOnly(deepMerge(basePublished.liveTv || {}, mergedDraftLiveTv));
      settings.published = ensureCategoryStripEnabled(deepMerge(basePublished, { liveTv: publishedLiveTv }));
      if (typeof settings.version !== 'number') settings.version = 1;
      settings.version += 1;
      settings.publishedUpdatedAt = new Date();
    }

    await settings.save();
    invalidatePublicSettingsCaches().catch(() => {});
    if (shouldPublish) bumpPublicConfigVersion().catch(() => {});

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString(),
      liveTv: settings.draft.liveTv,
      draft: settings.draft.liveTv,
      published: ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings()).liveTv,
      message: shouldPublish ? 'Live TV settings published successfully' : 'Live TV settings saved successfully',
    });
  } catch (error) {
    console.error('[saveAdminLiveTvPayload] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to save Live TV settings', error: error.message });
  }
}

async function getAdminLiveTvSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }

    const settings = await PublicSiteSettings.getOrCreate();
    const draft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
    const published = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString(),
      liveTv: draft.liveTv,
      draft: draft.liveTv,
      published: published.liveTv,
    });
  } catch (error) {
    console.error('[getAdminLiveTvSettings] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to fetch Live TV settings', error: error.message });
  }
}

async function updateAdminLiveTvSettings(req, res) {
  return saveAdminLiveTvPayload(req, res);
}

async function publishAdminLiveTvSettings(req, res) {
  return saveAdminLiveTvPayload(req, res, { publish: true });
}

async function deactivateAdminLiveTvSettings(req, res) {
  return saveAdminLiveTvPayload(req, res, { action: 'deactivate', publish: true });
}

function validateDailyWondersPayload(payload) {
  const dailyWonders = getNested(payload, 'dailyWonders');
  if (!dailyWonders.exists) return null;

  if (dailyWonders.value === null) return null;

  if (!isPlainObject(dailyWonders.value)) {
    return { ok: false, message: 'Invalid value for dailyWonders: expected object' };
  }

  for (const field of DAILY_WONDERS_BOOLEAN_FIELDS) {
    if (hasOwn(dailyWonders.value, field) && dailyWonders.value[field] !== undefined && typeof dailyWonders.value[field] !== 'boolean') {
      return { ok: false, message: `Invalid type for dailyWonders.${field}: expected boolean` };
    }
  }

  for (const field of DAILY_WONDERS_TEXT_FIELDS) {
    if (hasOwn(dailyWonders.value, field) && dailyWonders.value[field] !== undefined && dailyWonders.value[field] !== null && typeof dailyWonders.value[field] !== 'string') {
      return { ok: false, message: `Invalid type for dailyWonders.${field}: expected string` };
    }
  }

  return null;
}

function normalizeDailyWonders(settingsObj) {
  const base = (settingsObj && typeof settingsObj === 'object') ? settingsObj : {};
  const defaults = getDefaultDailyWonders();
  const source = isPlainObject(base.dailyWonders) ? base.dailyWonders : {};

  const normalized = {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
    showOnHomepage: typeof source.showOnHomepage === 'boolean' ? source.showOnHomepage : defaults.showOnHomepage,
  };

  for (const field of DAILY_WONDERS_TEXT_FIELDS) {
    const fallback = hasOwn(defaults, field) ? defaults[field] : '';
    const value = hasOwn(source, field) ? source[field] : fallback;
    const normalizedValue = normalizeOptionalString(value);
    if (field === 'publishDate') {
      if (normalizedValue) normalized.publishDate = normalizedValue;
      continue;
    }
    normalized[field] = normalizedValue;
  }

  base.dailyWonders = normalized;
  return base;
}

function ensureCategoryStripEnabled(settingsObj) {
  const base = (settingsObj && typeof settingsObj === 'object') ? settingsObj : {};
  if (!base.publicSite || typeof base.publicSite !== 'object') base.publicSite = {};
  if (!base.publicSite.homepage || typeof base.publicSite.homepage !== 'object') base.publicSite.homepage = {};
  if (typeof base.publicSite.homepage.categoryStripEnabled !== 'boolean') {
    base.publicSite.homepage.categoryStripEnabled = true;
  }

  if (!base.categoryStrip || typeof base.categoryStrip !== 'object') base.categoryStrip = {};

  // Backward/forward-compat normalization for homepage modules and tickers.
  // Different frontend builds have used different key names over time.
  if (!base.homepage || typeof base.homepage !== 'object') base.homepage = {};
  if (!base.homepage.modules || typeof base.homepage.modules !== 'object') base.homepage.modules = {};
  const modules = base.homepage.modules;

  if (!modules.categoryStrip || typeof modules.categoryStrip !== 'object') {
    modules.categoryStrip = { enabled: base.publicSite.homepage.categoryStripEnabled, order: 1 };
  }

  if (typeof base.categoryStrip.enabled === 'boolean') {
    base.publicSite.homepage.categoryStripEnabled = base.categoryStrip.enabled;
    modules.categoryStrip.enabled = base.categoryStrip.enabled;
  } else if (typeof modules.categoryStrip.enabled === 'boolean') {
    base.categoryStrip.enabled = modules.categoryStrip.enabled;
    base.publicSite.homepage.categoryStripEnabled = modules.categoryStrip.enabled;
  } else {
    base.categoryStrip.enabled = base.publicSite.homepage.categoryStripEnabled;
    modules.categoryStrip.enabled = base.publicSite.homepage.categoryStripEnabled;
  }

  // trendingStrip <-> trending
  if (modules.trending && !modules.trendingStrip) modules.trendingStrip = modules.trending;
  if (modules.trendingStrip && !modules.trending) modules.trending = modules.trendingStrip;

  // exploreCategories <-> explore
  if (modules.explore && !modules.exploreCategories) modules.exploreCategories = modules.explore;
  if (modules.exploreCategories && !modules.explore) modules.explore = modules.exploreCategories;

  // liveTvCard <-> liveTv
  if (modules.liveTv && !modules.liveTvCard) modules.liveTvCard = modules.liveTv;
  if (modules.liveTvCard && !modules.liveTv) modules.liveTv = modules.liveTvCard;

  // Ensure tickers object exists and normalize speed field names.
  if (!base.tickers || typeof base.tickers !== 'object') base.tickers = {};
  if (base.tickers.breakingTicker && !base.tickers.breaking) base.tickers.breaking = base.tickers.breakingTicker;
  if (base.tickers.breaking && !base.tickers.breakingTicker) base.tickers.breakingTicker = base.tickers.breaking;
  if (base.tickers.liveUpdates && !base.tickers.live) base.tickers.live = base.tickers.liveUpdates;
  if (base.tickers.live && !base.tickers.liveUpdates) base.tickers.liveUpdates = base.tickers.live;
  for (const k of ['breaking', 'live']) {
    if (!base.tickers[k] || typeof base.tickers[k] !== 'object') continue;
    const t = base.tickers[k];
    if (t.speedSec !== undefined && t.speedSeconds === undefined) t.speedSeconds = t.speedSec;
    if (t.speedSeconds !== undefined && t.speedSec === undefined) t.speedSec = t.speedSeconds;
  }

  normalizeInspirationHub(base);
  normalizeDailyWonders(base);
  normalizeLiveTv(base);

  return base;
}

function ensurePublicSettingsResponse(settingsObj) {
  const base = ensureCategoryStripEnabled(settingsObj);
  if (!hasOwn(base, 'inspirationHub')) {
    base.inspirationHub = {};
  }
  normalizeInspirationHub(base);
  return base;
}

function sanitizePublicSettingsResponse(settingsObj) {
  const base = cloneJsonValue(settingsObj || {});
  delete base.viralVideos;
  delete base.viralVideosEnabled;

  if (base.homepage && typeof base.homepage === 'object' && base.homepage.modules && typeof base.homepage.modules === 'object') {
    delete base.homepage.modules.viralVideos;
    delete base.homepage.modules.shortVideoDesk;
  }

  return base;
}

function deepMerge(target, source) {
  const t = (target && typeof target === 'object') ? target : {};
  const s = (source && typeof source === 'object') ? source : {};
  for (const [key, value] of Object.entries(s)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      t[key] = deepMerge(t[key], value);
    } else {
      t[key] = value;
    }
  }
  return t;
}

function getNested(obj, path) {
  const parts = String(path || '').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object' || !(p in cur)) return { exists: false, value: undefined };
    cur = cur[p];
  }
  return { exists: true, value: cur };
}

/**
 * Get both draft and published settings
 * GET /api/admin/settings/public
 */
async function getPublicSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const draft = sanitizePublicSettingsResponse(ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings()));
    const published = sanitizePublicSettingsResponse(ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings()));

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString(),
      draft,
      published,
    });
  } catch (error) {
    console.error('[getPublicSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch public settings',
      error: error.message,
    });
  }
}

/**
 * Get draft settings only
 * GET /api/admin/settings/public/draft
 */
async function getDraftSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const draft = sanitizePublicSettingsResponse(ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings()));

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      draft,
    });
  } catch (error) {
    console.error('[getDraftSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch draft settings',
      error: error.message,
    });
  }
}

/**
 * Update draft settings
 * PUT /api/admin/settings/public/draft
 */
async function updateDraftSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const draftData = req.body;

    if (!draftData || typeof draftData !== 'object') {
      return res.status(400).json({
        ok: false,
        message: 'Invalid draft data: expected an object',
      });
    }

    // Strict validation for Category Strip flag if present
    const cs = getNested(draftData, 'publicSite.homepage.categoryStripEnabled');
    if (cs.exists && typeof cs.value !== 'boolean') {
      return res.status(400).json({
        ok: false,
        message: 'Invalid value for publicSite.homepage.categoryStripEnabled: expected boolean',
      });
    }

    const inspirationHubValidationErr = validateInspirationHubPayload(draftData);
    if (inspirationHubValidationErr) {
      return res.status(400).json(inspirationHubValidationErr);
    }

    const dailyWondersValidationErr = validateDailyWondersPayload(draftData);
    if (dailyWondersValidationErr) {
      return res.status(400).json(dailyWondersValidationErr);
    }

    const liveTvValidationErr = validateLiveTvPayload(draftData);
    if (liveTvValidationErr) {
      return res.status(400).json(liveTvValidationErr);
    }

    const settings = await PublicSiteSettings.getOrCreate();

    // Merge into existing draft to support partial updates without clobbering other keys
    const baseDraft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
    const merged = deepMerge(baseDraft, draftData);
    settings.draft = ensureCategoryStripEnabled(merged);
    await settings.save();
    invalidatePublicSettingsCaches().catch(() => {});

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      draft: sanitizePublicSettingsResponse(settings.draft),
      message: 'Draft settings saved successfully',
    });
  } catch (error) {
    console.error('[updateDraftSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to update draft settings',
      error: error.message,
    });
  }
}

/**
 * Publish draft settings (copy draft to published)
 * POST /api/admin/settings/public/publish
 */
async function publishSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const publishPayload = req.body;

    if (publishPayload && isPlainObject(publishPayload) && Object.keys(publishPayload).length > 0) {
      const cs = getNested(publishPayload, 'publicSite.homepage.categoryStripEnabled');
      if (cs.exists && typeof cs.value !== 'boolean') {
        return res.status(400).json({
          ok: false,
          message: 'Invalid value for publicSite.homepage.categoryStripEnabled: expected boolean',
        });
      }

      const inspirationHubValidationErr = validateInspirationHubPayload(publishPayload);
      if (inspirationHubValidationErr) return res.status(400).json(inspirationHubValidationErr);

      const dailyWondersValidationErr = validateDailyWondersPayload(publishPayload);
      if (dailyWondersValidationErr) return res.status(400).json(dailyWondersValidationErr);

      const liveTvValidationErr = validateLiveTvPayload(publishPayload);
      if (liveTvValidationErr) return res.status(400).json(liveTvValidationErr);

      const baseDraft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
      settings.draft = ensureCategoryStripEnabled(deepMerge(baseDraft, publishPayload));
    }

    // Ensure a numeric version exists
    if (typeof settings.version !== 'number') settings.version = 1;

    // If no draft exists, publish current published or defaults
    if (!settings.draft || Object.keys(settings.draft).length === 0) {
      const currentPublished = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());
      settings.published = currentPublished;
    } else {
      // Copy draft to published
      settings.published = ensureCategoryStripEnabled(JSON.parse(JSON.stringify(settings.draft)));
    }

    // Bump version as part of the publish operation
    settings.version = settings.version + 1;
    settings.publishedUpdatedAt = new Date();
    await settings.save();

    bumpPublicConfigVersion().catch(() => {});
    invalidatePublicSettingsCaches().catch(() => {});

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: settings.version,
      updatedAt: settings.publishedUpdatedAt
        ? new Date(settings.publishedUpdatedAt).toISOString()
        : (settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString()),
      published: sanitizePublicSettingsResponse(settings.published),
      message: 'Settings published successfully',
    });
  } catch (error) {
    console.error('[publishSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to publish settings',
      error: error.message,
    });
  }
}

/**
 * Save public settings (admin)
 * PATCH /api/admin/settings/public  -> merge into draft
 * PUT   /api/admin/settings/public  -> replace draft
 */
async function savePublicSettings(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ ok: false, message: 'Database unavailable' });
    }
    const newData = req.body;
    if (!newData || typeof newData !== 'object') {
      return res.status(400).json({ ok: false, message: 'Invalid settings payload: expected object' });
    }

    const settings = await PublicSiteSettings.getOrCreate();
    const baseDraft = settings.draft || PublicSiteSettings.getDefaultSettings();
    const basePublished = settings.published || PublicSiteSettings.getDefaultSettings();

    // Validate types for fields that exist in current settings (booleans/numbers)
    function _validate(obj, pathParts = []) {
      for (const [k, v] of Object.entries(obj)) {
        const parts = pathParts.concat(k);
        const path = parts.join('.');
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const err = _validate(v, parts);
          if (err) return err;
          continue;
        }

        const existing = getNested(baseDraft, path);
        const existingPub = getNested(basePublished, path);
        const existingVal = existing.exists ? existing.value : (existingPub.exists ? existingPub.value : undefined);

        if (existingVal !== undefined) {
          if (typeof existingVal === 'boolean' && typeof v !== 'boolean') {
            return { ok: false, message: `Invalid type for ${path}: expected boolean` };
          }
          if (typeof existingVal === 'number' && typeof v !== 'number') {
            return { ok: false, message: `Invalid type for ${path}: expected number` };
          }
        }
      }
      return null;
    }

    const validationErr = _validate(newData);
    if (validationErr) return res.status(400).json(validationErr);

    const inspirationHubValidationErr = validateInspirationHubPayload(newData);
    if (inspirationHubValidationErr) return res.status(400).json(inspirationHubValidationErr);

    const dailyWondersValidationErr = validateDailyWondersPayload(newData);
    if (dailyWondersValidationErr) return res.status(400).json(dailyWondersValidationErr);

    const liveTvValidationErr = validateLiveTvPayload(newData);
    if (liveTvValidationErr) return res.status(400).json(liveTvValidationErr);

    if (String(req.method || '').toUpperCase() === 'PUT') {
      // Replace draft entirely
      settings.draft = ensureCategoryStripEnabled(newData);
    } else {
      // PATCH -> merge into existing draft
      const merged = deepMerge(ensureCategoryStripEnabled(baseDraft), newData);
      settings.draft = ensureCategoryStripEnabled(merged);
    }

    await settings.save();
    invalidatePublicSettingsCaches().catch(() => {});

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString(),
      draft: sanitizePublicSettingsResponse(settings.draft),
      published: sanitizePublicSettingsResponse(settings.published),
    });
  } catch (error) {
    console.error('[savePublicSettings] error:', error);
    return res.status(500).json({ ok: false, message: 'Failed to save public settings', error: error.message });
  }
}

/**
 * Get published settings (public endpoint, no auth)
 * GET /api/public/settings
 */
async function getPublishedSettings(req, res) {
  try {
    // Public endpoint should stay stable even if DB is down.
    if (!isDbReady()) {
      const fallback = sanitizePublicSettingsResponse(ensurePublicSettingsResponse(PublicSiteSettings.getDefaultSettings()));
      res.set('Cache-Control', 'no-store, max-age=0');
      return res.status(200).json({
        ok: true,
        scope: String(process.env.PUBLIC_SITE_SETTINGS_SCOPE || '').trim() || (String(process.env.NODE_ENV || 'development').toLowerCase() === 'production' ? 'production' : 'development'),
        version: 1,
        updatedAt: new Date().toISOString(),
        published: fallback,
      });
    }
    const settings = await PublicSiteSettings.getOrCreate();
    const published = sanitizePublicSettingsResponse(ensurePublicSettingsResponse(settings.published || PublicSiteSettings.getDefaultSettings()));

    res.set('Cache-Control', 'no-store, max-age=0');

    return res.status(200).json({
      ok: true,
      scope: settings.scope || undefined,
      version: typeof settings.version === 'number' ? settings.version : 1,
      updatedAt: settings.publishedUpdatedAt
        ? new Date(settings.publishedUpdatedAt).toISOString()
        : (settings.updatedAt ? new Date(settings.updatedAt).toISOString() : new Date().toISOString()),
      published,
    });
  } catch (error) {
    console.error('[getPublishedSettings] error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to fetch published settings',
      error: error.message,
    });
  }
}

module.exports = {
  ensureCategoryStripEnabled,
  ensurePublicSettingsResponse,
  getAdminLiveTvSettings,
  getPublicSettings,
  getDraftSettings,
  updateDraftSettings,
  publishSettings,
  updateAdminLiveTvSettings,
  publishAdminLiveTvSettings,
  deactivateAdminLiveTvSettings,
  savePublicSettings,
  getPublishedSettings,
};
