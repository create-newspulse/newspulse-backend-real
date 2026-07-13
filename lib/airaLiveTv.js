const PublicSiteSettings = require('../models/PublicSiteSettings');
const { invalidatePublicSettingsCaches } = require('./cache');
const { bumpPublicConfigVersion } = require('../services/publicConfigVersion.service');
const { ensureCategoryStripEnabled } = require('../controllers/publicSiteSettingsController');

function normalizeString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function isYouTubeUrl(value) {
  return /(^|\/\/)(www\.)?(youtube\.com|youtu\.be)\//i.test(normalizeString(value));
}

function isMp4Url(value) {
  return /^https?:\/\//i.test(normalizeString(value)) && /\.mp4(?:[?#].*)?$/i.test(normalizeString(value));
}

function isSupportedSourceType(value) {
  return [
    'youtube_live',
    'custom_embed',
    'aira_bulletin',
    'offline_replay',
    'scheduled_program',
    'breaking_bulletin',
    'sponsored_program',
    'maintenance',
  ].includes(normalizeString(value));
}

function normalizeYouTubeEmbedUrl(value) {
  const raw = normalizeString(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'youtu.be') {
      const id = url.pathname.split('/').filter(Boolean)[0] || '';
      return id ? `https://www.youtube.com/embed/${id}` : raw;
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname.startsWith('/embed/')) return raw;
      const id = url.searchParams.get('v') || '';
      return id ? `https://www.youtube.com/embed/${id}` : raw;
    }
  } catch (_) {}
  return raw;
}

function resolveVideoSource(videoUrl) {
  const raw = normalizeString(videoUrl);
  if (!raw) return null;
  if (isYouTubeUrl(raw)) {
    return {
      kind: 'youtube',
      provider: 'YouTube',
      embedUrl: normalizeYouTubeEmbedUrl(raw),
      fallbackVideoUrl: raw,
      videoUrl: raw,
    };
  }
  if (isMp4Url(raw)) {
    return {
      kind: 'mp4',
      provider: 'Custom Embed',
      embedUrl: '',
      fallbackVideoUrl: raw,
      videoUrl: raw,
    };
  }
  return null;
}

function resolveCurrentVideoSource(source = {}) {
  const candidates = [
    source.currentVideoUrl,
    source.videoUrl,
    source.embedUrl,
    source.fallbackVideoUrl,
  ].map(normalizeString).filter(Boolean);

  for (const candidate of candidates) {
    const video = resolveVideoSource(candidate);
    if (video) return video;
  }

  const embedUrl = normalizeString(source.embedUrl);
  if (embedUrl) {
    return {
      kind: 'embed',
      provider: 'custom_embed',
      embedUrl,
      fallbackVideoUrl: normalizeString(source.fallbackVideoUrl),
      videoUrl: normalizeString(source.currentVideoUrl) || embedUrl,
    };
  }

  return null;
}

function providerForPublic(video, fallbackProvider = '') {
  if (video?.kind === 'youtube') return 'youtube';
  if (video?.kind === 'mp4') return 'video';
  const provider = normalizeString(fallbackProvider).toLowerCase();
  if (provider.includes('youtube')) return 'youtube';
  if (provider.includes('video')) return 'video';
  if (provider.includes('embed') || video?.kind === 'embed') return 'custom_embed';
  return provider || 'custom_embed';
}

function labelForSourceType(sourceType) {
  switch (normalizeString(sourceType)) {
    case 'youtube_live':
    case 'custom_embed':
      return 'LIVE';
    case 'aira_bulletin':
      return 'AIRA BULLETIN • ON AIR';
    case 'offline_replay':
      return 'REPLAY';
    case 'scheduled_program':
      return 'SCHEDULED';
    case 'breaking_bulletin':
      return 'BREAKING BULLETIN';
    case 'sponsored_program':
      return 'SPONSORED PROGRAM';
    case 'maintenance':
    default:
      return 'COMING SOON';
  }
}

function maintenanceCurrentSource(message = 'Live TV video is not available right now.') {
  return {
    enabled: false,
    sourceType: 'maintenance',
    title: '',
    subtitle: '',
    label: 'COMING SOON',
    status: 'maintenance',
    provider: '',
    embedUrl: '',
    fallbackVideoUrl: '',
    currentVideoUrl: '',
    currentProgramTitle: '',
    currentProgramLabel: 'COMING SOON',
    startTime: '',
    endTime: '',
    showOnHomepage: false,
    updatedAt: '',
    message,
  };
}

function bulletinSubtitle(bulletin) {
  return [normalizeString(bulletin.bulletinType), normalizeString(bulletin.language)].filter(Boolean).join(' • ');
}

function buildAiraLiveTvPatch(bulletin, options = {}) {
  const video = resolveVideoSource(bulletin.videoUrl);
  if (!video) return null;
  const now = new Date().toISOString();
  const label = normalizeString(options.label) || 'AIRA BULLETIN • ON AIR';
  const startTime = normalizeString(options.startTime) || now;
  const endTime = normalizeString(options.endTime);

  return {
    enabled: true,
    mode: 'AIRA Bulletin',
    provider: video.provider,
    embedUrl: video.embedUrl,
    fallbackVideoUrl: video.fallbackVideoUrl,
    title: normalizeString(bulletin.title) || 'AIRA Bulletin',
    subtitle: bulletinSubtitle(bulletin),
    language: normalizeString(bulletin.language) || 'English',
    showOnHomepage: true,
    status: 'live',
    sourceType: 'aira_bulletin',
    airaBulletinId: String(bulletin._id || bulletin.id || ''),
    currentProgramTitle: normalizeString(bulletin.title) || 'AIRA Bulletin',
    currentProgramLabel: label,
    currentProgramType: normalizeString(bulletin.bulletinType) || 'AIRA Bulletin',
    currentVideoUrl: video.videoUrl,
    startTime,
    endTime,
    updatedAt: now,
  };
}

function buildReplayLiveTvPatch(bulletin) {
  const video = resolveVideoSource(bulletin.videoUrl);
  if (!video) return null;
  const now = new Date().toISOString();
  return {
    enabled: true,
    mode: 'Offline Replay',
    provider: video.provider,
    embedUrl: video.embedUrl,
    fallbackVideoUrl: video.fallbackVideoUrl,
    title: normalizeString(bulletin.title) || 'AIRA Replay',
    subtitle: bulletinSubtitle(bulletin),
    language: normalizeString(bulletin.language) || 'English',
    showOnHomepage: true,
    status: 'replay',
    sourceType: 'offline_replay',
    airaBulletinId: String(bulletin._id || bulletin.id || ''),
    currentProgramTitle: normalizeString(bulletin.title) || 'AIRA Replay',
    currentProgramLabel: 'REPLAY',
    currentProgramType: normalizeString(bulletin.bulletinType) || 'AIRA Bulletin',
    currentVideoUrl: video.videoUrl,
    startTime: '',
    endTime: '',
    updatedAt: now,
  };
}

function buildScheduledProgram(bulletin, body = {}) {
  const video = resolveVideoSource(bulletin.videoUrl);
  if (!video) return null;
  return {
    id: `aira:${String(bulletin._id || bulletin.id || '')}`,
    sourceType: 'scheduled_program',
    programSourceType: 'aira_bulletin',
    airaBulletinId: String(bulletin._id || bulletin.id || ''),
    title: normalizeString(bulletin.title) || 'AIRA Bulletin',
    label: normalizeString(body.label) || 'SCHEDULED',
    bulletinType: normalizeString(bulletin.bulletinType),
    language: normalizeString(bulletin.language),
    scheduleDate: normalizeString(body.scheduleDate) || normalizeString(bulletin.scheduleDate),
    startTime: normalizeString(body.startTime) || normalizeString(bulletin.scheduleTime),
    endTime: normalizeString(body.endTime) || normalizeString(bulletin.endTime),
    videoUrl: video.videoUrl,
    embedUrl: video.embedUrl,
    fallbackVideoUrl: video.fallbackVideoUrl,
    updatedAt: new Date().toISOString(),
  };
}

function upsertScheduledProgram(liveTv, program) {
  const current = Array.isArray(liveTv.scheduledPrograms) ? liveTv.scheduledPrograms : [];
  return [...current.filter((item) => String(item?.airaBulletinId || '') !== String(program.airaBulletinId)), program];
}

function removeBulletinAssociations(liveTv, bulletinId) {
  const next = { ...(liveTv || {}) };
  next.scheduledPrograms = Array.isArray(next.scheduledPrograms)
    ? next.scheduledPrograms.filter((item) => String(item?.airaBulletinId || '') !== String(bulletinId))
    : [];

  if (String(next.airaBulletinId || '') === String(bulletinId)) {
    next.status = 'offline';
    next.mode = 'Offline Replay';
    next.sourceType = 'offline_replay';
    next.airaBulletinId = '';
    next.currentProgramTitle = '';
    next.currentProgramLabel = '';
    next.currentProgramType = '';
    next.currentVideoUrl = '';
    next.embedUrl = '';
    next.fallbackVideoUrl = '';
    next.startTime = '';
    next.endTime = '';
    next.updatedAt = new Date().toISOString();
  }
  return next;
}

async function updateExistingLiveTv(mutator) {
  const settings = await PublicSiteSettings.getOrCreate();
  const baseDraft = ensureCategoryStripEnabled(settings.draft || PublicSiteSettings.getDefaultSettings());
  const basePublished = ensureCategoryStripEnabled(settings.published || PublicSiteSettings.getDefaultSettings());
  const draftLiveTv = cloneJson(baseDraft.liveTv || {});
  const publishedLiveTv = cloneJson(basePublished.liveTv || {});
  const nextDraftLiveTv = mutator(draftLiveTv);
  const nextPublishedLiveTv = mutator(publishedLiveTv);

  settings.draft = ensureCategoryStripEnabled({ ...baseDraft, liveTv: nextDraftLiveTv });
  settings.published = ensureCategoryStripEnabled({ ...basePublished, liveTv: nextPublishedLiveTv });
  if (typeof settings.version !== 'number') settings.version = 1;
  settings.version += 1;
  settings.publishedUpdatedAt = new Date();
  await settings.save();
  invalidatePublicSettingsCaches().catch(() => {});
  bumpPublicConfigVersion().catch(() => {});
  return settings.published.liveTv;
}

function dateTimeFromSchedule(date, time) {
  const dateText = normalizeString(date);
  const timeText = normalizeString(time);
  if (!dateText || !timeText) return null;
  const candidate = new Date(`${dateText}T${timeText}:00`);
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function isWithinScheduledWindow(program, now = new Date()) {
  const date = normalizeString(program.scheduleDate);
  const start = normalizeString(program.startTime);
  const end = normalizeString(program.endTime);
  if (!date || !start) return false;
  const startDate = dateTimeFromSchedule(date, start);
  let endDate = end ? dateTimeFromSchedule(date, end) : (startDate ? new Date(startDate.getTime() + 30 * 60 * 1000) : null);
  if (!startDate || !endDate) return false;
  if (endDate < startDate) endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
  return now >= startDate && now <= endDate;
}

function inferSourceType(source, video) {
  const explicit = normalizeString(source.sourceType);
  if (isSupportedSourceType(explicit)) return explicit;

  const status = normalizeString(source.status).toLowerCase();
  const mode = normalizeString(source.mode).toLowerCase();
  const provider = normalizeString(source.provider).toLowerCase();
  if (status === 'maintenance' || mode.includes('maintenance') || mode.includes('coming soon')) return 'maintenance';
  if (status === 'replay' || mode.includes('replay')) return 'offline_replay';
  if (mode.includes('breaking')) return 'breaking_bulletin';
  if (mode.includes('aira')) return 'aira_bulletin';
  if (status === 'scheduled' || mode.includes('scheduled')) return 'scheduled_program';
  if (video?.kind === 'youtube' || provider.includes('youtube')) return 'youtube_live';
  if (video?.kind === 'mp4' || provider.includes('video')) return 'custom_embed';
  if (normalizeString(source.embedUrl)) return 'custom_embed';
  return 'maintenance';
}

function statusForSourceType(sourceType, rawStatus = '') {
  const status = normalizeString(rawStatus).toLowerCase();
  if (sourceType === 'aira_bulletin') return status === 'scheduled' ? 'scheduled' : 'on_air';
  if (sourceType === 'breaking_bulletin') return 'on_air';
  if (sourceType === 'youtube_live' || sourceType === 'custom_embed' || sourceType === 'sponsored_program') return status || 'live';
  if (sourceType === 'offline_replay') return 'replay';
  if (sourceType === 'scheduled_program') return 'scheduled';
  return 'maintenance';
}

function stableCurrentSource(source, sourceType, video, overrides = {}) {
  if (!video && sourceType !== 'maintenance') return maintenanceCurrentSource();

  const title = normalizeString(overrides.title) || normalizeString(source.currentProgramTitle) || normalizeString(source.title);
  const label = normalizeString(overrides.label) || normalizeString(source.currentProgramLabel) || labelForSourceType(sourceType);
  const fallbackVideoUrl = video?.kind === 'mp4'
    ? normalizeString(video.videoUrl)
    : (normalizeString(video?.fallbackVideoUrl) || normalizeString(source.fallbackVideoUrl));
  const embedUrl = video?.kind === 'youtube'
    ? normalizeString(video.embedUrl)
    : normalizeString(video?.embedUrl) || normalizeString(source.embedUrl);
  const currentVideoUrl = normalizeString(video?.videoUrl) || normalizeString(source.currentVideoUrl) || fallbackVideoUrl || embedUrl;

  return {
    enabled: source.enabled !== false,
    sourceType,
    title,
    subtitle: normalizeString(overrides.subtitle) || normalizeString(source.subtitle),
    label,
    status: normalizeString(overrides.status) || statusForSourceType(sourceType, source.status),
    provider: providerForPublic(video, source.provider),
    embedUrl,
    fallbackVideoUrl,
    currentVideoUrl,
    currentProgramTitle: normalizeString(overrides.currentProgramTitle) || normalizeString(source.currentProgramTitle) || title,
    currentProgramLabel: label,
    startTime: normalizeString(overrides.startTime) || normalizeString(source.startTime),
    endTime: normalizeString(overrides.endTime) || normalizeString(source.endTime),
    showOnHomepage: source.showOnHomepage !== false,
    updatedAt: normalizeString(overrides.updatedAt) || normalizeString(source.updatedAt),
    mode: normalizeString(source.mode),
    language: normalizeString(source.language),
  };
}

function scheduledCurrentSource(program) {
  const video = resolveCurrentVideoSource(program);
  if (!video) return maintenanceCurrentSource();
  return stableCurrentSource(
    {
      ...program,
      enabled: true,
      sourceType: 'scheduled_program',
      status: 'scheduled',
      currentProgramLabel: normalizeString(program.label) || labelForSourceType('scheduled_program'),
      currentProgramTitle: normalizeString(program.title),
      showOnHomepage: true,
    },
    'scheduled_program',
    video,
    {
      title: normalizeString(program.title),
      subtitle: [normalizeString(program.bulletinType), normalizeString(program.language)].filter(Boolean).join(' • '),
      label: normalizeString(program.label) || labelForSourceType('scheduled_program'),
      startTime: normalizeString(program.startTime),
      endTime: normalizeString(program.endTime),
      updatedAt: normalizeString(program.updatedAt),
    },
  );
}

function toCurrentSource(liveTv) {
  const source = liveTv && typeof liveTv === 'object' ? liveTv : {};
  const activeVideo = resolveCurrentVideoSource(source);
  const sourceType = inferSourceType(source, activeVideo);

  if (source.enabled === false) return maintenanceCurrentSource();

  if (sourceType === 'breaking_bulletin') {
    return stableCurrentSource(source, 'breaking_bulletin', activeVideo);
  }

  if (sourceType === 'youtube_live' || sourceType === 'custom_embed' || (sourceType === 'aira_bulletin' && normalizeString(source.status).toLowerCase() === 'live')) {
    return stableCurrentSource(source, sourceType, activeVideo);
  }

  const scheduled = Array.isArray(source.scheduledPrograms)
    ? source.scheduledPrograms.find((item) => isWithinScheduledWindow(item))
    : null;
  if (scheduled) {
    return scheduledCurrentSource(scheduled);
  }

  if (sourceType === 'aira_bulletin') {
    return stableCurrentSource(source, 'aira_bulletin', activeVideo);
  }

  if (sourceType === 'offline_replay') {
    return stableCurrentSource(source, 'offline_replay', activeVideo);
  }

  return maintenanceCurrentSource();
}

module.exports = {
  buildAiraLiveTvPatch,
  buildReplayLiveTvPatch,
  buildScheduledProgram,
  removeBulletinAssociations,
  resolveVideoSource,
  toCurrentSource,
  updateExistingLiveTv,
  upsertScheduledProgram,
};