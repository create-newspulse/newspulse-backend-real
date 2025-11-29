const express = require('express');
const CommunitySubmission = require('../models/CommunitySubmission');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

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
          groupEmail: { $ifNull: ['$reporterEmail', '$email'] },
          groupName: { $ifNull: ['$reporterName', '$userName'] },
          locCity: { $ifNull: ['$city', '$locationDetail.city'] },
          locState: { $ifNull: ['$state', '$locationDetail.state'] },
          locCountry: { $ifNull: ['$country', '$locationDetail.country'] },
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
          email: { $first: '$groupEmail' },
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
        reporterEmail: r.email || null,
        reporterDisplayName: r.latestName || null,
        city: r.latestCity || null,
        state: r.latestState || null,
        country: r.latestCountry || null,
        phone: r.latestPhone || null,
        whatsappNumber: r.latestWhatsapp || null,
        telegramId: r.latestTelegram || null,
        instagramHandle: r.latestInstagram || null,
        lastStatus: r.lastStatus || null,
        lastStoryAt: r.lastStoryAt || null,
        totalStories: r.totalStories || 0,
        pendingStories: r.pendingStories || 0,
        approvedStories: r.approvedStories || 0,
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

// Legacy alias: allow root path to serve same response when mounted at /api/community/admin/contacts
router.get('/', requireAdminAuth, async (req, res, next) => {
  // Forward to reporter-contacts handler
  req.url = '/reporter-contacts';
  return router.handle(req, res, next);
});

module.exports = router;
