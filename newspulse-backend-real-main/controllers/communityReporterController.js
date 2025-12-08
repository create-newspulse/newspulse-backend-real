const CommunityStory = require('../models/CommunityStory');

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
// Temporary public placeholder for queue
module.exports.getCommunityReporterQueue = async function getCommunityReporterQueue(req, res) {
  try {
    const status = (req.query.status || 'pending').toString();
    return res.status(200).json({
      ok: true,
      success: true,
      status: 200,
      data: [],
      meta: { statusFilter: status, total: 0 },
      message: 'Community reporter queue (public placeholder)',
    });
  } catch (err) {
    console.error('Error in GET /api/community-reporter/queue:', err);
    return res.status(500).json({
      ok: false,
      success: false,
      status: 500,
      message: 'Failed to load community reporter queue',
    });
  }
};
