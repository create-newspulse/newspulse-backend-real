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
router.get('/', requireAdminAuth, async (req, res) => {
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
        },
      },
      // Ensure groupEmail exists after normalization
      { $match: { groupEmail: { $exists: true, $ne: '' } } },
      {
        $group: {
          _id: '$groupEmail',
          email: { $first: '$groupEmail' },
          latestName: { $last: '$groupName' },
          latestCity: { $last: '$locCity' },
            latestState: { $last: '$locState' },
          latestCountry: { $last: '$locCountry' },
          latestPhone: { $last: '$contactPhone' },
          latestWhatsapp: { $last: '$contactWhatsapp' },
          latestTelegram: { $last: '$contactTelegram' },
          latestInstagram: { $last: '$contactInstagram' },
          lastStatus: { $last: '$status' },
          lastStoryAt: { $max: '$createdAt' },
          totalStories: { $sum: 1 },
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
        reporterEmail: r.email,
        reporterName: r.latestName || null,
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

module.exports = router;
