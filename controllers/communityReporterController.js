const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');

// GET /api/community-reporter/queue
// Returns real queue items from CommunitySubmission with status mapping
async function getCommunityReporterQueue(req, res) {
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
    const data = contacts.map(c => ({
      id: c._id.toString(),
      name: c.fullName,
      email: c.email,
      phone: c.phoneFull || c.phoneNumber || null,
      country: c.country,
      state: c.stateName,
      district: c.districtName,
      city: c.cityTownVillage,
      reporterType: c.reporterType,
      verificationLevel: c.verificationLevel,
      status: c.status,
      stats: c.stats || {},
      lastStoryAt: c.stats && c.stats.lastStoryAt ? c.stats.lastStoryAt : null,
    }));
    return res.status(200).json({ ok: true, success: true, status: 200, data, total: data.length, message: 'Reporter contacts directory' });
  } catch (err) {
    console.error('Error in listReporterContacts:', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load reporter contacts' });
  }
}

// POST /api/community-reporter/submit
async function submitCommunityReport(req, res) {
  try {
    console.log('[community-reporter-submit] incoming body', req.body);
    const body = req.body || {};
    // Support both nested payload ({ reporter, story }) and flat fields
    const reporter = body.reporter || {};
    const story = body.story || {};

    const reporterName = (reporter.fullName || body.reporterName || '').trim();
    const reporterEmail = (reporter.email || body.reporterEmail || '').trim().toLowerCase();
    const reporterPhone = reporter.phone || body.reporterPhone || undefined;
    const reporterCity = reporter.city || body.reporterCity || undefined;
    const reporterState = reporter.state || body.reporterState || undefined;
    const reporterCountry = reporter.country || body.reporterCountry || undefined;
    const reporterTypeRaw = (reporter.reporterType || body.reporterType || 'community').toString();
    const preferredLanguages = Array.isArray(reporter.preferredLanguages) ? reporter.preferredLanguages : (Array.isArray(body.preferredLanguages) ? body.preferredLanguages : undefined);

    const category = (story.category || body.category || '').trim();
    const headline = (story.headline || body.headline || '').trim();
    const storyText = (story.body || body.storyText || '').trim();
    const ageGroup = story.ageGroup || body.ageGroup || undefined;
    const locationCity = story.locationCity || undefined;
    const locationState = story.locationState || undefined;
    const urgency = story.urgency || 'normal';
    const canContact = ('canContact' in story) ? !!story.canContact : true;

    const agreesToEthics = ('agreesToEthics' in reporter) ? reporter.agreesToEthics : undefined;

    // Basic validation -> 400, not 500
    if (!reporterName || !reporterEmail || !reporterPhone || !category || !headline || !storyText) {
      return res.status(400).json({
        ok: false,
        message: 'VALIDATION_ERROR',
        details: {
          reporterName: Boolean(reporterName),
          reporterEmail: Boolean(reporterEmail),
          reporterPhone: Boolean(reporterPhone),
          category: Boolean(category),
          headline: Boolean(headline),
          story: Boolean(storyText),
        }
      });
    }
    if (agreesToEthics !== undefined && agreesToEthics !== true) {
      return res.status(400).json({ ok: false, message: 'VALIDATION_ERROR', details: { agreesToEthics: false } });
    }

    const doc = new CommunityReport({
      reporterName: String(reporterName).trim(),
      reporterEmail: String(reporterEmail).trim().toLowerCase(),
      reporterPhone: reporterPhone || undefined,
      reporterCity: (locationCity || reporterCity) || undefined,
      reporterState: (locationState || reporterState) || undefined,
      reporterCountry: reporterCountry || undefined,
      reporterType: (reporterTypeRaw === 'professional' || reporterTypeRaw === 'journalist') ? 'professional' : 'community',
      category: String(category).trim(),
      headline: String(headline).trim(),
      storyText: String(storyText).trim(),
      ageGroup: ageGroup || undefined,
      preferredLanguages: Array.isArray(preferredLanguages) ? preferredLanguages : undefined,
      status: 'pending',
      reviewNotes: undefined,
    });

    await doc.save();
    const reporterTypeOut = doc.reporterType === 'professional' ? 'journalist' : 'community';
    const statusOut = 'under_review'; // map internal 'pending' to external 'under_review'

    return res.status(201).json({
      ok: true,
      message: 'Story submitted successfully.',
      storyId: doc._id.toString(),
      referenceId: doc.referenceId || doc._id.toString(),
      status: statusOut,
      reporterType: reporterTypeOut,
      reporterName: doc.reporterName,
    });
  } catch (e) {
    console.error('[COMMUNITY_REPORT][submit-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'SERVER_ERROR' });
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

module.exports = { submitCommunityReport, listMyCommunityReports, getCommunityReporterQueue, listReporterContacts };
