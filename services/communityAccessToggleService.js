const mongoose = require('mongoose');
const FounderFeatureToggles = require('../models/FounderFeatureToggles');
const FeatureToggles = require('../models/FeatureToggles');
const CommunityFeatureSettings = require('../models/CommunityFeatureSettings');
const CommunitySettings = require('../models/CommunitySettings');
const SystemSettings = require('../models/SystemSettings');

const FOUNDER_TOGGLE_KEY = 'community_feature_toggles';

const DEFAULT_FOUNDER_TOGGLES = {
  communityReporterClosed: false,
  reporterPortalClosed: false,
};

function toPlain(doc) {
  if (!doc) return null;
  if (typeof doc.toObject === 'function') return doc.toObject();
  return doc;
}

function shouldBypassStorageReads() {
  return (
    process.env.NODE_ENV === 'test' &&
    process.env.NEWSPULSE_ENABLE_TOGGLE_QUERY_IN_TESTS !== '1' &&
    (!mongoose.connection || mongoose.connection.readyState !== 1)
  );
}

async function findOnePlain(model, filter) {
  if (shouldBypassStorageReads()) {
    return null;
  }
  const query = typeof filter === 'undefined' ? model.findOne() : model.findOne(filter);
  if (query && typeof query.lean === 'function') {
    return query.lean();
  }
  return toPlain(await query);
}

async function findOneAndUpdatePlain(model, filter, update, options) {
  if (shouldBypassStorageReads()) {
    return null;
  }
  const query = model.findOneAndUpdate(filter, update, options);
  if (query && typeof query.lean === 'function') {
    return query.lean();
  }
  return toPlain(await query);
}

function pickBoolean(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function getLegacyClosedToggles({ featureToggles, communityFeatureSettings, communitySettings, systemSettings }) {
  return {
    communityReporterClosed: pickBoolean(
      featureToggles && featureToggles.communityReporterClosed,
      typeof communityFeatureSettings?.communityReporterEnabled === 'boolean'
        ? !communityFeatureSettings.communityReporterEnabled
        : undefined,
      typeof communitySettings?.communityReporterEnabled === 'boolean'
        ? !communitySettings.communityReporterEnabled
        : undefined,
      typeof systemSettings?.communityReporterEnabled === 'boolean'
        ? !systemSettings.communityReporterEnabled
        : undefined,
      DEFAULT_FOUNDER_TOGGLES.communityReporterClosed
    ),
    reporterPortalClosed: pickBoolean(
      featureToggles && featureToggles.reporterPortalClosed,
      typeof communityFeatureSettings?.reporterPortalEnabled === 'boolean'
        ? !communityFeatureSettings.reporterPortalEnabled
        : undefined,
      typeof communitySettings?.allowMyStoriesPortal === 'boolean'
        ? !communitySettings.allowMyStoriesPortal
        : undefined,
      typeof systemSettings?.communityMyStoriesEnabled === 'boolean'
        ? !systemSettings.communityMyStoriesEnabled
        : undefined,
      typeof systemSettings?.reporterPortalEnabled === 'boolean'
        ? !systemSettings.reporterPortalEnabled
        : undefined,
      DEFAULT_FOUNDER_TOGGLES.reporterPortalClosed
    ),
  };
}

async function loadLegacyToggleDocs() {
  const [featureToggles, communityFeatureSettings, communitySettings, systemSettings] = await Promise.all([
    findOnePlain(FeatureToggles),
    findOnePlain(CommunityFeatureSettings, { key: 'community' }),
    findOnePlain(CommunitySettings),
    findOnePlain(SystemSettings),
  ]);

  return {
    featureToggles,
    communityFeatureSettings,
    communitySettings,
    systemSettings,
  };
}

async function getFounderToggleDoc({ createIfMissing = false } = {}) {
  const existing = await findOnePlain(FounderFeatureToggles, { key: FOUNDER_TOGGLE_KEY });
  if (existing || !createIfMissing) {
    return existing;
  }

  const legacyDocs = await loadLegacyToggleDocs();
  const seed = getLegacyClosedToggles(legacyDocs);
  return findOneAndUpdatePlain(
    FounderFeatureToggles,
    { key: FOUNDER_TOGGLE_KEY },
    {
      $setOnInsert: {
        key: FOUNDER_TOGGLE_KEY,
        ...seed,
      },
    },
    { new: true, upsert: true }
  );
}

async function updateFounderToggles(patch = {}) {
  const cleanPatch = {};
  if (typeof patch.communityReporterClosed === 'boolean') {
    cleanPatch.communityReporterClosed = patch.communityReporterClosed;
  }
  if (typeof patch.reporterPortalClosed === 'boolean') {
    cleanPatch.reporterPortalClosed = patch.reporterPortalClosed;
  }

  const existing = await getFounderToggleDoc({ createIfMissing: false });
  const seed = existing
    ? DEFAULT_FOUNDER_TOGGLES
    : getLegacyClosedToggles(await loadLegacyToggleDocs());
  const setOnInsert = {
    key: FOUNDER_TOGGLE_KEY,
  };

  if (!Object.prototype.hasOwnProperty.call(cleanPatch, 'communityReporterClosed')) {
    setOnInsert.communityReporterClosed = seed.communityReporterClosed;
  }
  if (!Object.prototype.hasOwnProperty.call(cleanPatch, 'reporterPortalClosed')) {
    setOnInsert.reporterPortalClosed = seed.reporterPortalClosed;
  }

  return findOneAndUpdatePlain(
    FounderFeatureToggles,
    { key: FOUNDER_TOGGLE_KEY },
    {
      $set: cleanPatch,
      $setOnInsert: setOnInsert,
    },
    { new: true, upsert: true }
  );
}

async function getEffectiveCommunityAccessState({ ensureFounderDoc = false } = {}) {
  const founderPromise = ensureFounderDoc
    ? getFounderToggleDoc({ createIfMissing: true })
    : getFounderToggleDoc({ createIfMissing: false });
  const legacyPromise = loadLegacyToggleDocs();

  const [founderDoc, legacyDocs] = await Promise.all([founderPromise, legacyPromise]);
  const { featureToggles, communityFeatureSettings, communitySettings, systemSettings } = legacyDocs;

  const legacyClosed = getLegacyClosedToggles(legacyDocs);
  const communityReporterClosed = typeof founderDoc?.communityReporterClosed === 'boolean'
    ? founderDoc.communityReporterClosed
    : legacyClosed.communityReporterClosed;
  const reporterPortalClosed = typeof founderDoc?.reporterPortalClosed === 'boolean'
    ? founderDoc.reporterPortalClosed
    : legacyClosed.reporterPortalClosed;

  const rawAllowNewSubmissions = pickBoolean(
    communitySettings && communitySettings.allowNewSubmissions,
    communityFeatureSettings && communityFeatureSettings.allowNewSubmissions,
    systemSettings && systemSettings.allowNewSubmissions,
    true
  );
  const rawAllowMyStoriesPortal = pickBoolean(
    communitySettings && communitySettings.allowMyStoriesPortal,
    communityFeatureSettings && communityFeatureSettings.allowMyStoriesPortal,
    true
  );
  const rawCommunityMyStoriesEnabled = pickBoolean(
    systemSettings && systemSettings.communityMyStoriesEnabled,
    rawAllowMyStoriesPortal,
    true
  );
  const allowJournalistApplications = pickBoolean(
    communitySettings && communitySettings.allowJournalistApplications,
    communityFeatureSettings && communityFeatureSettings.allowJournalistApplications,
    systemSettings && systemSettings.allowJournalistApplications,
    true
  );
  const safeModeManualReviewOnly = pickBoolean(
    communitySettings && communitySettings.safeModeManualReviewOnly,
    communityFeatureSettings && communityFeatureSettings.safeModeManualReviewOnly,
    systemSettings && systemSettings.safeModeManualReviewOnly,
    false
  );

  const communityReporterEnabled = !communityReporterClosed;
  const reporterPortalEnabled = !reporterPortalClosed;
  const allowNewSubmissions = communityReporterEnabled && rawAllowNewSubmissions;
  const communityMyStoriesEnabled = reporterPortalEnabled && rawAllowMyStoriesPortal && rawCommunityMyStoriesEnabled;
  const allowMyStoriesPortal = reporterPortalEnabled && rawAllowMyStoriesPortal && rawCommunityMyStoriesEnabled;

  return {
    communityReporterClosed,
    reporterPortalClosed,
    communityReporterEnabled,
    reporterPortalEnabled,
    allowNewSubmissions,
    allowMyStoriesPortal,
    communityMyStoriesEnabled,
    allowJournalistApplications,
    safeModeManualReviewOnly,
    updatedAt:
      founderDoc?.updatedAt ||
      featureToggles?.updatedAt ||
      communityFeatureSettings?.updatedAt ||
      communitySettings?.updatedAt ||
      systemSettings?.updatedAt ||
      null,
  };
}

module.exports = {
  DEFAULT_FOUNDER_TOGGLES,
  FOUNDER_TOGGLE_KEY,
  getEffectiveCommunityAccessState,
  getFounderToggleDoc,
  updateFounderToggles,
};