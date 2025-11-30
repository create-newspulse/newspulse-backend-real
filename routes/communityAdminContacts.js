const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

// Helper: build normalized reporter key expression used by contacts and stories
function buildReporterKeyExpression() {
  // Prefer lowercased contact.email; else contact.phone; else fallback to string _id
  return {
    $let: {
      vars: {
        emailRaw: { $ifNull: ['$contact.email', { $ifNull: ['$reporterEmail', '$email'] }] },
        phoneRaw: '$contact.phone',
      },
      in: {
        $cond: [
          { $and: [ { $ne: ['$$emailRaw', null] }, { $ne: ['$$emailRaw', ''] } ] },
          { $toLower: '$$emailRaw' },
          {
            $cond: [
              { $and: [ { $ne: ['$$phoneRaw', null] }, { $ne: ['$$phoneRaw', ''] } ] },
              '$$phoneRaw',
              { $toString: '$_id' },
            ],
          },
        ],
      },
    },
  };
}

// GET /api/community/admin/contacts
// Query params:
//   q?: string (search by name/email/city/state/country)
//   city?: string
//   state?: string
//   country?: string
//   page?: number (default 1)
//   limit?: number (default 20)
// Primary path: /reporter-contacts (mounted under /api/admin/community)
router.get('/reporter-contacts', requireAdminAuth, async (req, res) => {
  try {
    try {
      console.log('[ADMIN_REPORTER_CONTACTS][alias] admin', req.admin && { id: req.admin.id, role: req.admin.role });
    } catch (_) {}
    const { q, city, state, country } = req.query || {};
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;

    // Base match: ensure there is an email we can group on (reporterEmail or email)
    const match = {
      $or: [
        { reporterEmail: { $exists: true, $ne: '' } },
        { email: { $exists: true, $ne: '' } },
      ],
    };

    // Text search across reporterName/userName/email/location fields
    if (q) {
      const regex = new RegExp(q, 'i');
      match.$and = (match.$and || []).concat([
        {
          $or: [
            { reporterName: regex },
            { userName: regex },
            { reporterEmail: regex },
            { email: regex },
            { city: regex },
            { state: regex },
            { country: regex },
            { 'locationDetail.city': regex },
            { 'locationDetail.state': regex },
            { 'locationDetail.country': regex },
          ],
        },
      ]);
    }

    if (city) {
      const cRegex = new RegExp(city, 'i');
      match.$and = (match.$and || []).concat([
        { $or: [ { city: cRegex }, { 'locationDetail.city': cRegex } ] },
      ]);
    }
    if (state) {
      const sRegex = new RegExp(state, 'i');
      match.$and = (match.$and || []).concat([
        { $or: [ { state: sRegex }, { 'locationDetail.state': sRegex } ] },
      ]);
    }
    if (country) {
      const coRegex = new RegExp(country, 'i');
      match.$and = (match.$and || []).concat([
        { $or: [ { country: coRegex }, { 'locationDetail.country': coRegex } ] },
      ]);
    }

    const pipeline = [
      { $match: match },
      // Normalize group email field
      {
        $addFields: {
          reporterKey: buildReporterKeyExpression(),
          groupEmail: { $ifNull: ['$contact.email', { $ifNull: ['$reporterEmail', '$email'] }] },
          groupName: { $ifNull: ['$contact.name', { $ifNull: ['$reporterName', '$userName'] }] },
          locCity: { $ifNull: ['$location.city', { $ifNull: ['$city', '$locationDetail.city'] }] },
          locState: { $ifNull: ['$location.state', { $ifNull: ['$state', '$locationDetail.state'] }] },
          locCountry: { $ifNull: ['$location.country', { $ifNull: ['$country', '$locationDetail.country'] }] },
          contactPhone: '$contact.phone',
          contactWhatsapp: '$contact.whatsappNumber',
          contactTelegram: '$contact.telegramId',
          contactInstagram: '$contact.instagramHandle',
          statusNorm: { $toUpper: { $ifNull: ['$status', ''] } },
        },
      },
      // Ensure groupEmail exists after normalization
      { $addFields: { groupPhone: '$contact.phone' } },
      { $addFields: { groupId: { $ifNull: ['$groupEmail', { $ifNull: ['$groupPhone', { $toString: '$_id' }] }] } } },
      { $match: { groupId: { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$groupId',
          id: { $first: '$groupId' },
          email: { $last: '$groupEmail' },
          latestName: { $last: '$groupName' },
          latestCity: { $last: '$locCity' },
          latestState: { $last: '$locState' },
          latestCountry: { $last: '$locCountry' },
          latestPhone: { $last: '$groupPhone' },
          latestWhatsapp: { $last: '$contactWhatsapp' },
          latestTelegram: { $last: '$contactTelegram' },
          latestInstagram: { $last: '$contactInstagram' },
          lastStatus: { $last: '$status' },
          lastStoryAt: { $max: '$createdAt' },
          totalStories: { $sum: 1 },
          pendingStories: { $sum: { $cond: [ { $or: [
            { $eq: ['$statusNorm', 'PENDING'] },
            { $eq: ['$statusNorm', 'UNDER_REVIEW'] },
            { $eq: ['$statusNorm', 'NEW'] },
            { $eq: ['$statusNorm', 'AI_REVIEWED'] },
            { $eq: ['$statusNorm', 'PENDING_FOUNDER'] },
          ] }, 1, 0 ] } },
          approvedStories: { $sum: { $cond: [ { $or: [
            { $eq: ['$statusNorm', 'APPROVED'] },
            { $eq: ['$statusNorm', 'PUBLISHED'] },
          ] }, 1, 0 ] } },
        },
      },
      { $sort: { lastStoryAt: -1 } },
    ];

    const [results, totalAgg] = await Promise.all([
      CommunitySubmission.aggregate([
        ...pipeline,
        { $skip: skip },
        { $limit: limit },
      ]),
      CommunitySubmission.aggregate([
        ...pipeline.slice(0, pipeline.length - 2), // exclude sort for counting unique groups
        { $group: { _id: '$_id' } }, // After previous $group, _id is email; regroup to count unique
        { $count: 'count' },
      ]),
    ]);

    const total = totalAgg[0]?.count || 0;

    return res.json({
      ok: true,
      success: true,
      items: results.map(r => ({
        id: r.id,
        name: r.latestName || null,
        email: r.email || null,
        phone: r.latestPhone || null,
        city: r.latestCity || null,
        state: r.latestState || null,
        country: r.latestCountry || null,
        totalStories: r.totalStories || 0,
        pendingStories: r.pendingStories || 0,
        approvedStories: r.approvedStories || 0,
        lastStoryAt: r.lastStoryAt || null,
      })),
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error('[CommunityContacts] error', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Failed to load community contacts' });
  }
});

// GET /api/admin/community/reporter-directory
// Query params supported:
// search, state, district, taluka, areaType, beat, status, page, limit
router.get('/reporter-directory', requireAdminAuth, async (req, res) => {
  try {
    const {
      search = '',
      state = '',
      district = '',
      taluka = '',
      areaType = '',
      beat = '',
      status = '',
    } = req.query || {};

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const q = {};

    // Free text search: fullName, email, phoneFull, cityTownVillage
    if (search && String(search).trim() !== '') {
      const rx = new RegExp(String(search).trim(), 'i');
      q.$or = [
        { fullName: rx },
        { email: rx },
        { phoneFull: rx },
        { cityTownVillage: rx },
      ];
    }

    if (state && String(state).trim() !== '') {
      const rx = new RegExp(String(state).trim(), 'i');
      q.$or = (q.$or || []).concat([
        { stateName: rx },
        { stateCode: rx },
      ]);
    }

    if (district && String(district).trim() !== '') {
      q.districtName = new RegExp(String(district).trim(), 'i');
    }

    if (taluka && String(taluka).trim() !== '') {
      q.talukaName = new RegExp(String(taluka).trim(), 'i');
    }

    if (areaType && String(areaType).trim() !== '') {
      q.areaType = String(areaType).trim().toUpperCase();
    }

    if (beat && String(beat).trim() !== '') {
      // beats is an array of enum strings
      q.beats = String(beat).trim().toUpperCase();
    }

    if (status && String(status).trim() !== '') {
      q.status = String(status).trim().toUpperCase();
    }

    const sort = { 'stats.lastStoryAt': -1, fullName: 1 };

    const [items, total] = await Promise.all([
      ReporterContact.find(q).sort(sort).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(q),
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));

    return res.json({ ok: true, items, total, page, pages });
  } catch (err) {
    console.error('[ReporterDirectory] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
});

// Legacy alias: allow root path to serve same response when mounted at /api/community/admin/contacts
router.get('/', requireAdminAuth, async (req, res, next) => {
  // Forward to reporter-contacts handler
  req.url = '/reporter-contacts';
  return router.handle(req, res, next);
});

// GET /admin/community/reporter-stories?reporterKey=<email>&sortBy=createdAt&sortDir=desc
// Returns all submissions for a specific reporter key (prefer contact.email)
router.get('/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const rawKey = String(req.query.reporterKey || '').trim();
    if (!rawKey) {
      return res.json({ ok: true, items: [], total: 0 });
    }
    const reporterKey = rawKey.toLowerCase();

    const match = {
      $or: [
        { 'contact.email': reporterKey },
        { reporterEmail: reporterKey },
        { email: reporterKey },
      ],
    };

    const docs = await CommunitySubmission.find(match)
      .sort({ createdAt: -1 })
      .lean();

    const items = docs.map(d => ({
      id: String(d._id),
      title: d.headline || '',
      summary: d.body ? d.body.slice(0, 280) : null,
      status: d.status || '',
      language: d.language || 'en',
      category: d.category || null,
      city: (d.location && d.location.city) || d.city || (d.locationDetail && d.locationDetail.city) || null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      aiRisk: d.policyNotes || null,
      priority: d.priority || null,
    }));

    return res.json({ ok: true, items, total: items.length });
  } catch (err) {
    console.error('[ADMIN_REPORTER_STORIES]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter stories' });
  }
});

module.exports = router;
