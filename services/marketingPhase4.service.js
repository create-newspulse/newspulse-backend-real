const mongoose = require('mongoose');

const Ad = require('../models/Ad');
const ArticleAnalyticsEvent = require('../models/ArticleAnalyticsEvent');
const ArticleAnalyticsSummary = require('../models/ArticleAnalyticsSummary');
const MarketingCampaignLink = require('../models/MarketingCampaignLink');
const MarketingCampaignReport = require('../models/MarketingCampaignReport');
const MarketingRenewal = require('../models/MarketingRenewal');
const MarketingPerformanceSnapshot = require('../models/MarketingPerformanceSnapshot');
const MarketingSettings = require('../models/MarketingSettings');
const MarketingPromotionCampaign = require('../models/MarketingPromotionCampaign');
const MarketingGrowthGoal = require('../models/MarketingGrowthGoal');
const MarketingProposal = require('../models/MarketingProposal');

const SOURCE_STATUSES = new Set(['connected', 'not_connected', 'partial', 'error']);
const REPORT_STATUSES = new Set(['draft', 'ready', 'pending_approval', 'approved', 'shared', 'archived']);
const RENEWAL_STATUSES = new Set(['upcoming', 'contact_due', 'contacted', 'interested', 'proposal', 'negotiation', 'renewed', 'not_renewing', 'paused']);
const OPEN_RENEWAL_STATUSES = ['upcoming', 'contact_due', 'contacted', 'interested', 'proposal', 'negotiation', 'paused'];

const REPORT_TRANSITIONS = Object.freeze({
  draft: ['ready', 'archived'],
  ready: ['draft', 'pending_approval', 'approved', 'shared', 'archived'],
  pending_approval: ['ready', 'approved', 'draft', 'archived'],
  approved: ['shared', 'archived'],
  shared: ['archived'],
  archived: [],
});

const RENEWAL_TRANSITIONS = Object.freeze({
  upcoming: ['contact_due', 'contacted', 'paused', 'not_renewing'],
  contact_due: ['contacted', 'interested', 'paused', 'not_renewing'],
  contacted: ['interested', 'proposal', 'paused', 'not_renewing'],
  interested: ['proposal', 'negotiation', 'paused', 'not_renewing'],
  proposal: ['negotiation', 'renewed', 'paused', 'not_renewing'],
  negotiation: ['renewed', 'paused', 'not_renewing'],
  paused: ['upcoming', 'contact_due', 'contacted', 'interested', 'proposal', 'negotiation', 'not_renewing'],
  renewed: [],
  not_renewing: [],
});

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function asString(value, max = 500) {
  const out = String(value || '').trim();
  return out ? out.slice(0, max) : null;
}

function actorId(req) {
  const actor = req?.admin || req?.user || null;
  return actor?.staffId || actor?.id || actor?.email || null;
}

function isFounder(req) {
  const actor = req?.admin || req?.user || null;
  return Boolean(actor?.isFounder || String(actor?.role || '').toLowerCase() === 'founder');
}

function parsePositiveInt(value, fallback, max) {
  const n = parseInt(String(value ?? ''), 10);
  const clean = Number.isFinite(n) && n > 0 ? n : fallback;
  return Math.min(clean, max);
}

function pagination(query) {
  const page = parsePositiveInt(query?.page, 1, 100000);
  const limit = parsePositiveInt(query?.limit ?? query?.pageSize, 20, 100);
  return { page, limit, skip: (page - 1) * limit };
}

function parseDate(value, field) {
  if (value == null || value === '') return { ok: true, value: null };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { ok: false, status: 400, message: `${field} must be a valid date` };
  return { ok: true, value: date };
}

function parseDateRange(query) {
  const from = parseDate(query?.dateFrom, 'dateFrom');
  if (!from.ok) return from;
  const to = parseDate(query?.dateTo, 'dateTo');
  if (!to.ok) return to;
  if (from.value && to.value && to.value.getTime() < from.value.getTime()) {
    return { ok: false, status: 400, message: 'dateTo must be greater than or equal to dateFrom' };
  }
  return { ok: true, dateFrom: from.value, dateTo: to.value };
}

function ensureObjectId(value, field) {
  const id = asString(value, 120);
  if (!id) return { ok: true, value: null };
  if (!mongoose.isValidObjectId(id)) return { ok: false, status: 400, message: `${field} must be a valid Mongo/Object ID` };
  return { ok: true, value: id };
}

function roundMetric(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10000) / 10000;
}

function calculateCtr(impressions, clicks, trackingConnected) {
  if (impressions == null) return null;
  if (Number(impressions) > 0) return roundMetric((Number(clicks || 0) / Number(impressions)) * 100);
  return trackingConnected ? 0 : null;
}

function daysBetweenInclusive(start, end) {
  if (!start || !end) return null;
  const startMs = new Date(start).setHours(0, 0, 0, 0);
  const endMs = new Date(end).setHours(0, 0, 0, 0);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  return Math.floor((endMs - startMs) / 86400000) + 1;
}

function campaignFilterFromQuery(query) {
  const filter = { archivedAt: null };
  for (const field of ['advertiserId', 'dealId', 'status', 'ownerId']) {
    const value = asString(query?.[field], 160);
    if (value) filter[field] = value;
  }
  const campaignId = asString(query?.campaignId, 120);
  if (campaignId) {
    if (mongoose.isValidObjectId(campaignId)) filter.$or = [{ _id: campaignId }, { adsManagerCampaignId: campaignId }, { campaignLinkId: campaignId }];
    else filter.campaignLinkId = campaignId;
  }
  const dates = parseDateRange(query);
  if (!dates.ok) return dates;
  if (dates.dateFrom || dates.dateTo) {
    filter.$and = filter.$and || [];
    if (dates.dateFrom) filter.$and.push({ $or: [{ endDate: null }, { endDate: { $gte: dates.dateFrom } }] });
    if (dates.dateTo) filter.$and.push({ $or: [{ startDate: null }, { startDate: { $lte: dates.dateTo } }] });
  }
  return { ok: true, filter };
}

function reportDto(doc, canViewValues = false) {
  if (!doc) return null;
  const out = {
    id: String(doc._id),
    reportId: doc.reportId,
    advertiserId: doc.advertiserId,
    dealId: doc.dealId || null,
    proposalId: doc.proposalId || null,
    adsManagerCampaignId: doc.adsManagerCampaignId ? String(doc.adsManagerCampaignId) : null,
    title: doc.title,
    campaignStartDate: doc.campaignStartDate || null,
    campaignEndDate: doc.campaignEndDate || null,
    performanceSnapshot: doc.performanceSnapshot || null,
    performanceSource: doc.performanceSource || 'none',
    performanceCapturedAt: doc.performanceCapturedAt || null,
    summary: doc.summary || '',
    campaignNotes: doc.campaignNotes || '',
    recommendations: doc.recommendations || '',
    status: doc.status,
    preparedBy: doc.preparedBy || null,
    preparedAt: doc.preparedAt || null,
    approvedBy: doc.approvedBy || null,
    approvedAt: doc.approvedAt || null,
    approvalNote: doc.approvalNote || '',
    sharedBy: doc.sharedBy || null,
    sharedAt: doc.sharedAt || null,
    sharedVia: doc.sharedVia || null,
    archivedBy: doc.archivedBy || null,
    archivedAt: doc.archivedAt || null,
    createdBy: doc.createdBy || null,
    createdAt: doc.createdAt || null,
    updatedBy: doc.updatedBy || null,
    updatedAt: doc.updatedAt || null,
  };
  if (canViewValues) out.commercialValuesVisible = true;
  return out;
}

function renewalDto(doc, canViewValues = false) {
  if (!doc) return null;
  const out = {
    id: String(doc._id),
    renewalId: doc.renewalId,
    advertiserId: doc.advertiserId,
    previousDealId: doc.previousDealId || null,
    previousCampaignId: doc.previousCampaignId || null,
    previousProposalId: doc.previousProposalId || null,
    previousCampaignValue: canViewValues ? (doc.previousCampaignValue ?? null) : null,
    campaignEndDate: doc.campaignEndDate || null,
    followUpDate: doc.followUpDate || null,
    ownerId: doc.ownerId || null,
    status: doc.status,
    notes: doc.notes || '',
    newProposalId: doc.newProposalId || null,
    renewedDealId: doc.renewedDealId || null,
    sourceType: doc.sourceType || 'manual',
    statusHistory: Array.isArray(doc.statusHistory) ? doc.statusHistory : [],
    createdBy: doc.createdBy || null,
    createdAt: doc.createdAt || null,
    updatedBy: doc.updatedBy || null,
    updatedAt: doc.updatedAt || null,
    archivedAt: doc.archivedAt || null,
    archivedBy: doc.archivedBy || null,
  };
  return out;
}

async function getDataSourceStatus() {
  if (!isDbReady()) {
    return {
      trafficAnalytics: { status: 'not_connected', lastUpdatedAt: null },
      adTracking: { status: 'not_connected', lastUpdatedAt: null },
      campaignAttribution: { status: 'not_connected', lastUpdatedAt: null },
      revenueData: { status: 'not_connected', lastUpdatedAt: null },
    };
  }

  try {
    const [latestAnalytics, latestEvent, latestAd] = await Promise.all([
      ArticleAnalyticsSummary.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean(),
      ArticleAnalyticsEvent.findOne({}).sort({ createdAt: -1 }).select('createdAt').lean(),
      Ad.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean(),
    ]);
    const analyticsEnabled = String(process.env.ANALYTICS_ENABLED || 'true').toLowerCase() !== 'false';
    const analyticsUpdatedAt = latestAnalytics?.updatedAt || latestEvent?.createdAt || null;
    const analyticsStatus = analyticsEnabled ? 'connected' : 'not_connected';
    return {
      trafficAnalytics: { status: analyticsStatus, lastUpdatedAt: analyticsUpdatedAt },
      adTracking: { status: latestAd ? 'connected' : 'not_connected', lastUpdatedAt: latestAd?.updatedAt || null },
      campaignAttribution: { status: analyticsStatus === 'connected' ? 'partial' : 'not_connected', lastUpdatedAt: analyticsUpdatedAt },
      revenueData: { status: 'not_connected', lastUpdatedAt: null },
    };
  } catch (error) {
    return {
      trafficAnalytics: { status: 'error', lastUpdatedAt: null, error: error?.message || 'Analytics status unavailable' },
      adTracking: { status: 'error', lastUpdatedAt: null, error: error?.message || 'Ad tracking status unavailable' },
      campaignAttribution: { status: 'error', lastUpdatedAt: null, error: error?.message || 'Attribution status unavailable' },
      revenueData: { status: 'not_connected', lastUpdatedAt: null },
    };
  }
}

async function buildCampaignPerformance(link, sourceStatus = null) {
  let ad = null;
  if (link?.adsManagerCampaignId && mongoose.isValidObjectId(String(link.adsManagerCampaignId))) {
    ad = await Ad.findById(link.adsManagerCampaignId).lean();
  }
  const statuses = sourceStatus || await getDataSourceStatus();
  const hasAdStats = Boolean(ad && ad.stats && typeof ad.stats.impressions === 'number' && typeof ad.stats.clicks === 'number');
  const trackingStatus = hasAdStats ? 'connected' : (statuses.adTracking.status === 'connected' ? 'partial' : statuses.adTracking.status);
  const impressions = hasAdStats ? Number(ad.stats.impressions || 0) : null;
  const clicks = hasAdStats ? Number(ad.stats.clicks || 0) : null;
  const scheduledDays = daysBetweenInclusive(link.startDate, link.endDate);
  const deliveredDays = scheduledDays == null ? null : Math.max(0, Math.min(scheduledDays, daysBetweenInclusive(link.startDate, new Date()) || 0));
  return {
    campaignId: String(link._id),
    campaignLinkId: link.campaignLinkId || null,
    adsManagerCampaignId: link.adsManagerCampaignId ? String(link.adsManagerCampaignId) : null,
    advertiserId: link.advertiserId,
    advertiserName: link.advertiserName || null,
    dealId: link.dealId || null,
    proposalId: link.proposalId || null,
    campaignName: link.campaignName,
    status: link.status,
    startDate: link.startDate || null,
    endDate: link.endDate || null,
    placements: Array.isArray(link.placements) ? link.placements : [],
    languages: Array.isArray(link.languages) ? link.languages : [],
    targetRegion: link.targetRegion || null,
    ownerId: link.ownerId || null,
    performance: {
      impressions,
      clicks,
      ctr: calculateCtr(impressions, clicks, trackingStatus === 'connected'),
      deliveredDays,
      scheduledDays,
      source: hasAdStats ? 'ads_manager' : 'ads_manager',
      trackingStatus: SOURCE_STATUSES.has(trackingStatus) ? trackingStatus : 'error',
      lastUpdatedAt: ad?.updatedAt || link.updatedAt || null,
    },
    adsManagerUpdatedAt: ad?.updatedAt || null,
  };
}

async function listCampaignPerformance(query) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const filterResult = campaignFilterFromQuery(query);
  if (!filterResult.ok) return { status: filterResult.status, body: { ok: false, message: filterResult.message } };
  const { page, limit, skip } = pagination(query);
  const [total, links, sourceStatus] = await Promise.all([
    MarketingCampaignLink.countDocuments(filterResult.filter),
    MarketingCampaignLink.find(filterResult.filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
    getDataSourceStatus(),
  ]);
  const items = [];
  for (const link of links) items.push(await buildCampaignPerformance(link, sourceStatus));
  return { status: 200, body: { ok: true, items, page, limit, total, sourceStatus } };
}

async function getCampaignPerformance(id) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { campaignLinkId: value, archivedAt: null };
  const link = await MarketingCampaignLink.findOne(filter).lean();
  if (!link) return { status: 404, body: { ok: false, message: 'Campaign not found' } };
  const sourceStatus = await getDataSourceStatus();
  const campaign = await buildCampaignPerformance(link, sourceStatus);
  return { status: 200, body: { ok: true, campaign, sourceStatus } };
}

async function promotionPerformance(query) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const dates = parseDateRange(query);
  if (!dates.ok) return { status: dates.status, body: { ok: false, message: dates.message } };
  const sourceStatus = await getDataSourceStatus();
  const attributionStatus = sourceStatus.campaignAttribution.status;
  if (attributionStatus === 'not_connected' || attributionStatus === 'error') {
    return { status: 200, body: { ok: true, status: attributionStatus, metrics: null, items: [], sourceStatus } };
  }
  const filter = { archivedAt: null };
  for (const field of ['promotionId', 'utmCampaign', 'language', 'channel']) {
    const value = asString(query?.[field], 160);
    if (value) filter[field] = value;
  }
  const { page, limit, skip } = pagination(query);
  const [total, promotions] = await Promise.all([
    MarketingPromotionCampaign.countDocuments(filter),
    MarketingPromotionCampaign.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  const eventMatch = { eventType: 'view' };
  if (dates.dateFrom || dates.dateTo) eventMatch.createdAt = {};
  if (dates.dateFrom) eventMatch.createdAt.$gte = dates.dateFrom;
  if (dates.dateTo) eventMatch.createdAt.$lte = dates.dateTo;
  const channel = asString(query?.channel, 80);
  if (channel) eventMatch.source = channel;
  const language = asString(query?.language, 80);
  if (language) eventMatch.language = language;

  const metrics = await ArticleAnalyticsEvent.aggregate([
    { $match: eventMatch },
    {
      $group: {
        _id: null,
        users: { $addToSet: '$visitorId' },
        sessions: { $addToSet: '$sessionId' },
        pageViews: { $sum: 1 },
      },
    },
    { $project: { _id: 0, users: { $size: '$users' }, sessions: { $size: '$sessions' }, pageViews: 1 } },
  ]);
  const breakdown = await ArticleAnalyticsEvent.aggregate([
    { $match: eventMatch },
    { $group: { _id: { source: '$source', medium: null, campaign: null, content: null }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);
  const row = metrics[0] || null;
  return {
    status: 200,
    body: {
      ok: true,
      status: attributionStatus,
      metrics: row ? { users: row.users, sessions: row.sessions, newUsers: null, pageViews: row.pageViews, engagement: null, conversions: null } : null,
      breakdown: breakdown.map((entry) => ({ utm_source: entry._id.source || null, utm_medium: entry._id.medium, utm_campaign: entry._id.campaign, utm_content: entry._id.content, count: entry.count })),
      items: promotions.map((p) => ({ id: String(p._id), promotionId: p.promotionId, title: p.title, utmCampaign: p.utmCampaign || null, language: p.language || null, channel: p.channel || null, status: p.status, startDate: p.startDate || null, endDate: p.endDate || null })),
      page,
      limit,
      total,
      sourceStatus,
    },
  };
}

async function performanceSummary() {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const now = new Date();
  const [activeAdvertiserCampaigns, completedAdvertiserCampaigns, activePromotions, completedPromotions, renewalsDue, reportsReady, sourceStatus] = await Promise.all([
    MarketingCampaignLink.countDocuments({ archivedAt: null, status: 'active' }),
    MarketingCampaignLink.countDocuments({ archivedAt: null, status: 'completed' }),
    MarketingPromotionCampaign.countDocuments({ archivedAt: null, status: 'active' }),
    MarketingPromotionCampaign.countDocuments({ archivedAt: null, status: 'completed' }),
    MarketingRenewal.countDocuments({ archivedAt: null, status: { $in: OPEN_RENEWAL_STATUSES }, followUpDate: { $lte: now } }),
    MarketingCampaignReport.countDocuments({ archivedAt: null, status: { $in: ['ready', 'approved'] } }),
    getDataSourceStatus(),
  ]);
  let analytics = { status: sourceStatus.trafficAnalytics.status, websiteUsers: null, campaignSessions: null, returningUsers: null, organicUsers: null, analyticsUpdatedAt: sourceStatus.trafficAnalytics.lastUpdatedAt || null };
  if (sourceStatus.trafficAnalytics.status === 'connected' || sourceStatus.trafficAnalytics.status === 'partial') {
    const rows = await ArticleAnalyticsEvent.aggregate([
      { $match: { eventType: 'view' } },
      { $group: { _id: null, users: { $addToSet: '$visitorId' }, sessions: { $addToSet: '$sessionId' }, organicUsers: { $addToSet: { $cond: [{ $eq: ['$source', 'google'] }, '$visitorId', '$$REMOVE'] } } } },
      { $project: { _id: 0, websiteUsers: { $size: '$users' }, campaignSessions: { $size: '$sessions' }, organicUsers: { $size: '$organicUsers' } } },
    ]);
    analytics = { ...analytics, ...(rows[0] || { websiteUsers: null, campaignSessions: null, organicUsers: null }), returningUsers: null };
  }
  return { status: 200, body: { ok: true, counts: { activeAdvertiserCampaigns, completedAdvertiserCampaigns, activePromotions, completedPromotions, renewalsDue, reportsReady }, analytics, sourceStatus } };
}

function performanceSnapshotFromCampaign(campaign) {
  const perf = campaign?.performance || {};
  return {
    impressions: perf.impressions ?? null,
    clicks: perf.clicks ?? null,
    ctr: perf.ctr ?? null,
    status: perf.trackingStatus || 'not_connected',
    trackingStatus: perf.trackingStatus || 'not_connected',
    source: perf.source || 'none',
    lastUpdatedAt: perf.lastUpdatedAt || null,
  };
}

function generateId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

async function createCampaignReport(body, req) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const campaignId = asString(body?.campaignId || body?.campaignLinkId || body?.dealId, 160);
  if (!campaignId) return { status: 400, body: { ok: false, message: 'campaignId or dealId is required' } };
  const title = asString(body?.title, 180);
  if (!title) return { status: 400, body: { ok: false, message: 'title is required' } };
  const filter = mongoose.isValidObjectId(campaignId) ? { $or: [{ _id: campaignId }, { adsManagerCampaignId: campaignId }, { dealId: campaignId }], archivedAt: null } : { $or: [{ campaignLinkId: campaignId }, { dealId: campaignId }], archivedAt: null };
  const link = await MarketingCampaignLink.findOne(filter).lean();
  if (!link) return { status: 404, body: { ok: false, message: 'Marketing campaign reference not found' } };
  const existing = await MarketingCampaignReport.findOne({ marketingCampaignLinkId: link._id, status: { $ne: 'archived' }, archivedAt: null }).lean();
  if (existing && String(body?.allowDuplicate || '').toLowerCase() !== 'true') {
    return { status: 409, body: { ok: false, code: 'DUPLICATE_REPORT', message: 'An active report already exists for this campaign', report: reportDto(existing) } };
  }
  const campaign = await buildCampaignPerformance(link);
  const now = new Date();
  const report = await MarketingCampaignReport.create({
    reportId: generateId('MCR'),
    advertiserId: link.advertiserId,
    dealId: link.dealId || null,
    proposalId: link.proposalId || null,
    marketingCampaignLinkId: link._id,
    adsManagerCampaignId: link.adsManagerCampaignId || null,
    title,
    campaignStartDate: link.startDate || null,
    campaignEndDate: link.endDate || null,
    performanceSnapshot: performanceSnapshotFromCampaign(campaign),
    performanceSource: campaign.performance.source || 'none',
    performanceCapturedAt: now,
    summary: asString(body?.summary, 5000) || '',
    campaignNotes: asString(body?.campaignNotes || body?.notes, 5000) || '',
    recommendations: asString(body?.recommendations, 5000) || '',
    createdBy: actorId(req),
    updatedBy: actorId(req),
  });
  return { status: 201, body: { ok: true, report: reportDto(report) }, audit: { action: 'MARKETING_CAMPAIGN_REPORT_CREATED', targetId: String(report._id), targetType: 'marketing_campaign_report' } };
}

async function listCampaignReports(query, canViewValues = false) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const filter = { archivedAt: null };
  for (const field of ['advertiserId', 'dealId', 'proposalId', 'status']) {
    const value = asString(query?.[field], 160);
    if (value) filter[field] = value;
  }
  const { page, limit, skip } = pagination(query);
  const [total, reports] = await Promise.all([
    MarketingCampaignReport.countDocuments(filter),
    MarketingCampaignReport.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { status: 200, body: { ok: true, items: reports.map((report) => reportDto(report, canViewValues)), page, limit, total } };
}

async function getCampaignReport(id, canViewValues = false) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { reportId: value, archivedAt: null };
  const report = await MarketingCampaignReport.findOne(filter).lean();
  if (!report) return { status: 404, body: { ok: false, message: 'Report not found' } };
  return { status: 200, body: { ok: true, report: reportDto(report, canViewValues) } };
}

async function updateCampaignReport(id, body, req) {
  const value = asString(id, 160);
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { reportId: value, archivedAt: null };
  const report = await MarketingCampaignReport.findOne(filter);
  if (!report) return { status: 404, body: { ok: false, message: 'Report not found' } };
  if (['shared', 'archived'].includes(report.status)) return { status: 409, body: { ok: false, message: 'Shared or archived reports cannot be edited through this API' } };
  const patch = {};
  for (const field of ['title', 'summary', 'campaignNotes', 'recommendations']) {
    if (Object.prototype.hasOwnProperty.call(body || {}, field)) patch[field] = asString(body[field], field === 'title' ? 180 : 5000) || '';
  }
  patch.updatedBy = actorId(req);
  const updated = await MarketingCampaignReport.findByIdAndUpdate(report._id, { $set: patch }, { new: true });
  return { status: 200, body: { ok: true, report: reportDto(updated) } };
}

async function refreshCampaignReportPerformance(id, req) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { reportId: value, archivedAt: null };
  const report = await MarketingCampaignReport.findOne(filter);
  if (!report) return { status: 404, body: { ok: false, message: 'Report not found' } };
  if (['shared', 'archived'].includes(report.status) && !isFounder(req)) return { status: 409, body: { ok: false, message: 'Shared or archived reports cannot be refreshed by normal staff' } };
  const link = report.marketingCampaignLinkId ? await MarketingCampaignLink.findById(report.marketingCampaignLinkId).lean() : await MarketingCampaignLink.findOne({ adsManagerCampaignId: report.adsManagerCampaignId, archivedAt: null }).lean();
  if (!link) return { status: 404, body: { ok: false, message: 'Marketing campaign reference not found' } };
  const campaign = await buildCampaignPerformance(link);
  const now = new Date();
  report.performanceSnapshot = performanceSnapshotFromCampaign(campaign);
  report.performanceSource = campaign.performance.source || 'none';
  report.performanceCapturedAt = now;
  report.updatedBy = actorId(req);
  await report.save();
  return { status: 200, body: { ok: true, report: reportDto(report) }, audit: { action: 'MARKETING_CAMPAIGN_PERFORMANCE_REFRESHED', targetId: String(report._id), targetType: 'marketing_campaign_report' } };
}

async function transitionCampaignReport(id, body, req, canApprove, canArchive = false) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const nextStatus = asString(body?.status, 80);
  if (!REPORT_STATUSES.has(nextStatus)) return { status: 400, body: { ok: false, message: 'Invalid report status' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { reportId: value, archivedAt: null };
  const report = await MarketingCampaignReport.findOne(filter);
  if (!report) return { status: 404, body: { ok: false, message: 'Report not found' } };
  const from = report.status;
  if (!REPORT_TRANSITIONS[from].includes(nextStatus)) return { status: 409, body: { ok: false, message: `Cannot change report status from ${from} to ${nextStatus}` } };
  if (nextStatus === 'archived' && !canArchive) return { status: 403, body: { ok: false, message: 'delete_campaign_report permission required' } };
  const settings = await MarketingSettings.findById('global').lean();
  if (nextStatus === 'shared' && settings?.requireCampaignReportApproval && report.status !== 'approved' && !canApprove) {
    return { status: 403, body: { ok: false, code: 'APPROVAL_REQUIRED', message: 'Campaign report approval is required before sharing' } };
  }
  if (nextStatus === 'approved' && !canApprove) return { status: 403, body: { ok: false, message: 'approve_campaign_report permission required' } };
  const now = new Date();
  report.status = nextStatus;
  report.updatedBy = actorId(req);
  if (nextStatus === 'ready') {
    report.preparedBy = actorId(req);
    report.preparedAt = now;
  }
  if (nextStatus === 'approved') {
    report.approvedBy = actorId(req);
    report.approvedAt = now;
    report.approvalNote = asString(body?.approvalNote, 1000) || '';
  }
  if (nextStatus === 'archived') {
    report.archivedBy = actorId(req);
    report.archivedAt = now;
  }
  await report.save();
  return { status: 200, body: { ok: true, report: reportDto(report) }, audit: { action: nextStatus === 'approved' ? 'MARKETING_CAMPAIGN_REPORT_APPROVED' : (nextStatus === 'archived' ? 'MARKETING_CAMPAIGN_REPORT_ARCHIVED' : 'MARKETING_CAMPAIGN_REPORT_STATUS_CHANGED'), targetId: String(report._id), targetType: 'marketing_campaign_report', oldValue: { status: from }, newValue: { status: nextStatus } } };
}

async function markCampaignReportShared(id, body, req, canApprove) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { reportId: value, archivedAt: null };
  const report = await MarketingCampaignReport.findOne(filter);
  if (!report) return { status: 404, body: { ok: false, message: 'Report not found' } };
  const settings = await MarketingSettings.findById('global').lean();
  if (settings?.requireCampaignReportApproval && report.status !== 'approved' && !canApprove) {
    return { status: 403, body: { ok: false, code: 'APPROVAL_REQUIRED', message: 'Campaign report approval is required before sharing' } };
  }
  if (!['ready', 'approved'].includes(report.status)) return { status: 409, body: { ok: false, message: 'Only ready or approved reports can be marked shared' } };
  report.status = 'shared';
  report.sharedBy = actorId(req);
  report.sharedAt = new Date();
  const via = asString(body?.sharedVia, 40);
  report.sharedVia = ['email', 'whatsapp', 'in_person', 'other'].includes(via) ? via : null;
  report.updatedBy = actorId(req);
  await report.save();
  return { status: 200, body: { ok: true, report: reportDto(report) }, audit: { action: 'MARKETING_CAMPAIGN_REPORT_SHARED', targetId: String(report._id), targetType: 'marketing_campaign_report' } };
}

async function createRenewal(body, req) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const advertiserId = asString(body?.advertiserId, 160);
  const ownerId = asString(body?.ownerId, 160);
  if (!advertiserId) return { status: 400, body: { ok: false, message: 'advertiserId is required' } };
  if (!ownerId) return { status: 400, body: { ok: false, message: 'ownerId is required' } };
  const followUp = parseDate(body?.followUpDate, 'followUpDate');
  if (!followUp.ok || !followUp.value) return { status: 400, body: { ok: false, message: followUp.message || 'followUpDate is required' } };
  const previousDealId = asString(body?.previousDealId, 160);
  const previousCampaignId = asString(body?.previousCampaignId, 160);
  const duplicate = await MarketingRenewal.findOne({ advertiserId, previousDealId: previousDealId || null, previousCampaignId: previousCampaignId || null, archivedAt: null, status: { $in: OPEN_RENEWAL_STATUSES } }).lean();
  if (duplicate && String(body?.allowDuplicate || '').toLowerCase() !== 'true') {
    return { status: 409, body: { ok: false, code: 'DUPLICATE_RENEWAL', message: 'An active renewal already exists for this advertiser/source', renewal: renewalDto(duplicate, true) } };
  }
  const campaignEnd = parseDate(body?.campaignEndDate, 'campaignEndDate');
  if (!campaignEnd.ok) return { status: campaignEnd.status, body: { ok: false, message: campaignEnd.message } };
  const renewal = await MarketingRenewal.create({
    renewalId: generateId('MRN'),
    advertiserId,
    previousDealId: previousDealId || null,
    previousCampaignId: previousCampaignId || null,
    previousProposalId: asString(body?.previousProposalId, 160),
    previousCampaignValue: body?.previousCampaignValue == null ? null : Number(body.previousCampaignValue),
    campaignEndDate: campaignEnd.value,
    followUpDate: followUp.value,
    ownerId,
    status: asString(body?.status, 40) && RENEWAL_STATUSES.has(asString(body.status, 40)) ? asString(body.status, 40) : 'upcoming',
    notes: asString(body?.notes, 5000) || '',
    sourceType: ['completed_advertiser_campaign', 'won_deal', 'completed_partnership', 'manual'].includes(asString(body?.sourceType, 80)) ? asString(body.sourceType, 80) : 'manual',
    createdBy: actorId(req),
    updatedBy: actorId(req),
  });
  return { status: 201, body: { ok: true, renewal: renewalDto(renewal, true) }, audit: { action: 'MARKETING_RENEWAL_CREATED', targetId: String(renewal._id), targetType: 'marketing_renewal' } };
}

function renewalFilterFromQuery(query) {
  const filter = { archivedAt: null };
  for (const field of ['status', 'advertiserId', 'ownerId']) {
    const value = asString(query?.[field], 160);
    if (value) filter[field] = value;
  }
  const dates = parseDateRange(query);
  if (!dates.ok) return dates;
  if (dates.dateFrom || dates.dateTo) {
    filter.followUpDate = {};
    if (dates.dateFrom) filter.followUpDate.$gte = dates.dateFrom;
    if (dates.dateTo) filter.followUpDate.$lte = dates.dateTo;
  }
  const category = asString(query?.category, 40);
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
  const days = (n) => new Date(todayEnd.getTime() + n * 86400000);
  if (query?.due === 'true' || category === 'dueToday') filter.followUpDate = { $gte: todayStart, $lte: todayEnd };
  if (query?.overdue === 'true' || category === 'overdue') filter.followUpDate = { $lt: todayStart };
  if (category === 'next7Days') filter.followUpDate = { $gte: todayStart, $lte: days(7) };
  if (category === 'next30Days') filter.followUpDate = { $gte: todayStart, $lte: days(30) };
  return { ok: true, filter };
}

async function listRenewals(query, canViewValues = false) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const filterResult = renewalFilterFromQuery(query);
  if (!filterResult.ok) return { status: filterResult.status, body: { ok: false, message: filterResult.message } };
  const { page, limit, skip } = pagination(query);
  const [total, docs] = await Promise.all([
    MarketingRenewal.countDocuments(filterResult.filter),
    MarketingRenewal.find(filterResult.filter).sort({ followUpDate: 1, updatedAt: -1 }).skip(skip).limit(limit).lean(),
  ]);
  return { status: 200, body: { ok: true, items: docs.map((doc) => renewalDto(doc, canViewValues)), page, limit, total } };
}

async function getRenewal(id, canViewValues = false, includePerformance = false) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { renewalId: value, archivedAt: null };
  const renewal = await MarketingRenewal.findOne(filter).lean();
  if (!renewal) return { status: 404, body: { ok: false, message: 'Renewal not found' } };
  let previousPerformance = null;
  if (includePerformance && renewal.previousCampaignId) {
    const campaign = await getCampaignPerformance(renewal.previousCampaignId);
    previousPerformance = campaign.status === 200 ? campaign.body.campaign.performance : null;
  }
  return { status: 200, body: { ok: true, renewal: renewalDto(renewal, canViewValues), references: { advertiser: { advertiserId: renewal.advertiserId }, previousCampaignId: renewal.previousCampaignId || null, previousProposalId: renewal.previousProposalId || null, previousDealId: renewal.previousDealId || null, newProposalId: renewal.newProposalId || null, relatedFollowUps: [] }, previousPerformance } };
}

async function updateRenewalStatus(id, body, req) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const nextStatus = asString(body?.status, 60);
  if (!RENEWAL_STATUSES.has(nextStatus)) return { status: 400, body: { ok: false, message: 'Invalid renewal status' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { renewalId: value, archivedAt: null };
  const renewal = await MarketingRenewal.findOne(filter);
  if (!renewal) return { status: 404, body: { ok: false, message: 'Renewal not found' } };
  const from = renewal.status;
  if (from !== nextStatus && !RENEWAL_TRANSITIONS[from].includes(nextStatus)) return { status: 409, body: { ok: false, message: `Cannot change renewal status from ${from} to ${nextStatus}` } };
  renewal.status = nextStatus;
  renewal.updatedBy = actorId(req);
  if (body?.newProposalId) renewal.newProposalId = asString(body.newProposalId, 160);
  if (body?.renewedDealId) renewal.renewedDealId = asString(body.renewedDealId, 160);
  renewal.statusHistory.push({ from, to: nextStatus, changedBy: actorId(req), changedAt: new Date(), note: asString(body?.note, 1000) || '' });
  await renewal.save();
  return { status: 200, body: { ok: true, renewal: renewalDto(renewal, true) }, audit: { action: 'MARKETING_RENEWAL_STATUS_CHANGED', targetId: String(renewal._id), targetType: 'marketing_renewal', oldValue: { status: from }, newValue: { status: nextStatus } } };
}

async function archiveRenewal(id, req) {
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { renewalId: value, archivedAt: null };
  const renewal = await MarketingRenewal.findOneAndUpdate(filter, { $set: { archivedAt: new Date(), archivedBy: actorId(req), updatedBy: actorId(req) } }, { new: true });
  if (!renewal) return { status: 404, body: { ok: false, message: 'Renewal not found' } };
  return { status: 200, body: { ok: true, renewal: renewalDto(renewal, true) }, audit: { action: 'MARKETING_RENEWAL_ARCHIVED', targetId: String(renewal._id), targetType: 'marketing_renewal' } };
}

async function createProposalFromRenewal(id, body, req) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const value = asString(id, 160);
  const filter = mongoose.isValidObjectId(value) ? { _id: value, archivedAt: null } : { renewalId: value, archivedAt: null };
  const renewal = await MarketingRenewal.findOne(filter);
  if (!renewal) return { status: 404, body: { ok: false, message: 'Renewal not found' } };
  if (renewal.newProposalId && String(body?.allowDuplicate || '').toLowerCase() !== 'true') {
    return { status: 409, body: { ok: false, message: 'Renewal already has a linked proposal', newProposalId: renewal.newProposalId } };
  }
  let productIds = [];
  let placementIds = [];
  let scope = null;
  if (body?.usePreviousPackage === true && renewal.previousCampaignId) {
    const link = mongoose.isValidObjectId(renewal.previousCampaignId)
      ? await MarketingCampaignLink.findOne({ $or: [{ _id: renewal.previousCampaignId }, { adsManagerCampaignId: renewal.previousCampaignId }], archivedAt: null }).lean()
      : await MarketingCampaignLink.findOne({ campaignLinkId: renewal.previousCampaignId, archivedAt: null }).lean();
    if (link) {
      placementIds = Array.isArray(link.placements) ? link.placements.slice() : [];
      scope = { languages: Array.isArray(link.languages) ? link.languages.slice() : [], targetRegion: link.targetRegion || null };
    }
  }
  const proposal = await MarketingProposal.create({
    proposalId: generateId('MP'),
    advertiserId: renewal.advertiserId,
    primaryContactId: asString(body?.primaryContactId, 160),
    ownerId: renewal.ownerId,
    renewalId: renewal.renewalId,
    status: 'draft',
    productIds,
    placementIds,
    scope,
    pricing: null,
    createdBy: actorId(req),
    updatedBy: actorId(req),
  });
  renewal.newProposalId = proposal.proposalId;
  renewal.status = renewal.status === 'renewed' ? renewal.status : 'proposal';
  renewal.updatedBy = actorId(req);
  renewal.statusHistory.push({ from: renewal.status, to: renewal.status, changedBy: actorId(req), changedAt: new Date(), note: 'Proposal created from renewal' });
  await renewal.save();
  return { status: 201, body: { ok: true, proposal, renewal: renewalDto(renewal, true) }, audit: { action: 'MARKETING_RENEWAL_PROPOSAL_CREATED', targetId: String(renewal._id), targetType: 'marketing_renewal', newValue: { proposalId: proposal.proposalId } } };
}

async function growthGoalPerformance(req) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const sourceStatus = await getDataSourceStatus();
  const goals = await MarketingGrowthGoal.find({ archivedAt: null }).sort({ targetDate: 1 }).lean();
  const now = new Date();
  const items = [];
  const auditEvents = [];
  for (const goal of goals) {
    let current = null;
    let verifiedAt = null;
    if (sourceStatus.trafficAnalytics.status === 'connected' || sourceStatus.trafficAnalytics.status === 'partial') {
      if (['websiteUsers', 'users'].includes(goal.metric)) {
        const rows = await ArticleAnalyticsEvent.aggregate([{ $match: { eventType: 'view' } }, { $group: { _id: null, users: { $addToSet: '$visitorId' }, last: { $max: '$createdAt' } } }, { $project: { _id: 0, value: { $size: '$users' }, last: 1 } }]);
        current = rows[0]?.value ?? null;
        verifiedAt = rows[0]?.last || null;
      } else if (['pageViews', 'views'].includes(goal.metric)) {
        current = await ArticleAnalyticsEvent.countDocuments({ eventType: 'view' });
        verifiedAt = sourceStatus.trafficAnalytics.lastUpdatedAt || null;
      } else if (['sessions', 'campaignSessions'].includes(goal.metric)) {
        const rows = await ArticleAnalyticsEvent.aggregate([{ $match: { eventType: 'view' } }, { $group: { _id: null, sessions: { $addToSet: '$sessionId' }, last: { $max: '$createdAt' } } }, { $project: { _id: 0, value: { $size: '$sessions' }, last: 1 } }]);
        current = rows[0]?.value ?? null;
        verifiedAt = rows[0]?.last || null;
      }
    }
    const progress = current == null || goal.targetValue == null || Number(goal.targetValue) === 0 ? null : roundMetric((Number(current) / Number(goal.targetValue)) * 100);
    let status = goal.status;
    const deterministicAchieved = current != null && Number(current) >= Number(goal.targetValue);
    const deterministicMissed = current != null && goal.targetDate && new Date(goal.targetDate).getTime() < now.getTime() && Number(current) < Number(goal.targetValue);
    if (!['paused', 'closed'].includes(status) && deterministicAchieved) status = 'achieved';
    else if (!['paused', 'closed', 'achieved'].includes(status) && deterministicMissed) status = 'missed';
    if (status !== goal.status) {
      await MarketingGrowthGoal.updateOne({ _id: goal._id }, { $set: { status, currentVerifiedValue: current, progress, lastVerifiedAt: verifiedAt, updatedBy: actorId(req) } });
      await MarketingPerformanceSnapshot.create({ entityType: 'growth_goal', entityId: goal.goalId, metric: goal.metric, value: current, source: 'analytics', capturedAt: verifiedAt || now });
      auditEvents.push({
        action: status === 'achieved' ? 'MARKETING_GROWTH_GOAL_ACHIEVED' : 'MARKETING_GROWTH_GOAL_MISSED',
        targetId: String(goal._id),
        targetType: 'marketing_growth_goal',
        oldValue: { status: goal.status },
        newValue: { status, currentVerifiedValue: current, progress },
      });
    }
    items.push({ id: String(goal._id), goalId: goal.goalId, title: goal.title, metric: goal.metric, startVerifiedValue: goal.startVerifiedValue ?? null, currentVerifiedValue: current, targetValue: goal.targetValue, targetDate: goal.targetDate, progress, status, sourceStatus: sourceStatus.trafficAnalytics.status, lastVerifiedAt: verifiedAt });
  }
  return { status: 200, body: { ok: true, items, sourceStatus }, auditEvents };
}

async function retentionMetrics(canViewValues = false) {
  if (!isDbReady()) return { status: 503, body: { ok: false, code: 'SOURCE_UNAVAILABLE', message: 'Database unavailable' } };
  const campaigns = await MarketingCampaignLink.find({ archivedAt: null, status: { $in: ['active', 'completed'] } }).select('advertiserId campaignCommercialValue').lean();
  const counts = new Map();
  for (const campaign of campaigns) counts.set(campaign.advertiserId, (counts.get(campaign.advertiserId) || 0) + 1);
  const advertisersWithOneCampaign = Array.from(counts.values()).filter((count) => count === 1).length;
  const repeatAdvertisers = Array.from(counts.values()).filter((count) => count > 1).length;
  const renewalEligibleAdvertisers = await MarketingRenewal.distinct('advertiserId', { archivedAt: null });
  const renewedAdvertisers = await MarketingRenewal.distinct('advertiserId', { archivedAt: null, status: 'renewed' });
  const renewalsWon = await MarketingRenewal.countDocuments({ archivedAt: null, status: 'renewed' });
  const denominator = renewalEligibleAdvertisers.length;
  return { status: 200, body: { ok: true, metrics: { advertisersWithOneCampaign, repeatAdvertisers, renewalEligibleAdvertisers: denominator, renewedAdvertisers: renewedAdvertisers.length, renewalsWon, retentionRate: denominator > 0 ? roundMetric((renewedAdvertisers.length / denominator) * 100) : null, status: denominator > 0 ? 'available' : 'not_enough_data', commercialValuesVisible: Boolean(canViewValues) } } };
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  return [headers.join(','), ...rows.map((row) => headers.map((h) => csvEscape(row[h])).join(','))].join('\n');
}

async function exportCsv(kind, query, canViewValues = false) {
  if (kind === 'campaign-performance') {
    const result = await listCampaignPerformance({ ...query, page: 1, limit: Math.min(parsePositiveInt(query?.limit, 1000, 5000), 5000) });
    if (result.status !== 200) return result;
    const headers = ['campaignId', 'adsManagerCampaignId', 'advertiserId', 'advertiserName', 'dealId', 'proposalId', 'campaignName', 'status', 'impressions', 'clicks', 'ctr', 'trackingStatus', 'lastUpdatedAt'];
    const rows = result.body.items.map((item) => ({ ...item, impressions: item.performance.impressions, clicks: item.performance.clicks, ctr: item.performance.ctr, trackingStatus: item.performance.trackingStatus, lastUpdatedAt: item.performance.lastUpdatedAt }));
    return { status: 200, csv: toCsv(headers, rows), filename: 'marketing-campaign-performance.csv' };
  }
  if (kind === 'renewals') {
    const result = await listRenewals({ ...query, page: 1, limit: Math.min(parsePositiveInt(query?.limit, 1000, 5000), 5000) }, canViewValues);
    if (result.status !== 200) return result;
    const headers = ['renewalId', 'advertiserId', 'previousDealId', 'previousCampaignId', 'previousProposalId', 'previousCampaignValue', 'followUpDate', 'ownerId', 'status', 'newProposalId', 'renewedDealId'];
    return { status: 200, csv: toCsv(headers, result.body.items), filename: 'marketing-renewals.csv' };
  }
  if (kind === 'promotions') {
    const result = await promotionPerformance({ ...query, page: 1, limit: Math.min(parsePositiveInt(query?.limit, 1000, 5000), 5000) });
    if (result.status !== 200) return result;
    const headers = ['promotionId', 'title', 'utmCampaign', 'language', 'channel', 'status', 'startDate', 'endDate'];
    return { status: 200, csv: toCsv(headers, result.body.items), filename: 'marketing-promotion-performance.csv' };
  }
  if (kind === 'advertiser-campaign-summary') {
    const result = await listCampaignPerformance({ ...query, page: 1, limit: Math.min(parsePositiveInt(query?.limit, 1000, 5000), 5000) });
    if (result.status !== 200) return result;
    const byAdvertiser = new Map();
    for (const item of result.body.items) {
      const row = byAdvertiser.get(item.advertiserId) || { advertiserId: item.advertiserId, advertiserName: item.advertiserName || '', campaigns: 0, impressions: 0, clicks: 0 };
      row.campaigns += 1;
      row.impressions += item.performance.impressions || 0;
      row.clicks += item.performance.clicks || 0;
      byAdvertiser.set(item.advertiserId, row);
    }
    const rows = Array.from(byAdvertiser.values()).map((row) => ({ ...row, ctr: calculateCtr(row.impressions, row.clicks, true) }));
    const headers = ['advertiserId', 'advertiserName', 'campaigns', 'impressions', 'clicks', 'ctr'];
    return { status: 200, csv: toCsv(headers, rows), filename: 'marketing-advertiser-campaign-summary.csv' };
  }
  return { status: 404, body: { ok: false, message: 'Export not found' } };
}

module.exports = {
  getDataSourceStatus,
  listCampaignPerformance,
  getCampaignPerformance,
  promotionPerformance,
  performanceSummary,
  createCampaignReport,
  listCampaignReports,
  getCampaignReport,
  updateCampaignReport,
  refreshCampaignReportPerformance,
  transitionCampaignReport,
  markCampaignReportShared,
  createRenewal,
  listRenewals,
  getRenewal,
  updateRenewalStatus,
  archiveRenewal,
  createProposalFromRenewal,
  growthGoalPerformance,
  retentionMetrics,
  exportCsv,
};