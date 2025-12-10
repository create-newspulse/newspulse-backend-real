// @ts-nocheck
import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/adminAuth';
import { CommunityReporterStory } from '../models/communityReporterStory';

const router = Router();

const adminGuard = requireAdminAuth as any;

router.get('/community-reporter/queue', adminGuard, async (req, res) => {
  try {
    const statusFilter = String(req.query.status || 'pending');
    const allowed = ['pending', 'approved', 'rejected'];
    const query: any = allowed.includes(statusFilter) ? { status: statusFilter } : {};
    const items = await CommunityReporterStory.find(query).sort({ createdAt: -1 }).limit(200).lean();
    const total = await CommunityReporterStory.countDocuments(query);
    res.json({ ok: true, statusFilter, total, items });
  } catch (e: any) {
    console.error('QUEUE_FETCH_ERROR', e);
    res.status(500).json({ ok: false, message: 'Failed to fetch queue' });
  }
});

// Paginated analytics of community reporters used on admin analytics screen
router.get('/community/reporters', adminGuard, async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const pipeline: any[] = [
      { $match: { source: 'community' } },
      {
        $group: {
          _id: '$reporterId',
          name: { $first: '$reporterName' },
          email: { $first: '$email' },
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

    const items = await (CommunityReporterStory as any).aggregate(pipeline);
    res.json({ items, page, limit });
  } catch (err) {
    next(err);
  }
});

// Reporter contacts directory with story aggregation
router.get('/community/reporter-contacts', adminGuard, async (req, res, next) => {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Group stories by reporter email as identifier
    const pipeline: any[] = [
      { $match: { source: 'community' } },
      {
        $group: {
          _id: '$email',
          name: { $first: '$reporterName' },
          email: { $first: '$email' },
          phone: { $first: '$phone' },
          city: { $first: '$city' },
          district: { $first: '$district' },
          state: { $first: '$state' },
          country: { $first: '$country' },
          totalStories: { $sum: 1 },
          approvedStories: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          pendingStories: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          lastStoryAt: { $max: '$createdAt' },
        },
      },
      { $sort: { totalStories: -1, lastStoryAt: -1 } },
      { $skip: skip },
      { $limit: limit },
    ];

    const items = await (CommunityReporterStory as any).aggregate(pipeline);

    // Compute total distinct reporters using a separate pipeline with $count
    const countPipeline: any[] = [
      { $match: { source: 'community' } },
      { $group: { _id: '$email' } },
      { $count: 'total' },
    ];
    const totalAgg = await (CommunityReporterStory as any).aggregate(countPipeline);
    const total = totalAgg?.[0]?.total || items.length;

    res.json({ items, page, limit, total });
  } catch (err) {
    next(err);
  }
});

router.post('/community-reporter/seed-demo', adminGuard, async (req, res) => {
  try {
    const demoStories = [
      {
        headline: 'અમદાવાદમાં પાણી પુરવઠામાં ખલેલ, નાગરિકોમાં રોષ',
        reporterName: 'રિપોર્ટર કિરણ',
        email: 'kiran@example.com',
        phone: '9876543210',
        city: 'Ahmedabad',
        district: 'Ahmedabad',
        state: 'Gujarat',
        country: 'India',
        category: 'Infrastructure',
        priority: 'editor',
        aiRisk: 'low',
        status: 'pending',
        source: 'community',
      },
      {
        headline: 'વડોદરામાં ટ્રાફિક જામથી લોકો પરેશાન, તાત્કાલિક પગલાંની માંગ',
        reporterName: 'રિપોર્ટર રીના',
        email: 'reena@example.com',
        phone: '9876501234',
        city: 'Vadodara',
        district: 'Vadodara',
        state: 'Gujarat',
        country: 'India',
        category: 'Traffic',
        priority: 'low',
        aiRisk: 'medium',
        status: 'pending',
        source: 'community',
      },
      {
        headline: 'સુરતમાં સફાઈ અભિયાન, યુવાનોની સક્રિય ભાગીદારી',
        reporterName: 'રિપોર્ટર અમિત',
        email: 'amit@example.com',
        phone: '9876512345',
        city: 'Surat',
        district: 'Surat',
        state: 'Gujarat',
        country: 'India',
        category: 'Civic',
        priority: 'founder',
        aiRisk: 'low',
        status: 'pending',
        source: 'community',
      },
    ];
    const inserted = await (CommunityReporterStory as any).insertMany(demoStories, { ordered: true });
    res.json({ ok: true, inserted: inserted.length });
  } catch (e: any) {
    console.error('SEED_DEMO_ERROR', e);
    res.status(500).json({ ok: false, message: 'Failed to seed demo stories' });
  }
});

export default router;
