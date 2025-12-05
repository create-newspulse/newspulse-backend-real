const CommunityReport = require('../models/CommunityReport');

// POST /api/community-reporter/submit
async function submitCommunityReport(req, res) {
  try {
    const body = req.body || {};
    const {
      reporterName,
      reporterEmail,
      reporterPhone,
      reporterCity,
      reporterState,
      reporterCountry,
      reporterType = 'community',
      category,
      headline,
      storyText,
      ageGroup,
      preferredLanguages,
    } = body;

    if (!reporterName || !reporterEmail || !category || !headline || !storyText) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const doc = new CommunityReport({
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
      preferredLanguages: Array.isArray(preferredLanguages) ? preferredLanguages : undefined,
    });

    await doc.save();
    return res.status(201).json({
      success: true,
      message: 'Community report submitted successfully',
      data: {
        id: doc._id.toString(),
        referenceId: doc.referenceId,
        status: doc.status,
        createdAt: doc.createdAt,
      },
    });
  } catch (e) {
    console.error('[COMMUNITY_REPORT][submit-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Server error creating report' });
  }
}

// GET /api/community-reporter/my-stories?email=...
async function listMyCommunityReports(req, res) {
  try {
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });
    const items = await CommunityReport.find({ reporterEmail: email }).sort({ createdAt: -1 }).lean();
    // Minimal projection for public list
    const mapped = items.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: i.status,
      createdAt: i.createdAt,
    }));
    return res.json({ success: true, items: mapped, total: mapped.length });
  } catch (e) {
    console.error('[COMMUNITY_REPORT][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
}

module.exports = { submitCommunityReport, listMyCommunityReports };
