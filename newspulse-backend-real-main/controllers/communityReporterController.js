const CommunityStory = require('../models/CommunityStory');
const Reporter = require('../models/Reporter');
const CommunitySubmission = require('../models/CommunitySubmission');
// ReporterContact model exists in root-level models
const ReporterContact = require('../../models/ReporterContact');

// POST /api/community-reporter/submit
async function submitStory(req, res) {
  try {
    const reporterPayload = (req.body && req.body.reporter) || {};
    const storyPayload = (req.body && req.body.story) || {};

    const {
      fullName,
      email,
      phone,
      city,
      state,
      country,
      languages,
      beats,
      isProfessional,
      organisation,
      roleOrTitle,
      yearsExperience,
      portfolioLinks,
    } = reporterPayload;

    if (!email || !fullName) {
      return res.status(400).json({ ok: false, message: 'Reporter name and email are required' });
    }

    const existingReporter = await Reporter.findOne({ email });
    const type = isProfessional ? 'journalist' : 'community';
    const update = {
      fullName,
      email,
      phone,
      city,
      state,
      country,
      languages,
      beats,
      type,
    };
    if (isProfessional) {
      if (organisation) update.organisation = organisation;
      if (roleOrTitle) update.roleOrTitle = roleOrTitle;
      if (typeof yearsExperience === 'number') update.yearsExperience = yearsExperience;
      if (Array.isArray(portfolioLinks)) update.portfolioLinks = portfolioLinks;
      if (!existingReporter || existingReporter.verificationStatus === 'unverified') {
        update.verificationStatus = 'pending';
      }
    }
    const reporter = await Reporter.findOneAndUpdate(
      { email },
      { $set: update },
      { upsert: true, new: true }
    );

    const {
      category,
      headline,
      story,
      ageGroup,
      storyCity,
      storyState,
      storyCountry,
      isUrgent,
    } = storyPayload;

    if (!headline || !story) {
      return res.status(400).json({ ok: false, message: 'Headline and story are required' });
    }

    const reporterType = reporter.type === 'journalist' ? 'journalist' : 'community';
    const verificationLevel = reporter.verificationStatus || 'unverified';
    const newStory = await CommunityStory.create({
      reporterId: reporter._id,
      reporterType,
      reporterVerificationLevel: verificationLevel,
      source: reporterType,
      category,
      headline,
      body: story,
      ageGroup,
      storyCity,
      storyState,
      storyCountry,
      priority: isUrgent ? 'high' : 'normal',
    });

    const ref = `NP-CR-${newStory.createdAt.getFullYear()}-${newStory._id.toString().slice(-4)}`;

    return res.status(201).json({ ok: true, reporterId: reporter._id.toString(), storyId: newStory._id.toString(), reference: ref });
  } catch (e) {
    console.error('[CommunityReporter][submitStory][error]', e?.message || e);
    return res.status(400).json({ ok: false, message: 'Could not submit story. Please try again.' });
  }
}

// GET /api/community-reporter/my-stories?reporterId=...
async function listStoriesByReporter(req, res) {
  try {
    const q = req.query || {};
    let reporterId = q.reporterId || null;
    const email = (q.email || '').toString().trim().toLowerCase();

    if (!reporterId && email) {
      const rep = await Reporter.findOne({ email }, '_id').lean();
      reporterId = rep ? rep._id : null;
    }
    if (!reporterId) {
      return res.status(400).json({ ok: false, message: 'reporterId or email is required' });
    }

    const docs = await CommunityStory.find({ reporterId }).sort({ createdAt: -1 }).lean();
    const items = docs.map(d => ({
      _id: d._id,
      headline: d.headline,
      category: d.category,
      locationCity: d.storyCity || null,
      locationState: d.storyState || null,
      status: d.status,
      priority: d.priority || 'normal',
      sourceType: d.reporterType || d.source || 'community',
      reporterVerificationLevel: d.reporterVerificationLevel || 'unverified',
      createdAt: d.createdAt,
    }));
    return res.json({ ok: true, items });
  } catch (e) {
    console.error('[CommunityReporter][listStoriesByReporter][error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load stories' });
  }
}

module.exports = { submitStory, listStoriesByReporter };
// Public queue backed by CommunitySubmission
module.exports.getCommunityReporterQueue = async function getCommunityReporterQueue(req, res) {
  try {
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

    const mapped = mapStatus(status);
    const filter = mapped ? { status: { $in: mapped } } : {};
    const [docs, total] = await Promise.all([
      CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunitySubmission.countDocuments(filter),
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
};

module.exports.listReporterContacts = async function listReporterContacts(req, res) {
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
};

// Admin: list reporters with story aggregation
module.exports.listReporters = async function listReporters(req, res) {
  try {
    const { country, state, city, district, areaType, search, type, status, hasNotes, beat, activity } = req.query || {};
    const match = {};
    if (country && country !== 'all') match.country = country;
    if (state && state !== 'all') match.state = state;
    if (city && city !== 'all') match.city = city;
    if (district && district !== 'all') match.district = district;
    if (areaType && areaType !== 'all') match.areaType = areaType;
    if (type && type !== 'all') match.type = type;
    if (status && status !== 'all') match.status = status;
    if (beat && beat !== 'all') match.beats = beat;
    if (hasNotes === 'true') match.notes = { $exists: true, $ne: '' };
    if (search) {
      const regex = new RegExp(String(search), 'i');
      match.$or = [{ fullName: regex }, { email: regex }, { phone: regex }];
    }

    // collection name for CommunityStory model
    const fromCollection = (CommunityStory.collection && CommunityStory.collection.name) || 'communitiestories';
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const now = new Date();
    const pipeline = [
      { $match: match },
      {
        $lookup: {
          from: fromCollection,
          localField: '_id',
          foreignField: 'reporterId',
          as: 'stories',
        },
      },
      {
        $addFields: {
          storiesCount: { $size: '$stories' },
          lastStoryAt: { $max: '$stories.createdAt' },
        },
      },
      {
        $addFields: {
          activity: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'blacklisted'] }, then: 'blacklisted' },
                { case: { $eq: ['$status', 'on_leave'] }, then: 'on_leave' },
                {
                  case: { $gt: ['$lastStoryAt', { $subtract: [now, 1000 * 60 * 60 * 24 * 60] }] },
                  then: 'active',
                },
                {
                  case: { $and: [ { $lte: ['$lastStoryAt', { $subtract: [now, 1000 * 60 * 60 * 24 * 60] }] }, { $ne: ['$lastStoryAt', null] } ] },
                  then: 'inactive',
                },
              ],
              default: 'new',
            },
          },
        },
      },
      { $project: { stories: 0 } },
    ];

    if (activity && activity !== 'all') {
      pipeline.push({ $match: { activity } });
    }

    pipeline.push({ $sort: { lastStoryAt: -1, fullName: 1 } });
    const totalAgg = await Reporter.aggregate([...pipeline, { $count: 'count' }]);
    const total = totalAgg[0]?.count || 0;
    pipeline.push({ $skip: skip }, { $limit: limit });
    const reporters = await Reporter.aggregate(pipeline);

    let items = reporters.map(r => ({
      _id: r._id,
      fullName: r.fullName,
      email: r.email,
      phone: r.phone,
      country: r.country,
      state: r.state,
      district: r.district || null,
      city: r.city,
      areaType: r.areaType || null,
      beats: Array.isArray(r.beats) ? r.beats : [],
      status: r.status,
      type: r.type,
      verificationStatus: r.verificationStatus,
      ethicsStrikes: r.ethicsStrikes || 0,
      storiesCount: r.storiesCount || 0,
      lastStoryAt: r.lastStoryAt || null,
      activity: r.activity || 'new',
    }));

    // Privacy masking for non-founder admins
    try {
      const admin = req.admin || req.user || {};
      const isFounder = admin && (admin.role === 'founder' || admin.isFounder === true);
      if (!isFounder) {
        const maskEmail = (email) => {
          if (!email) return email;
          const parts = String(email).split('@');
          if (parts.length !== 2) return email;
          const name = parts[0]; const domain = parts[1];
          if (name.length <= 2) return `***@${domain}`;
          return `${name[0]}***${name[name.length - 1]}@${domain}`;
        };
        const maskPhone = (phone) => {
          if (!phone) return phone;
          const digits = String(phone).replace(/\D/g, '');
          if (digits.length <= 4) return '****';
          return `***${digits.slice(-4)}`;
        };
        items = items.map(r => ({
          ...r,
          email: maskEmail(r.email),
          phone: maskPhone(r.phone),
        }));
      }
    } catch (_) {}

    return res.json({ ok: true, items, page, limit, total });
  } catch (err) {
    console.error('[Admin][listReporters][error]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load reporters' });
  }
};

// Admin: community hub stats
module.exports.getCommunityStats = async function getCommunityStats(req, res) {
  try {
    const [pending, approved, rejected, reporters, journalists] = await Promise.all([
      CommunityStory.countDocuments({ status: 'pending' }),
      CommunityStory.countDocuments({ status: 'approved' }),
      CommunityStory.countDocuments({ status: 'rejected' }),
      Reporter.countDocuments({}),
      Reporter.countDocuments({ type: 'journalist' }),
    ]);

    return res.json({
      ok: true,
      pendingStories: pending,
      approvedStories: approved,
      rejectedStories: rejected,
      totalReporters: reporters,
      verifiedJournalists: journalists,
    });
  } catch (err) {
    console.error('[Admin][communityStats][error]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load community stats' });
  }
};
