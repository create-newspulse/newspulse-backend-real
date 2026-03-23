const mongoose = require('mongoose');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const { logAudit } = require('../lib/audit');
let CommunityStory = null;
try { CommunityStory = require('../models/CommunityStory'); } catch (_) { /* optional model */ }
const CommunitySubmissionModel = require('../models/CommunitySubmission');
const { upsertReporterContact } = require('../services/reporterContactService');

function _isMongoReady() {
  return !!(mongoose.connection && mongoose.connection.readyState === 1);
}

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

function _normalizePhone(value) {
  const p = String(value || '').trim();
  return p || null;
}

function _deriveApprovalState(statusValue) {
  const s = String(statusValue || '').trim().toLowerCase();
  if (!s) return 'pending';
  if (['approved', 'published'].includes(s)) return 'approved';
  if (['rejected', 'trash', 'deleted'].includes(s)) return 'rejected';
  if (['new', 'pending', 'under_review', 'ai_reviewed', 'pending_founder', 'pendingfounder', 'pending_founder_review'].includes(s)) return 'pending';
  if (s.includes('approve')) return 'approved';
  if (s.includes('reject')) return 'rejected';
  return 'pending';
}

function _buildSubmissionMatchForContact(contact) {
  const contactId = contact && contact._id ? String(contact._id) : null;
  const email = _normalizeEmail(contact && contact.email);
  const phoneFull = _normalizePhone(contact && (contact.phoneFull || contact.phoneNumber));
  const userId = contact && contact.userId ? String(contact.userId) : null;

  const or = [];
  if (contactId && _isValidObjectId(contactId)) {
    or.push({ reporterId: contactId });
  }
  if (userId) {
    or.push({ reporterUserId: userId });
  }
  if (email) {
    or.push({ reporterEmailNorm: email });
    or.push({ reporterEmail: email });
    or.push({ email });
    or.push({ 'contact.email': email });
  }
  if (phoneFull) {
    or.push({ 'contact.phone': phoneFull });
  }
  return or;
}

async function _countLinkedSubmissionsForContact(contact) {
  const or = _buildSubmissionMatchForContact(contact);
  if (!or.length) return 0;
  return CommunitySubmission.countDocuments({ $or: or, isDeleted: { $ne: true } });
}

async function _aggregateSubmissionStatsByContactKey(contactKeys) {
  if (!Array.isArray(contactKeys) || contactKeys.length === 0) return new Map();

  const keys = contactKeys.map(k => String(k || '').trim()).filter(Boolean);
  if (keys.length === 0) return new Map();

  const approvedStatuses = ['approved', 'published', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app'];
  const pendingStatuses = ['new', 'pending', 'under_review', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'underreview', 'review'];

  const pipeline = [
    { $match: { isDeleted: { $ne: true } } },
    {
      $addFields: {
        _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
      },
    },
    {
      $addFields: {
        _emailNorm: {
          $cond: [
            { $or: [{ $eq: ['$_emailRaw', null] }, { $eq: ['$_emailRaw', ''] }] },
            null,
            { $toLower: { $trim: { input: { $toString: '$_emailRaw' } } } },
          ],
        },
      },
    },
    {
      $addFields: {
        _statusNorm: {
          $cond: [
            { $or: [{ $eq: ['$status', null] }, { $eq: ['$status', ''] }] },
            '',
            { $toLower: { $trim: { input: { $toString: '$status' } } } },
          ],
        },
        contactKey: {
          $cond: [
            { $and: [{ $ne: ['$reporterId', null] }, { $ne: ['$reporterId', ''] }] },
            { $toString: '$reporterId' },
            {
              $cond: [
                { $and: [{ $ne: ['$_emailNorm', null] }, { $ne: ['$_emailNorm', ''] }] },
                '$_emailNorm',
                {
                  $cond: [
                    { $and: [{ $ne: ['$contact.phone', null] }, { $ne: ['$contact.phone', ''] }] },
                    { $toString: '$contact.phone' },
                    null,
                  ],
                },
              ],
            },
          ],
        },
      },
    },
    { $match: { contactKey: { $in: keys } } },
    {
      $group: {
        _id: '$contactKey',
        totalStories: { $sum: 1 },
        approvedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', approvedStatuses] }, 1, 0] } },
        pendingStories: { $sum: { $cond: [{ $in: ['$_statusNorm', pendingStatuses] }, 1, 0] } },
        lastStoryAt: { $max: '$createdAt' },
      },
    },
  ];

  const rows = await CommunitySubmission.aggregate(pipeline);
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const k = row && row._id !== undefined && row._id !== null ? String(row._id) : '';
    if (!k) continue;
    map.set(k, {
      totalStories: Number(row.totalStories || 0),
      approvedStories: Number(row.approvedStories || 0),
      pendingStories: Number(row.pendingStories || 0),
      lastStoryAt: row.lastStoryAt || null,
    });
  }
  return map;
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
      reporterName: (d.contact && d.contact.name) || d.reporterName || d.name || null,
      reporterEmail: d.reporterEmailNorm || d.reporterEmail || d.email || (d.contact && d.contact.email) || null,
      reporterPhone: (d.contact && d.contact.phone) || null,
      location: d.reporterLocation || (d.location && d.location.city) || d.city || null,
      locationObj: d.location || d.locationDetail || null,
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
async function deleteReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();

    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    if (!_isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id);
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Reporter contact not found' });
    }

    const linkedCount = await _countLinkedSubmissionsForContact(contact);
    if (linkedCount > 0) {
      return res.status(400).json({
        success: false,
        message: 'Cannot delete reporter contact while linked stories exist. Delete stories first.',
      });
    }

    await ReporterContact.deleteOne({ _id: id });

    console.log('[ADMIN_DELETE][reporter-contact] deleted', { actor, deletedId: id });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DELETE', id, { entity: 'ReporterContact' });

    return res.status(200).json({
      success: true,
      message: 'Reporter contact deleted successfully',
      deletedId: id,
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to delete reporter contact' });
  }
}

// POST /api/community-reporter/contacts/bulk-delete
// Body: { ids: string[] }
async function bulkDeleteReporterContacts(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }

    const receivedCount = ids.length;
    const validIds = ids
      .map(x => String(x || '').trim())
      .filter(Boolean)
      .filter(mongoose.Types.ObjectId.isValid);

    if (validIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid ids provided', receivedCount });
    }

    console.log('Bulk delete contacts ids:', validIds.length);

    const delRes = await ReporterContact.deleteMany({ _id: { $in: validIds } });
    const deletedCount = delRes && typeof delRes.deletedCount === 'number' ? delRes.deletedCount : 0;

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_BULK_DELETE', null, { entity: 'ReporterContact', receivedCount, validCount: validIds.length, deletedCount });

    return res.status(200).json({
      success: true,
      message: 'Reporter contacts deleted successfully',
      deletedCount,
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact][bulk] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to bulk delete reporter contacts' });
  }
}

function _escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _contactKeyForContact(contact) {
  const contactId = contact && contact._id ? String(contact._id) : null;
  if (contactId && _isValidObjectId(contactId)) return contactId;
  const email = _normalizeEmail(contact && contact.email);
  if (email) return email;
  const phone = _normalizePhone(contact && (contact.phoneFull || contact.phoneNumber));
  if (phone) return phone;
  return null;
}

function _contactKeysForContact(contact) {
  const out = [];
  const contactId = contact && contact._id ? String(contact._id) : null;
  if (contactId && _isValidObjectId(contactId)) out.push(contactId);
  const email = _normalizeEmail(contact && contact.email);
  if (email) out.push(email);
  const phone = _normalizePhone(contact && (contact.phoneFull || contact.phoneNumber));
  if (phone) out.push(phone);
  return Array.from(new Set(out));
}

// GET /api/admin/community-reporter/contacts
async function adminListReporterContacts(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const q = String(req.query.q || '').trim();
    const filter = {};
    if (q) {
      const rx = new RegExp(_escapeRegExp(q), 'i');
      filter.$or = [
        { fullName: rx },
        { email: rx },
        { phoneFull: rx },
        { phoneNumber: rx },
        { cityTownVillage: rx },
        { districtName: rx },
        { stateName: rx },
        { country: rx },
      ];
    }

    const sort = { 'stats.lastStoryAt': -1, fullName: 1 };
    const [contacts, total] = await Promise.all([
      ReporterContact.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(filter),
    ]);

    const allKeys = contacts.flatMap(_contactKeysForContact).filter(Boolean);
    const statsMap = await _aggregateSubmissionStatsByContactKey(allKeys);

    const items = contacts.map(c => {
      const keys = _contactKeysForContact(c);
      const base = { totalStories: 0, approvedStories: 0, pendingStories: 0, lastStoryAt: null };
      const stats = keys.reduce((acc, k) => {
        if (!k || !statsMap.has(k)) return acc;
        const row = statsMap.get(k);
        acc.totalStories += Number(row.totalStories || 0);
        acc.approvedStories += Number(row.approvedStories || 0);
        acc.pendingStories += Number(row.pendingStories || 0);
        const last = row.lastStoryAt ? new Date(row.lastStoryAt) : null;
        const current = acc.lastStoryAt ? new Date(acc.lastStoryAt) : null;
        if (last && (!current || last > current)) acc.lastStoryAt = row.lastStoryAt;
        return acc;
      }, base);

      return {
        id: String(c._id),
        name: c.fullName || null,
        email: c.email || null,
        emailLower: c.emailLower || (c.email ? String(c.email).toLowerCase() : null),
        phone: c.phoneFull || c.phoneNumber || null,
        city: c.cityTownVillage || null,
        district: c.districtName || null,
        state: c.stateName || null,
        country: c.country || null,
        reporterType: c.reporterType || null,
        type: (c.reporterType === 'journalist') ? 'Journalist' : 'Community Reporter',
        verification: c.verificationLevel || null,
        status: c.status || null,
        storiesCount: Number(stats.totalStories || 0),
        totalStories: Number(stats.totalStories || 0),
        approvedStories: Number(stats.approvedStories || 0),
        pendingStories: Number(stats.pendingStories || 0),
        approvedCount: Number(stats.approvedStories || 0),
        pendingCount: Number(stats.pendingStories || 0),
        lastStoryAt: stats.lastStoryAt || null,
        lastStoryTitle: (c.stats && c.stats.lastStoryTitle) ? String(c.stats.lastStoryTitle) : null,
      };
    });

    return res.status(200).json({ success: true, items, total, page, limit });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contacts] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load reporter contacts' });
  }
}

// GET /api/admin/community-reporter/contacts/:id/stories
async function adminListReporterContactStories(req, res) {
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const id = String(req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) {
      return res.status(404).json({ success: false, message: 'Reporter contact not found' });
    }

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '50', 10), 1);
    const limit = Math.min(limitRaw, 200);
    const skip = (page - 1) * limit;

    const or = _buildSubmissionMatchForContact(contact);
    if (!or.length) {
      return res.status(200).json({ success: true, items: [], total: 0, page, limit });
    }

    const safetyFilter = {
      $or: [
        { sourceType: { $in: ['community', 'journalist'] } },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };

    const filter = { $and: [{ $or: or }, { isDeleted: { $ne: true } }, safetyFilter] };

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    const items = docs.map(d => ({
      id: String(d._id),
      referenceId: d.referenceId || null,
      headline: d.headline || '',
      category: d.category || null,
      status: d.status || null,
      approvalState: _deriveApprovalState(d.status),
      location: d.location || d.locationDetail || null,
      createdAt: d.createdAt || null,
      updatedAt: d.updatedAt || null,
      reporterId: d.reporterId ? String(d.reporterId) : null,
      reporterEmail: d.reporterEmailNorm || d.reporterEmail || d.email || (d.contact && d.contact.email) || null,
      reporterName: d.reporterName || d.name || (d.contact && d.contact.name) || null,
    }));

    return res.status(200).json({ success: true, items, total, page, limit });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][contact-stories] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load stories' });
  }
}

// POST /api/admin/community-reporter/contacts/backfill
// Founder/Admin only: backfill ReporterContact directory from existing CommunitySubmission docs.
async function backfillReporterContactsFromSubmissions(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const limitRaw = parseInt((req.body && req.body.limit) || req.query.limit || '5000', 10);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50000) : 5000;
    const dryRun = _parseBool((req.body && req.body.dryRun) || req.query.dryRun);

    // Match community submissions (older docs may not have sourceType)
    const matchCommunity = {
      isDeleted: { $ne: true },
      $or: [
        { sourceType: 'community' },
        { source: 'community' },
        { sourceType: { $exists: false } },
        { sourceType: null },
        { sourceType: '' },
      ],
    };

    const approvedNorm = ['approved', 'published', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app', 'approvedok'];
    const pendingNorm = ['new', 'pending', 'under_review', 'underreview', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'pendingfounder', 'under-review'];

    // One aggregation to get scan counts + reporter groups
    const epoch = new Date(0);
    const facetPipeline = [
      { $match: matchCommunity },
      {
        $addFields: {
          _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
          _nameRaw: { $ifNull: ['$reporterName', { $ifNull: ['$name', '$contact.name'] }] },
          _headlineRaw: { $ifNull: ['$headline', ''] },
          _phoneRaw: { $ifNull: ['$contact.phone', { $ifNull: ['$phone', '$phoneNumber'] }] },
          _cityRaw: { $ifNull: ['$location.city', { $ifNull: ['$locationDetail.city', '$city'] }] },
          _districtRaw: { $ifNull: ['$locationDetail.district', '$district'] },
          _stateRaw: { $ifNull: ['$location.state', { $ifNull: ['$locationDetail.state', '$state'] }] },
          _countryRaw: { $ifNull: ['$location.country', { $ifNull: ['$locationDetail.country', '$country'] }] },
          _statusRaw: { $ifNull: ['$status', ''] },
        },
      },
      {
        $addFields: {
          emailNorm: {
            $cond: [
              { $or: [{ $eq: ['$_emailRaw', null] }, { $eq: ['$_emailRaw', ''] }] },
              null,
              { $toLower: { $trim: { input: { $toString: '$_emailRaw' } } } },
            ],
          },
          nameNorm: {
            $cond: [
              { $or: [{ $eq: ['$_nameRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_nameRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_nameRaw' } } },
            ],
          },
          headlineNorm: {
            $cond: [
              { $or: [{ $eq: ['$_headlineRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_headlineRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_headlineRaw' } } },
            ],
          },
          phoneNorm: {
            $cond: [
              { $or: [{ $eq: ['$_phoneRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_phoneRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_phoneRaw' } } },
            ],
          },
          cityNorm: {
            $cond: [
              { $or: [{ $eq: ['$_cityRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_cityRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_cityRaw' } } },
            ],
          },
          districtNorm: {
            $cond: [
              { $or: [{ $eq: ['$_districtRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_districtRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_districtRaw' } } },
            ],
          },
          stateNorm: {
            $cond: [
              { $or: [{ $eq: ['$_stateRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_stateRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_stateRaw' } } },
            ],
          },
          countryNorm: {
            $cond: [
              { $or: [{ $eq: ['$_countryRaw', null] }, { $eq: [{ $trim: { input: { $toString: '$_countryRaw' } } }, ''] }] },
              null,
              { $trim: { input: { $toString: '$_countryRaw' } } },
            ],
          },
          statusNorm: { $toLower: { $trim: { input: { $toString: '$_statusRaw' } } } },
        },
      },
      {
        $facet: {
          scanned: [{ $count: 'scannedSubmissions' }],
          skippedNoEmail: [
            { $match: { emailNorm: null } },
            { $count: 'skippedNoEmail' },
          ],
          reporters: [
            { $match: { emailNorm: { $ne: null } } },
            {
              $group: {
                _id: '$emailNorm',
                totalStories: { $sum: 1 },
                approvedStories: { $sum: { $cond: [{ $in: ['$statusNorm', approvedNorm] }, 1, 0] } },
                pendingStories: { $sum: { $cond: [{ $in: ['$statusNorm', pendingNorm] }, 1, 0] } },
                lastStoryAt: { $max: '$createdAt' },

                // Latest non-empty values
                namePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$nameNorm', null] },
                      { ts: '$createdAt', v: '$nameNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                phonePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$phoneNorm', null] },
                      { ts: '$createdAt', v: '$phoneNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                cityPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$cityNorm', null] },
                      { ts: '$createdAt', v: '$cityNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                districtPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$districtNorm', null] },
                      { ts: '$createdAt', v: '$districtNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                statePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$stateNorm', null] },
                      { ts: '$createdAt', v: '$stateNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                countryPick: {
                  $max: {
                    $cond: [
                      { $ne: ['$countryNorm', null] },
                      { ts: '$createdAt', v: '$countryNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
                headlinePick: {
                  $max: {
                    $cond: [
                      { $ne: ['$headlineNorm', null] },
                      { ts: '$createdAt', v: '$headlineNorm' },
                      { ts: epoch, v: null },
                    ],
                  },
                },
              },
            },
            { $sort: { totalStories: -1 } },
            { $limit: limit },
          ],
        },
      },
    ];

    const facetResArr = await CommunitySubmissionModel.aggregate(facetPipeline);
    const facetRes = Array.isArray(facetResArr) && facetResArr.length ? facetResArr[0] : {};
    const scannedSubmissions = Number(facetRes?.scanned?.[0]?.scannedSubmissions || 0);
    const skippedNoEmail = Number(facetRes?.skippedNoEmail?.[0]?.skippedNoEmail || 0);
    const reporters = Array.isArray(facetRes?.reporters) ? facetRes.reporters : [];
    const uniqueReporters = reporters.length;

    let upserted = 0;
    if (!dryRun && reporters.length) {
      const ops = reporters.map(r => {
        const email = String(r._id || '').trim().toLowerCase();
        const set = {
          emailLower: email,
          'stats.totalStories': Number(r.totalStories || 0),
          'stats.approvedStories': Number(r.approvedStories || 0),
          'stats.pendingStories': Number(r.pendingStories || 0),
          'stats.lastStoryAt': r.lastStoryAt || null,
        };

        const headline = r.headlinePick && r.headlinePick.v ? String(r.headlinePick.v).trim() : '';
        if (headline) set['stats.lastStoryTitle'] = headline;

        const name = r.namePick && r.namePick.v ? String(r.namePick.v).trim() : '';
        if (name) set.fullName = name;

        const phone = r.phonePick && r.phonePick.v ? String(r.phonePick.v).trim() : '';
        if (phone) set.phoneFull = phone;

        const city = r.cityPick && r.cityPick.v ? String(r.cityPick.v).trim() : '';
        const district = r.districtPick && r.districtPick.v ? String(r.districtPick.v).trim() : '';
        let state = r.statePick && r.statePick.v ? String(r.statePick.v).trim() : '';
        let country = r.countryPick && r.countryPick.v ? String(r.countryPick.v).trim() : '';

        // If older docs stored "City, State" into city, split it.
        let cityOut = city;
        if (cityOut && cityOut.includes(',') && !state) {
          const parts = cityOut.split(',').map(s => s.trim()).filter(Boolean);
          cityOut = parts[0] || cityOut;
          state = parts[1] || state;
          if (!country) country = parts[2] || country;
        }

        if (cityOut) set.cityTownVillage = cityOut;
        if (district) set.districtName = district;
        if (state) set.stateName = state;
        if (country) set.country = country;

        return {
          updateOne: {
            filter: { $or: [{ emailLower: email }, { email }] },
            update: {
              $set: set,
              $setOnInsert: {
                fullName: name || 'Unknown',
                email,
                emailLower: email,
                reporterType: 'community',
                // Preserve existing verification/status if contact already exists
                verificationLevel: 'community_default',
                status: 'active',
              },
            },
            upsert: true,
          },
        };
      });

      const bulkRes = await ReporterContact.bulkWrite(ops, { ordered: false });
      const matched = bulkRes && typeof bulkRes.matchedCount === 'number' ? bulkRes.matchedCount : 0;
      const inserted = bulkRes && typeof bulkRes.upsertedCount === 'number' ? bulkRes.upsertedCount : 0;
      upserted = matched + inserted;
      if (!upserted) upserted = reporters.length;
    }

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_BACKFILL', null, {
      actor,
      limit,
      dryRun,
      scannedSubmissions,
      uniqueReporters,
      upserted,
      skippedNoEmail,
    });

    return res.status(200).json({
      success: true,
      message: 'Backfill completed',
      processed: uniqueReporters,
      contactsCreatedOrUpdated: upserted,
      scannedSubmissions,
      uniqueReporters,
      upserted,
      skippedNoEmail,
    });
  } catch (e) {
    console.error('[ADMIN][backfillReporterContactsFromSubmissions] failed', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to backfill reporter contacts' });
  }
}

// DELETE /api/admin/community-reporter/stories/:storyId
async function deleteCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) {
      return res.status(404).json({ success: false, message: 'Story not found' });
    }

    // Safety: only allow deletes for community reporter submissions (sourceType community|journalist, or missing for legacy).
    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return res.status(400).json({ success: false, message: 'Not a community reporter story' });
    }

    await CommunitySubmission.deleteOne({ _id: id });
    console.log('[ADMIN_DELETE][community-story] deleted', { actor, id, reporterId: doc.reporterId ? String(doc.reporterId) : null, email: doc.reporterEmailNorm || doc.reporterEmail || doc.email || null });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_DELETE', id, { entity: 'CommunitySubmission' });

    return res.status(200).json({ success: true, message: 'Story deleted successfully', deletedId: id });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to delete story' });
  }
}

// POST /api/community-reporter/stories/bulk-delete
// Body: { ids: string[] }
async function bulkDeleteCommunityReporterStories(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
    if (!ids || ids.length === 0) {
      return res.status(400).json({ success: false, message: 'ids array is required' });
    }
    if (ids.length > 5000) {
      return res.status(400).json({ success: false, message: 'Too many ids (max 5000)' });
    }

    const normalizedIds = ids.map(x => String(x || '').trim()).filter(Boolean);
    const invalidIds = normalizedIds.filter(x => !_isValidObjectId(x));
    if (invalidIds.length) {
      return res.status(400).json({ success: false, message: 'Invalid story id(s)', invalidIds });
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
    console.log('[ADMIN_DELETE][community-story][bulk] deleted', { actor, requested: normalizedIds.length, deletedCount, deletedIds: normalizedIds });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_BULK_DELETE', null, { entity: 'CommunitySubmission', requested: normalizedIds.length, deletedCount, deletedIds: normalizedIds });

    return res.status(200).json({ success: true, message: 'Stories deleted successfully', deletedCount });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story][bulk] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to bulk delete stories' });
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

    // Auto-upsert into Reporter Contact Directory (email is primary key)
    try {
      const phone = String(
        body.phone ||
        body.phoneNumber ||
        (body.contact && body.contact.phone) ||
        (reporter && (reporter.phone || reporter.phoneNumber)) ||
        ''
      ).trim();

      const city = locationObj ? (locationObj.city ?? null) : null;
      const state = locationObj ? (locationObj.state ?? null) : null;
      const country = locationObj ? (locationObj.country ?? null) : null;

      const { contactId } = await upsertReporterContact({
        name,
        email,
        phone: phone || undefined,
        city: city || undefined,
        state: state || undefined,
        country: country || undefined,
        reporterType: 'community',
        stats: {
          lastStoryAt: submission.createdAt || new Date(),
          lastStoryTitle: headline,
        },
      });

      if (contactId && !submission.reporterId) {
        await CommunitySubmissionModel.updateOne(
          { _id: submission._id },
          { $set: { reporterId: contactId } }
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[COMMUNITY_REPORTER][submit] contact upsert failed', e?.message || e);
    }

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
  adminListReporterContacts,
  adminListReporterContactStories,
  backfillReporterContactsFromSubmissions,
  listReporterContacts,
  listReporters,
  getCommunityStats,
  getCommunityReporterAnalytics,
  deleteReporterContact,
  bulkDeleteReporterContacts,
  deleteCommunityReporterStory,
  bulkDeleteCommunityReporterStories,
};
