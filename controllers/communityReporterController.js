const mongoose = require('mongoose');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const { logAudit } = require('../lib/audit');
let CommunityStory = null;
try { CommunityStory = require('../models/CommunityStory'); } catch (_) { /* optional model */ }
const CommunitySubmissionModel = require('../models/CommunitySubmission');

function _isValidObjectId(id) {
  return !!id && mongoose.isValidObjectId(String(id));
}

function _actorLabel(req) {
  const admin = req && req.admin ? req.admin : null;
  return {
    id: admin && admin.id ? String(admin.id) : null,
    email: admin && admin.email ? String(admin.email) : null,
    role: admin && admin.role ? String(admin.role) : null,
  };
}

function _parseBool(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function _normalizeEmail(value) {
  const e = String(value || '').trim().toLowerCase();
  return e || null;
}

async function _countLinkedSubmissionsForContact(contact) {
  // Safe linking: prefer reporterId, but also check normalized email fallbacks.
  const contactId = contact && contact._id ? contact._id : null;
  const email = _normalizeEmail(contact && contact.email);
  const or = [];
  if (contactId && _isValidObjectId(contactId)) {
    or.push({ reporterId: contactId });
  }
  if (email) {
    or.push({ reporterEmailNorm: email });
    or.push({ reporterEmail: email });
    or.push({ email });
    or.push({ 'contact.email': email });
  }
  if (!or.length) return 0;
  return CommunitySubmission.countDocuments({ $or: or, isDeleted: { $ne: true } });
}

async function _deleteLinkedSubmissionsForContact(contact) {
  const contactId = contact && contact._id ? contact._id : null;
  const email = _normalizeEmail(contact && contact.email);

  const or = [];
  if (contactId && _isValidObjectId(contactId)) {
    or.push({ reporterId: contactId });
  }
  if (email) {
    or.push({ reporterEmailNorm: email });
    or.push({ reporterEmail: email });
    or.push({ email });
    or.push({ 'contact.email': email });
  }
  if (!or.length) return { acknowledged: true, deletedCount: 0 };
  return CommunitySubmission.deleteMany({ $or: or });
}

// GET /api/community-reporter/queue
// Returns real queue items from CommunitySubmission with status mapping
async function getCommunityReporterQueue(req, res) {
  try {
    // In local/test runs without MongoDB, avoid Mongoose command buffering delays.
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      const status = (req.query.status || 'pending').toString();
      return res.status(200).json({
        ok: true,
        success: true,
        status: 200,
        data: [],
        meta: { statusFilter: status, total: 0, page: 1, limit: 0 },
        message: 'Community reporter queue',
      });
    }

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

// DELETE /api/community-reporter/contacts/:id
// Safe-delete default: blocks deletion when linked submissions exist.
// Optional cascade: ?cascade=true (or body.cascade=true) deletes linked submissions first.
async function deleteReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();
    const cascade = _parseBool(req.query && req.query.cascade) || _parseBool(req.body && req.body.cascade);

    if (!_isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Reporter contact not found' });
    }

    const linkedCount = await _countLinkedSubmissionsForContact(contact);
    if (linkedCount > 0 && !cascade) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete reporter contact while linked stories exist. Delete stories first.',
        linkedStories: linkedCount,
      });
    }

    let deletedStories = 0;
    if (linkedCount > 0 && cascade) {
      const del = await _deleteLinkedSubmissionsForContact(contact);
      deletedStories = del && typeof del.deletedCount === 'number' ? del.deletedCount : 0;
    }

    await ReporterContact.deleteOne({ _id: id });

    console.log('[ADMIN_DELETE][reporter-contact] deleted', { actor, id, cascade, deletedStories });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DELETE', id, { entity: 'ReporterContact', cascade, deletedStories });

    return res.status(200).json({
      success: true,
      message: 'Reporter contact deleted successfully',
      deletedId: id,
      ...(cascade ? { deletedStories } : {}),
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to delete reporter contact' });
  }
}

// POST /api/community-reporter/contacts/bulk-delete
// Body: { ids: string[], cascade?: boolean }
async function bulkDeleteReporterContacts(req, res) {
  const actor = _actorLabel(req);
  try {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    const cascade = _parseBool(req.query && req.query.cascade) || _parseBool(req.body && req.body.cascade);

    if (!ids || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }
    if (ids.length > 2000) {
      return res.status(400).json({ success: false, message: 'Too many ids (max 2000)' });
    }

    const normalizedIds = ids.map(x => String(x || '').trim()).filter(Boolean);
    const invalidIds = normalizedIds.filter(x => !_isValidObjectId(x));
    if (invalidIds.length) {
      return res.status(400).json({ success: false, message: 'Invalid contact id(s)', invalidIds });
    }

    const contacts = await ReporterContact.find({ _id: { $in: normalizedIds } }).lean();
    const foundIds = new Set(contacts.map(c => String(c._id)));
    const notFoundIds = normalizedIds.filter(x => !foundIds.has(String(x)));

    // Safer bulk semantics: do not partially delete when any linked stories exist
    const blocked = [];
    const deletableIds = [];
    let deletedStories = 0;

    for (const contact of contacts) {
      const linkedCount = await _countLinkedSubmissionsForContact(contact);
      if (linkedCount > 0 && !cascade) {
        blocked.push({ id: String(contact._id), linkedStories: linkedCount, reason: 'linked_stories' });
      } else {
        deletableIds.push(String(contact._id));
      }
    }

    if (blocked.length && !cascade) {
      console.log('[ADMIN_DELETE][reporter-contact][bulk] blocked', { actor, requested: normalizedIds.length, blocked: blocked.length });
      return res.status(400).json({
        success: false,
        message: 'Cannot delete reporter contact while linked stories exist. Delete stories first.',
        blocked,
      });
    }

    if (cascade) {
      // Cascade is supported but must be explicitly requested; still safe-guarded by admin/founder auth.
      for (const contact of contacts) {
        const linkedCount = await _countLinkedSubmissionsForContact(contact);
        if (linkedCount > 0) {
          const del = await _deleteLinkedSubmissionsForContact(contact);
          deletedStories += del && typeof del.deletedCount === 'number' ? del.deletedCount : 0;
        }
      }
    }

    const delRes = await ReporterContact.deleteMany({ _id: { $in: deletableIds } });
    const deletedCount = delRes && typeof delRes.deletedCount === 'number' ? delRes.deletedCount : deletableIds.length;

    console.log('[ADMIN_DELETE][reporter-contact][bulk] done', { actor, requested: normalizedIds.length, deletedCount, cascade, deletedStories, deletedIds: deletableIds });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_BULK_DELETE', null, { entity: 'ReporterContact', requested: normalizedIds.length, deletedCount, cascade, deletedStories });

    return res.status(200).json({
      success: true,
      message: 'Reporter contacts deleted successfully',
      deletedCount,
      // Keep these extra fields for debugging/admin UX; frontend can ignore.
      deletedIds: deletableIds,
      notFoundIds,
      ...(cascade ? { deletedStories } : {}),
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact][bulk] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to bulk delete reporter contacts' });
  }
}

// DELETE /api/community-reporter/stories/:id
async function deleteCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ ok: false, success: false, message: 'Story not found' });
    }

    // Safety: only allow deletes for community reporter submissions (sourceType community|journalist, or missing for legacy).
    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return res.status(400).json({ ok: false, success: false, message: 'Not a community reporter story' });
    }

    await CommunitySubmission.deleteOne({ _id: id });
    console.log('[ADMIN_DELETE][community-story] deleted', { actor, id, reporterId: doc.reporterId ? String(doc.reporterId) : null, email: doc.reporterEmailNorm || doc.reporterEmail || doc.email || null });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_DELETE', id, { entity: 'CommunitySubmission' });

    return res.status(200).json({ ok: true, success: true, message: 'Story deleted', deletedId: id });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story] error', { actor, message: e?.message || e });
    return res.status(500).json({ ok: false, success: false, message: 'Failed to delete story' });
  }
}

// POST /api/community-reporter/stories/bulk-delete
// Body: { ids: string[] }
async function bulkDeleteCommunityReporterStories(req, res) {
  const actor = _actorLabel(req);
  try {
    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ ok: false, success: false, message: 'ids array is required' });
    }
    if (ids.length > 5000) {
      return res.status(400).json({ ok: false, success: false, message: 'Too many ids (max 5000)' });
    }

    const normalizedIds = ids.map(x => String(x || '').trim()).filter(Boolean);
    const invalidIds = normalizedIds.filter(x => !_isValidObjectId(x));
    if (invalidIds.length) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid story id(s)', invalidIds });
    }

    // Safety filter: restrict to community reporter submissions.
    const filter = {
      _id: { $in: normalizedIds },
      $or: [
        { sourceType: { $in: ['community', 'journalist'] } },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };

    const del = await CommunitySubmission.deleteMany(filter);
    const deletedCount = del && typeof del.deletedCount === 'number' ? del.deletedCount : 0;
    console.log('[ADMIN_DELETE][community-story][bulk] deleted', { actor, requested: normalizedIds.length, deletedCount });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_BULK_DELETE', null, { entity: 'CommunitySubmission', requested: normalizedIds.length, deletedCount });

    return res.status(200).json({ ok: true, success: true, message: 'Bulk story delete completed', deletedCount });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story][bulk] error', { actor, message: e?.message || e });
    return res.status(500).json({ ok: false, success: false, message: 'Failed to bulk delete stories' });
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
}

// Admin: Reporter Directory list
async function listReporters(req, res) {
  try {
    // Accept common admin panel filters; default to 'all' and ignore when 'all'
    const {
      district = 'all',
      areaType = 'all',
      beat = 'all',
      activity = 'all',
    } = req.query || {};

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const q = {};
    if (district && String(district).toLowerCase() !== 'all') {
      q.districtName = new RegExp(String(district).trim(), 'i');
    }
    if (areaType && String(areaType).toLowerCase() !== 'all') {
      q.areaType = String(areaType).trim().toUpperCase();
    }
    if (beat && String(beat).toLowerCase() !== 'all') {
      // beats is an array; match by value equality
      q.beats = String(beat).trim().toUpperCase();
    }
    if (activity && String(activity).toLowerCase() !== 'all') {
      // Map activity to status field if present
      q.status = String(activity).trim().toUpperCase();
    }

    const sort = { fullName: 1 };
    const [itemsRaw, total] = await Promise.all([
      ReporterContact.find(q).sort(sort).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(q),
    ]);

    const items = itemsRaw.map(c => ({
      id: c._id.toString(),
      name: c.fullName,
      email: c.email,
      phone: c.phoneFull || c.phoneNumber || null,
      city: c.cityTownVillage,
      state: c.stateName,
      country: c.country,
      district: c.districtName,
      type: c.reporterType,
      status: c.status,
    }));

    return res.json({ ok: true, items, total, page, limit });
  } catch (e) {
    console.error('[ADMIN][listReporters] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter directory' });
  }
}

// Admin: Community summary stats
async function getCommunityStats(req, res) {
  try {
    const pendingStatuses = ['pending', 'under_review', 'PENDING_FOUNDER', 'UNDER_REVIEW', 'NEW'];
    const [pendingStories, totalReporters, verifiedJournalists] = await Promise.all([
      CommunitySubmission.countDocuments({ status: { $in: pendingStatuses } }),
      ReporterContact.countDocuments({}),
      ReporterContact.countDocuments({ $or: [ { verificationLevel: 'verified' }, { status: 'verified' } ] }),
    ]);
    return res.json({
      pendingStories,
      totalReporters,
      verifiedJournalists,
    });
  } catch (e) {
    console.error('[ADMIN][getCommunityStats] failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load community stats' });
  }
}

// Admin: Community Reporter Analytics
// GET /api/admin/community/reporters
async function getCommunityReporterAnalytics(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const pipeline = [
      { $match: { sourceType: 'community' } },
      {
        $group: {
          _id: '$reporterId',
          name: { $first: '$reporterName' },
          email: { $first: '$reporterEmail' },
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

    const items = await CommunitySubmissionModel.aggregate(pipeline);
    return res.json({ items, page, limit });
  } catch (err) {
    return next ? next(err) : res.status(500).json({ ok: false, message: 'Failed to load reporter analytics' });
  }
}

// POST /api/community-reporter/submit
async function submitCommunityReport(req, res) {
  try {
    const body = req.body || {};
    if (process.env.COMMUNITY_REPORTER_DEBUG_SUBMIT === '1') {
      console.log('[COMMUNITY_REPORTER][submit] incoming body', body);
    }

    // Support both nested payload ({ reporter, story }) and flat Phase-1 fields
    const reporter = body.reporter || {};
    const story = body.story || {};

    const name = String(
      body.name ||
      reporter.fullName ||
      reporter.name ||
      body.fullName ||
      body.reporterName ||
      ''
    ).trim();

    const email = String(
      body.email ||
      reporter.email ||
      body.reporterEmail ||
      ''
    ).trim().toLowerCase();

    const location = body.location ?? reporter.location ?? undefined;

    const headline = String(
      body.headline ||
      story.headline ||
      ''
    ).trim();

    const storyText = String(
      body.story ||
      body.storyText ||
      story.body ||
      story.storyText ||
      ''
    ).trim();

    const ageGroup = String(body.ageGroup || story.ageGroup || '').trim();

    if (!name || !email || !headline || !storyText || !ageGroup) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const locationObj = (location && typeof location === 'object') ? location : null;
    const locationText = (typeof location === 'string') ? location.trim() : undefined;

    const submission = await CommunitySubmissionModel.create({
      name,
      email,
      reporterName: name,
      reporterEmail: email,
      reporterLocation: locationText,
      location: locationObj ? {
        city: locationObj.city ?? null,
        state: locationObj.state ?? null,
        country: locationObj.country ?? null,
      } : { city: null, state: null, country: null },
      headline,
      body: storyText,
      ageGroup,
      status: 'NEW',
      sourceType: 'community',
      reporterVerificationLevel: 'unverified',
      ipAddress: req.ip ? String(req.ip) : undefined,
      userAgent: req.get('user-agent') ? String(req.get('user-agent')) : undefined,
    });

    return res.status(201).json({ success: true, id: submission._id });
  } catch (e) {
    console.error('CommunityReporterSubmit error:', e && e.stack ? e.stack : e);
    return res.status(500).json({ message: 'Internal error in Community Reporter submit' });
  }
}

// GET /api/community-reporter/my-stories?email=...
async function listMyCommunityReports(req, res) {
  try {
    const email = String(req.query.email || req.body?.email || '').trim().toLowerCase();
    // Log email used to search my stories
    console.log('[COMMUNITY_REPORT][my-stories] lookup email:', email);
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    // Case-insensitive match on reporterEmail in CommunitySubmission
    const emailRegex = new RegExp(`^${email}$`, 'i');
    const submissions = await CommunitySubmissionModel.find({ reporterEmail: emailRegex })
      .sort({ createdAt: -1 })
      .lean();

    // Also include legacy CommunityReport docs for completeness
    const legacyReports = await CommunityReport.find({ reporterEmail: emailRegex })
      .sort({ createdAt: -1 })
      .lean();

    const mappedSubs = submissions.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: (function () {
        const s = String(i.status || '').toLowerCase();
        if (['approved', 'rejected', 'withdrawn'].includes(s)) return s;
        return 'under_review';
      })(),
      createdAt: i.createdAt,
    }));

    const mappedLegacy = legacyReports.map(i => ({
      id: i._id.toString(),
      referenceId: i.referenceId || null,
      headline: i.headline,
      category: i.category,
      status: i.status || 'under_review',
      createdAt: i.createdAt,
    }));

    const items = [...mappedSubs, ...mappedLegacy].sort((a, b) => (new Date(b.createdAt)) - (new Date(a.createdAt)));
    return res.json({ success: true, items, total: items.length });
  } catch (e) {
    console.error('[COMMUNITY_REPORT][list-error]', e?.message || e);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
}

module.exports = {
  submitCommunityReport,
  listMyCommunityReports,
  getCommunityReporterQueue,
  listReporterContacts,
  listReporters,
  getCommunityStats,
  getCommunityReporterAnalytics,
  deleteReporterContact,
  bulkDeleteReporterContacts,
  deleteCommunityReporterStory,
  bulkDeleteCommunityReporterStories,
};
