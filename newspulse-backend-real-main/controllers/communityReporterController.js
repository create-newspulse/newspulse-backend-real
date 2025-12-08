const CommunityStory = require('../models/CommunityStory');
const CommunitySubmission = require('../models/CommunitySubmission');
// ReporterContact model exists in root-level models
const ReporterContact = require('../../models/ReporterContact');

// POST /api/community-reporter/submit
async function submitStory(req, res) {
  try {
    const {
      reporterName,
      reporterEmail,
      reporterPhone,
      reporterCity,
      reporterState,
      reporterCountry,
      reporterType,
      category,
      headline,
      storyText,
      ageGroup,
      preferredLanguages,
    } = req.body || {};

    // Minimal validation
    if (!reporterName || !reporterEmail || !category || !headline || !storyText) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const doc = await CommunityStory.create({
      reporterName: String(reporterName).trim(),
      reporterEmail: String(reporterEmail).trim().toLowerCase(),
      reporterPhone: reporterPhone || undefined,
      reporterCity: reporterCity || undefined,
      reporterState: reporterState || undefined,
      reporterCountry: reporterCountry || undefined,
      reporterType: reporterType === 'professional' ? 'professional' : 'community',
      category: String(category).trim(),
      headline: String(headline).trim(),
      storyText: String(storyText).trim(),
      ageGroup: ageGroup || undefined,
      preferredLanguages: Array.isArray(preferredLanguages) ? preferredLanguages : [],
    });

    return res.status(201).json({ success: true, storyId: doc._id.toString() });
  } catch (e) {
    console.error('[CommunityReporter][submitStory][error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating story' });
  }
}

// GET /api/community-reporter/my-stories?email=...
async function listStoriesByReporter(req, res) {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    const items = await CommunityStory.find({ reporterEmail: email }).sort({ createdAt: -1 }).lean();
    const stories = items.map(i => ({
      id: i._id.toString(),
      headline: i.headline,
      category: i.category,
      status: i.status,
      createdAt: i.createdAt,
    }));
    return res.json({ success: true, stories });
  } catch (e) {
    console.error('[CommunityReporter][listStoriesByReporter][error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
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
    const contacts = await ReporterContact.find({}).sort({ fullName: 1 }).lean();
    return res.status(200).json({ ok: true, success: true, status: 200, data: contacts, total: contacts.length, message: 'Reporter contacts directory' });
  } catch (err) {
    console.error('Error in listReporterContacts:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load reporter contacts' });
  }
};
