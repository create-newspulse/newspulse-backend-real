const mongoose = require('mongoose');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
let CommunityStory = null;
try { CommunityStory = require('../models/CommunityStory'); } catch (_) { /* optional model */ }
const CommunitySubmissionModel = require('../models/CommunitySubmission');

// GET /api/community-reporter/queue
// Returns real queue items from CommunitySubmission with status mapping
async function getCommunityReporterQueue(req, res) {
  try {
    // In local/test runs without MongoDB, avoid Mongoose command buffering delays.
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      const status = (req.query.status || 'pending').toString();
      return res.status(200).json({
        ok: true,
        success: true,
        status: 200,
        data: [],
        meta: { statusFilter: status, total: 0, page: 1, limit: 0 },
        message: 'Community reporter queue',
      });
    }

    const status = (req.query.status || 'pending').toString();
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;

    const mapStatus = (s) => {
      const key = (s || '').toString().toLowerCase();
      if (key === 'pending' || key === 'under_review') return ['PENDING_FOUNDER', 'UNDER_REVIEW', 'NEW', 'pending', 'under_review'];
      if (key === 'approved') return ['APPROVED', 'approved'];
      if (key === 'rejected') return ['REJECTED', 'rejected'];
      if (key === 'all') return null;
      return [s];
    };

    const filter = {};
    const mapped = mapStatus(status);
    if (mapped) filter.status = { $in: mapped };

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunitySubmission.countDocuments(mapped ? { status: { $in: mapped } } : {}),
    ]);

    const data = docs.map(d => ({
      id: d._id.toString(),
      headline: d.headline || '',
      category: d.category || null,
      reporter: (d.contact && d.contact.name) || d.reporterName || d.name || 'Unknown',
      location: (d.location && d.location.city) || d.city || null,
      priority: d.priority || 'normal',
      aiRisk: typeof d.riskScore === 'number' ? d.riskScore : null,
      status: d.status || 'under_review',
      createdAt: d.createdAt || null,
    }));

    return res.status(200).json({ ok: true, success: true, status: 200, data, meta: { statusFilter: status, total, page, limit }, message: 'Community reporter queue' });
  } catch (err) {
    console.error('Error in GET /api/community-reporter/queue:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load community reporter queue' });
  }
}

// GET /api/community-reporter/contacts
async function listReporterContacts(req, res) {
  try {
    const q = req.query || {};
    const filter = {};
    if (q.country) filter.country = String(q.country);
    if (q.state) filter.stateName = String(q.state);
    if (q.district) filter.districtName = String(q.district);
    if (q.city) filter.cityTownVillage = String(q.city);
    if (q.type) filter.reporterType = String(q.type);
    if (q.status) filter.status = String(q.status);

    const contacts = await ReporterContact.find(filter).sort({ fullName: 1 }).lean();
    const items = contacts.map(c => ({
      id: c._id.toString(),
      name: c.fullName,
      email: c.email,
      phone: c.phoneFull || c.phoneNumber || null,
      city: c.cityTownVillage,
      state: c.stateName,
      country: c.country,
      district: c.districtName,
      type: c.reporterType,
      verification: c.verificationLevel,
      status: c.status,
      stats: c.stats || {},
      lastStoryAt: c.stats && c.stats.lastStoryAt ? c.stats.lastStoryAt : null,
    }));
    return res.status(200).json({ ok: true, success: true, status: 200, items, total: items.length, message: 'Reporter contacts directory' });
  } catch (err) {
    console.error('Error in listReporterContacts:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load reporter contacts' });
  }
}

// Admin: Reporter Directory list
async function listReporters(req, res) {
  try {
    // Accept common admin panel filters; default to 'all' and ignore when 'all'
    const {
      district = 'all',
      areaType = 'all',
      beat = 'all',
      activity = 'all',
    } = req.query || {};

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const q = {};
    if (district && String(district).toLowerCase() !== 'all') {
      q.districtName = new RegExp(String(district).trim(), 'i');
    }
    if (areaType && String(areaType).toLowerCase() !== 'all') {
      q.areaType = String(areaType).trim().toUpperCase();
    }
    if (beat && String(beat).toLowerCase() !== 'all') {
      // beats is an array; match by value equality
      q.beats = String(beat).trim().toUpperCase();
    }
    if (activity && String(activity).toLowerCase() !== 'all') {
      // Map activity to status field if present
      q.status = String(activity).trim().toUpperCase();
    }

    const sort = { fullName: 1 };
    const [itemsRaw, total] = await Promise.all([
      ReporterContact.find(q).sort(sort).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(q),
    ]);

    const items = itemsRaw.map(c => ({
      id: c._id.toString(),
      name: c.fullName,
      email: c.email,
      phone: c.phoneFull || c.phoneNumber || null,
      city: c.cityTownVillage,
      state: c.stateName,
      country: c.country,
      district: c.districtName,
      type: c.reporterType,
      status: c.status,
    }));

    return res.json({ ok: true, items, total, page, limit });
  } catch (e) {
    console.error('[ADMIN][listReporters] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
}

// Admin: Community summary stats
async function getCommunityStats(req, res) {
  try {
    const pendingStatuses = ['pending', 'under_review', 'PENDING_FOUNDER', 'UNDER_REVIEW', 'NEW'];
    const [pendingStories, totalReporters, verifiedJournalists] = await Promise.all([
      CommunitySubmission.countDocuments({ status: { $in: pendingStatuses } }),
      ReporterContact.countDocuments({}),
      ReporterContact.countDocuments({ $or: [ { verificationLevel: 'verified' }, { status: 'verified' } ] }),
    ]);
    return res.json({
      pendingStories,
      totalReporters,
      verifiedJournalists,
    });
  } catch (e) {
    console.error('[ADMIN][getCommunityStats] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load community stats' });
  }
}

// Admin: Community Reporter Analytics
// GET /api/admin/community/reporters
async function getCommunityReporterAnalytics(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const pipeline = [
      { $match: { sourceType: 'community' } },
      {
        $group: {
          _id: '$reporterId',
          name: { $first: '$reporterName' },
          email: { $first: '$reporterEmail' },
          totalStories: { $sum: 1 },
          approvedStories: {
            $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] },
          },
          lastStoryAt: { $max: '$createdAt' },
        },
      },
      { $sort: { totalStories: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const items = await CommunitySubmissionModel.aggregate(pipeline);
    return res.json({ items, page, limit });
  } catch (err) {
    return next ? next(err) : res.status(500).json({ ok: false, message: 'Failed to load reporter analytics' });
  }
}

// POST /api/community-reporter/submit
async function submitCommunityReport(req, res) {
  try {
    const body = req.body || {};
    if (process.env.COMMUNITY_REPORTER_DEBUG_SUBMIT === '1') {
      console.log('[COMMUNITY_REPORTER][submit] incoming body', body);
    }

    // Support both nested payload ({ reporter, story }) and flat Phase-1 fields
    const reporter = body.reporter || {};
    const story = body.story || {};

    const name = String(
      body.name ||
      reporter.fullName ||
      reporter.name ||
      body.fullName ||
      body.reporterName ||
      ''
    ).trim();

    const email = String(
      body.email ||
      reporter.email ||
      body.reporterEmail ||
      ''
    ).trim().toLowerCase();

    const location = body.location ?? reporter.location ?? undefined;

    const headline = String(
      body.headline ||
      story.headline ||
      ''
    ).trim();

    const storyText = String(
      body.story ||
      body.storyText ||
      story.body ||
      story.storyText ||
      ''
    ).trim();

    const ageGroup = String(body.ageGroup || story.ageGroup || '').trim();

    if (!name || !email || !headline || !storyText || !ageGroup) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const locationObj = (location && typeof location === 'object') ? location : null;
    const locationText = (typeof location === 'string') ? location.trim() : undefined;

    const submission = await CommunitySubmissionModel.create({
      name,
      email,
      reporterName: name,
      reporterEmail: email,
      reporterLocation: locationText,
      location: locationObj ? {
        city: locationObj.city ?? null,
        state: locationObj.state ?? null,
        country: locationObj.country ?? null,
      } : { city: null, state: null, country: null },
      headline,
      body: storyText,
      ageGroup,
      status: 'NEW',
      sourceType: 'community',
      reporterVerificationLevel: 'unverified',
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
    });

    return res.status(201).json({ success: true, id: submission._id });
  } catch (e) {
    console.error('CommunityReporterSubmit error:', e && e.stack ? e.stack : e);
    return res.status(500).json({ message: 'Internal error in Community Reporter submit' });
  }
}

// GET /api/community-reporter/my-stories?email=...
async function listMyCommunityReports(req, res) {
  try {
    const email = String(req.query.email || req.body?.email || '').trim().toLowerCase();
    // Log email used to search my stories
    console.log('[COMMUNITY_REPORT][my-stories] lookup email:', email);
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    // Case-insensitive match on reporterEmail in CommunitySubmission
    const emailRegex = new RegExp(`^${email}$`, 'i');
    const submissions = await CommunitySubmissionModel.find({ reporterEmail: emailRegex })
      .sort({ createdAt: -1 })
      .lean();

    // Also include legacy CommunityReport docs for completeness
    const legacyReports = await CommunityReport.find({ reporterEmail: emailRegex })
      .sort({ createdAt: -1 })
      .lean();

    const mappedSubs = submissions.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: (function () {
        const s = String(i.status || '').toLowerCase();
        if (['approved', 'rejected', 'withdrawn'].includes(s)) return s;
        return 'under_review';
      })(),
      createdAt: i.createdAt,
    }));

    const mappedLegacy = legacyReports.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: i.status || 'under_review',
      createdAt: i.createdAt,
    }));

    const items = [...mappedSubs, ...mappedLegacy].sort((a, b) => (new Date(b.createdAt)) - (new Date(a.createdAt)));
    return res.json({ success: true, items, total: items.length });
  } catch (e) {
    console.error('[COMMUNITY_REPORT][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
}

module.exports = { submitCommunityReport, listMyCommunityReports, getCommunityReporterQueue, listReporterContacts, listReporters, getCommunityStats, getCommunityReporterAnalytics };
