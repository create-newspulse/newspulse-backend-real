import { Router } from 'express';
import { requireAdminAuth } from '../../middleware/adminAuth';
import { CommunityReporterStory } from '../models/communityReporterStory';

const router = Router();

router.get('/community-reporter/queue', requireAdminAuth as any, async (req, res) => {
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

router.post('/community-reporter/seed-demo', requireAdminAuth as any, async (req, res) => {
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
