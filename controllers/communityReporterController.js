const mongoose = require('mongoose');
const CommunityReport = require('../models/CommunityReport');
const CommunitySubmission = require('../models/CommunitySubmission');
const ReporterContact = require('../models/ReporterContact');
const ReporterProfile = require('../models/ReporterProfile');
const ReporterStoryLink = require('../models/ReporterStoryLink');
const News = require('../models/News');
const Article = require('../models/Article');
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

async function _countLinkedProfilesForContact(contact) {
  const id = contact && contact._id ? String(contact._id) : null;
  if (!id || !_isValidObjectId(id)) return 0;
  try {
    return await ReporterProfile.countDocuments({ reporterContactId: id, mergedIntoProfileId: null });
  } catch (_) {
    return 0;
  }
}

function _isProtectedContact(contact) {
  const verification = String(contact?.verificationLevel || '').trim().toLowerCase();
  // Treat verified directory entries as protected from hard delete.
  return verification === 'verified';
}

function _jsonError(res, status, { code, message, details }) {
  return res.status(status).json({
    success: false,
    ok: false,
    code,
    message,
    details: details || undefined,
  });
}

function _requireFounderOrAdminRole(req, res) {
  const role = String(req?.admin?.role || '').trim().toLowerCase();
  if (role === 'founder' || role === 'admin') return true;
  _jsonError(res, 403, { code: 'PERMISSION_DENIED', message: 'Permission denied' });
  return false;
}

function _isSubmissionInDeletedState(doc) {
  if (!doc) return false;
  if (doc.isDeleted === true) return true;
  if (doc.deletedAt) return true;
  const s = String(doc.status || '').trim().toLowerCase();
  return ['deleted', 'trash', 'archived', 'deactivated'].includes(s);
}

function _isNewsDocPubliclyVisible(newsDoc, now = new Date()) {
  if (!newsDoc) return false;
  const nowDt = now instanceof Date ? now : new Date(now);
  const status = String(newsDoc.status || '').trim().toLowerCase();
  if (status !== 'published') return false;

  const deletedAt = newsDoc.deletedAt ?? null;
  if (deletedAt) return false;
  if (newsDoc.locked === true) return false;

  const embargoUntil = newsDoc.embargoUntil ?? null;
  if (embargoUntil instanceof Date && embargoUntil.getTime() > nowDt.getTime()) return false;

  const publishAt = newsDoc.publishAt ?? null;
  if (publishAt instanceof Date && publishAt.getTime() > nowDt.getTime()) return false;

  if (newsDoc.workflow && typeof newsDoc.workflow === 'object') {
    if (newsDoc.workflow.locked === true) return false;
    const wEmbargo = newsDoc.workflow.embargoUntil ?? null;
    if (wEmbargo instanceof Date && wEmbargo.getTime() > nowDt.getTime()) return false;
  }

  return true;
}

function _isPublicArticleDocPubliclyVisible(articleDoc, now = new Date()) {
  if (!articleDoc) return false;
  const nowDt = now instanceof Date ? now : new Date(now);
  const status = String(articleDoc.status || '').trim().toLowerCase();
  if (status !== 'published') return false;
  const publishedAt = articleDoc.publishedAt ?? null;
  if (publishedAt instanceof Date && publishedAt.getTime() > nowDt.getTime()) return false;
  return true;
}

async function _aggregateSubmissionStatsByContactKey(contactKeys) {
  if (!Array.isArray(contactKeys) || contactKeys.length === 0) return new Map();

  const keys = contactKeys.map(k => String(k || '').trim()).filter(Boolean);
  if (keys.length === 0) return new Map();

  const approvedStatuses = ['approved', 'published', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app'];
  const publishedStatuses = ['published', 'publish', 'published_final'];
  const pendingStatuses = ['new', 'pending', 'under_review', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'underreview', 'review'];
  const rejectedStatuses = ['rejected', 'reject', 'trash', 'discarded', 'archived'];
  const withdrawnStatuses = ['withdrawn'];

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
        rejectedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', rejectedStatuses] }, 1, 0] } },
        withdrawnStories: { $sum: { $cond: [{ $in: ['$_statusNorm', withdrawnStatuses] }, 1, 0] } },
        publishedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', publishedStatuses] }, 1, 0] } },
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
      rejectedStories: Number(row.rejectedStories || 0),
      withdrawnStories: Number(row.withdrawnStories || 0),
      publishedStories: Number(row.publishedStories || 0),
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
    const hard = _parseBool(req.query?.hard);

    if (!_isMongoReady()) {
      return res.status(503).json({ success: false, message: 'Database not connected' });
    }

    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });
    }

    const contact = await ReporterContact.findById(id);
    if (!contact) {
      return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
    }

    if (hard && _isProtectedContact(contact)) {
      return _jsonError(res, 403, {
        code: 'CONTACT_IS_PROTECTED',
        message: 'This contact is protected and cannot be hard-deleted. Deactivate/archive instead.',
        details: { allowedActions: ['deactivate', 'archive'] },
      });
    }

    const linkedCount = await _countLinkedSubmissionsForContact(contact);
    if (linkedCount > 0) {
      return _jsonError(res, 409, {
        code: 'CONTACT_HAS_LINKED_STORIES',
        message: 'Cannot delete reporter contact while linked stories exist.',
        details: { linkedStories: linkedCount, allowedActions: ['deactivate', 'archive', 'reassign_stories'] },
      });
    }

    const linkedProfiles = await _countLinkedProfilesForContact(contact);
    if (linkedProfiles > 0) {
      return _jsonError(res, 409, {
        code: 'CONTACT_HAS_DEPENDENCIES',
        message: 'Cannot delete reporter contact while contributor profiles depend on it.',
        details: { linkedProfiles, allowedActions: ['deactivate', 'archive'] },
      });
    }

    if (hard) {
      await ReporterContact.deleteOne({ _id: id });
    } else {
      // Soft-delete: keep record to prevent accidental recreation/identity drift.
      await ReporterContact.updateOne(
        { _id: id },
        {
          $set: {
            status: 'banned',
            deletedAt: new Date(),
            deletedBy: actor,
          },
        }
      );
    }

    console.log('[ADMIN_DELETE][reporter-contact] deleted', { actor, deletedId: id, hard });
    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DELETE', id, { entity: 'ReporterContact', hard });

    return res.status(200).json({
      success: true,
      message: hard ? 'Reporter contact hard-deleted successfully' : 'Reporter contact deactivated (soft-deleted) successfully',
      mode: hard ? 'hard' : 'soft',
      deletedId: id,
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][reporter-contact] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to delete reporter contact' });
  }
}

// POST /api/admin/community-reporter/contacts/:id/deactivate
// Safely disables the contact without deleting the record.
async function deactivateReporterContact(req, res) {
  const actor = _actorLabel(req);
  try {
    const id = String(req.params.id || '').trim();
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_isValidObjectId(id)) return _jsonError(res, 400, { code: 'INVALID_CONTACT_ID', message: 'Invalid contact id' });

    const contact = await ReporterContact.findById(id).lean();
    if (!contact) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });

    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    await ReporterContact.updateOne(
      { _id: id },
      {
        $set: {
          status: 'suspended',
          suspendedAt: new Date(),
          suspendedBy: actor,
          ...(reason ? { suspendedReason: reason } : {}),
        },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_DEACTIVATE', id, { entity: 'ReporterContact', reason });
    return res.status(200).json({ success: true, id, status: 'suspended' });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][deactivate] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to deactivate reporter contact' });
  }
}

// POST /api/admin/community-reporter/contacts/:id/reassign-stories
// Moves stories from one ReporterContact to another (safe alternative to delete).
async function reassignReporterContactStories(req, res) {
  const actor = _actorLabel(req);
  try {
    const fromId = String(req.params.id || '').trim();
    const toId = String(req.body?.toContactId || '').trim();
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_isValidObjectId(fromId)) return _jsonError(res, 400, { code: 'INVALID_FROM_CONTACT_ID', message: 'Invalid from contact id' });
    if (!_isValidObjectId(toId)) return _jsonError(res, 400, { code: 'INVALID_TO_CONTACT_ID', message: 'Invalid to contact id' });
    if (fromId === toId) return _jsonError(res, 400, { code: 'SAME_CONTACT', message: 'from and to contacts must be different' });

    const [from, to] = await Promise.all([
      ReporterContact.findById(fromId).lean(),
      ReporterContact.findById(toId).lean(),
    ]);
    if (!from) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'From contact not found' });
    if (!to) return _jsonError(res, 404, { code: 'CONTACT_NOT_FOUND', message: 'To contact not found' });

    const fromEmail = _normalizeEmail(from.email);

    // Primary: move direct reporterId links.
    const direct = await CommunitySubmission.updateMany(
      { reporterId: fromId },
      { $set: { reporterId: toId } }
    );

    // Secondary: for older submissions without reporterId, optionally link by email.
    // Only set reporterId when currently null/missing to reduce risk of stealing stories.
    let emailLinked = { modifiedCount: 0 };
    if (fromEmail) {
      emailLinked = await CommunitySubmission.updateMany(
        {
          reporterId: { $in: [null, undefined] },
          $or: [
            { reporterEmailNorm: fromEmail },
            { reporterEmail: fromEmail },
            { email: fromEmail },
            { 'contact.email': fromEmail },
          ],
          isDeleted: { $ne: true },
        },
        { $set: { reporterId: toId } }
      );
    }

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_REASSIGN_STORIES', fromId, { entity: 'ReporterContact', toContactId: toId });
    console.log('[ADMIN][reporter-contact][reassign-stories]', { actor, fromId, toId });

    const directModified = typeof direct?.modifiedCount === 'number' ? direct.modifiedCount : (direct?.nModified || 0);
    const emailModified = typeof emailLinked?.modifiedCount === 'number' ? emailLinked.modifiedCount : (emailLinked?.nModified || 0);

    return res.status(200).json({
      success: true,
      fromId,
      toId,
      reassigned: {
        reporterIdMatches: directModified,
        emailMatches: emailModified,
      },
    });
  } catch (e) {
    console.error('[ADMIN][reporter-contact][reassign-stories] error', { actor, message: e?.message || e });
    return res.status(500).json({ success: false, message: 'Failed to reassign stories' });
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

    const hard = _parseBool(req.query?.hard);

    const deletedIds = [];
    const skipped = [];

    for (const id of validIds) {
      const contact = await ReporterContact.findById(id);
      if (!contact) {
        skipped.push({ id, code: 'CONTACT_NOT_FOUND', message: 'Reporter contact not found' });
        continue;
      }

      if (hard && _isProtectedContact(contact)) {
        skipped.push({ id, code: 'CONTACT_IS_PROTECTED', message: 'Protected contact cannot be hard-deleted' });
        continue;
      }

      const linkedCount = await _countLinkedSubmissionsForContact(contact);
      if (linkedCount > 0) {
        skipped.push({ id, code: 'CONTACT_HAS_LINKED_STORIES', message: 'Contact has linked stories', details: { linkedStories: linkedCount } });
        continue;
      }

      const linkedProfiles = await _countLinkedProfilesForContact(contact);
      if (linkedProfiles > 0) {
        skipped.push({ id, code: 'CONTACT_HAS_DEPENDENCIES', message: 'Contact has dependent contributor profiles', details: { linkedProfiles } });
        continue;
      }

      if (hard) {
        await ReporterContact.deleteOne({ _id: id });
      } else {
        await ReporterContact.updateOne(
          { _id: id },
          { $set: { status: 'banned', deletedAt: new Date(), deletedBy: actor } }
        );
      }

      deletedIds.push(id);
    }

    await logAudit(req, 'COMMUNITY_REPORTER_CONTACT_BULK_DELETE', null, {
      entity: 'ReporterContact',
      receivedCount,
      validCount: validIds.length,
      deletedCount: deletedIds.length,
      skippedCount: skipped.length,
      hard,
    });

    return res.status(200).json({
      success: true,
      message: hard ? 'Bulk hard delete completed' : 'Bulk deactivate (soft delete) completed',
      mode: hard ? 'hard' : 'soft',
      deletedCount: deletedIds.length,
      deletedIds,
      skipped,
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
      const base = { totalStories: 0, approvedStories: 0, pendingStories: 0, rejectedStories: 0, withdrawnStories: 0, publishedStories: 0, lastStoryAt: null };
      const stats = keys.reduce((acc, k) => {
        if (!k || !statsMap.has(k)) return acc;
        const row = statsMap.get(k);
        acc.totalStories += Number(row.totalStories || 0);
        acc.approvedStories += Number(row.approvedStories || 0);
        acc.pendingStories += Number(row.pendingStories || 0);
        acc.rejectedStories += Number(row.rejectedStories || 0);
        acc.withdrawnStories += Number(row.withdrawnStories || 0);
        acc.publishedStories += Number(row.publishedStories || 0);
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
        rejectedStories: Number(stats.rejectedStories || 0),
        withdrawnStories: Number(stats.withdrawnStories || 0),
        publishedStories: Number(stats.publishedStories || 0),
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
      return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    }

    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) {
      return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });
    }

    // Safety: only allow deletes for community reporter submissions (sourceType community|journalist, or missing for legacy).
    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (_isSubmissionInDeletedState(doc)) {
      return res.status(200).json({
        ok: true,
        success: true,
        action: 'soft_delete',
        message: 'Story is already in Deleted',
        id,
        alreadyDeleted: true,
        isDeleted: true,
        affectsLiveSite: false,
        linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
        row: {
          id,
          isDeleted: true,
          canSoftDelete: false,
          canRestore: true,
          canPermanentDelete: true,
        },
      });
    }

    const now = new Date();
    const prev = doc.previousStatus || (doc.status && String(doc.status).trim().toLowerCase() !== 'deleted' && String(doc.status).trim().toLowerCase() !== 'trash' ? String(doc.status) : null);
    await CommunitySubmission.updateOne(
      { _id: id },
      {
        $set: {
          isDeleted: true,
          deletedAt: now,
          deletedBy: actor,
          restoredAt: null,
          restoredBy: null,
          status: 'DELETED',
          ...(prev ? { previousStatus: prev } : {}),
        },
      }
    );

    console.log('[ADMIN_DELETE][community-story] soft-deleted', { actor, id, reporterId: doc.reporterId ? String(doc.reporterId) : null, email: doc.reporterEmailNorm || doc.reporterEmail || doc.email || null });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_SOFT_DELETE', id, { entity: 'CommunitySubmission' });

    return res.status(200).json({
      ok: true,
      success: true,
      action: 'soft_delete',
      message: 'Story moved to Deleted',
      id,
      isDeleted: true,
      deletedAt: now.toISOString(),
      affectsLiveSite: false,
      linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
      row: {
        id,
        isDeleted: true,
        canSoftDelete: false,
        canRestore: true,
        canPermanentDelete: true,
      },
    });
  } catch (e) {
    console.error('[ADMIN_DELETE][community-story] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'SOFT_DELETE_FAILED', message: 'Failed to move story to Deleted' });
  }
}

// POST /api/admin/community-reporter/stories/:storyId/restore
async function restoreCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });

    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (!_isSubmissionInDeletedState(doc)) {
      return _jsonError(res, 409, { code: 'STORY_NOT_DELETED_YET', message: 'Story must be deleted before it can be restored' });
    }

    const now = new Date();
    const prev = doc.previousStatus && String(doc.previousStatus).trim() ? String(doc.previousStatus).trim() : null;
    const restoreStatus = prev && prev.toLowerCase() !== 'deleted' && prev.toLowerCase() !== 'trash' ? prev : 'NEW';

    await CommunitySubmission.updateOne(
      { _id: id },
      {
        $set: {
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          restoredAt: now,
          restoredBy: actor,
          status: restoreStatus,
        },
        $unset: { previousStatus: 1 },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_STORY_RESTORE', id, { entity: 'CommunitySubmission', restoredStatus: restoreStatus });
    return res.status(200).json({
      ok: true,
      success: true,
      action: 'restore',
      message: 'Story restored',
      id,
      isDeleted: false,
      restoredAt: now.toISOString(),
      status: restoreStatus,
      affectsLiveSite: false,
      linkedArticleId: doc.linkedArticleId ? String(doc.linkedArticleId) : null,
      row: {
        id,
        isDeleted: false,
        canSoftDelete: true,
        canRestore: false,
        canPermanentDelete: false,
      },
    });
  } catch (e) {
    console.error('[ADMIN][community-story][restore] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'RESTORE_FAILED', message: 'Failed to restore story' });
  }
}

// POST /api/admin/community-reporter/stories/:storyId/withdraw
// Withdraw is a workflow action (not delete): it removes a story from the active review flow
// without setting isDeleted=true. Soft delete/restore/permanent-delete remain separate.
async function withdrawCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });

    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (_isSubmissionInDeletedState(doc)) {
      return _jsonError(res, 409, { code: 'STORY_DELETED', message: 'Withdraw is not allowed for deleted stories (restore or permanent delete instead)' });
    }

    const current = String(doc.status || '').trim();
    if (current && current.toLowerCase() === 'withdrawn') {
      return res.status(200).json({ ok: true, success: true, action: 'withdraw', id, alreadyWithdrawn: true, isDeleted: false, status: 'WITHDRAWN', withdrawnAt: doc.withdrawnAt ? new Date(doc.withdrawnAt).toISOString() : null, affectsLiveSite: false });
    }

    const now = new Date();
    const prev = doc.previousStatus || (current && !['deleted', 'trash', 'withdrawn'].includes(current.toLowerCase()) ? current : null);
    await CommunitySubmission.updateOne(
      { _id: id },
      {
        $set: {
          status: 'WITHDRAWN',
          withdrawnAt: now,
          decisionBy: actor,
          ...(prev ? { previousStatus: prev } : {}),
        },
      }
    );

    await logAudit(req, 'COMMUNITY_REPORTER_STORY_WITHDRAW', id, { entity: 'CommunitySubmission', previousStatus: prev || null });
    return res.status(200).json({ ok: true, success: true, action: 'withdraw', id, isDeleted: false, status: 'WITHDRAWN', withdrawnAt: now.toISOString(), previousStatus: prev || null, affectsLiveSite: false });
  } catch (e) {
    console.error('[ADMIN][community-story][withdraw] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'WITHDRAW_FAILED', message: 'Failed to withdraw story' });
  }
}

// DELETE /api/admin/community-reporter/stories/:storyId/permanent
async function permanentDeleteCommunityReporterStory(req, res) {
  const actor = _actorLabel(req);
  try {
    if (!_isMongoReady()) return _jsonError(res, 503, { code: 'DB_NOT_READY', message: 'Database not connected' });
    if (!_requireFounderOrAdminRole(req, res)) return;

    const id = String(req.params.storyId || req.params.id || '').trim();
    if (!_isValidObjectId(id)) {
      return _jsonError(res, 400, { code: 'INVALID_STORY_ID', message: 'Invalid story id' });
    }

    const doc = await CommunitySubmission.findById(id).lean();
    if (!doc) return _jsonError(res, 404, { code: 'STORY_NOT_FOUND', message: 'Story not found' });

    const st = doc && doc.sourceType ? String(doc.sourceType).toLowerCase() : '';
    if (st && st !== 'community' && st !== 'journalist') {
      return _jsonError(res, 400, { code: 'INVALID_STORY_TYPE', message: 'Not a community reporter story' });
    }

    if (!_isSubmissionInDeletedState(doc)) {
      return _jsonError(res, 409, { code: 'STORY_NOT_DELETED_YET', message: 'Story must be deleted before permanent delete' });
    }

    // Strict separation rule:
    // Community Story Desk permanent delete MUST delete only the CommunitySubmission record.
    // It must NOT unpublish/archive/delete any linked News/Article (Manage News controls live site).
    const linkedNewsId = doc.linkedArticleId ? String(doc.linkedArticleId) : null;
    const linkedArticleId = doc.articleId ? String(doc.articleId) : null;

    // Best-effort cleanup: avoid leaving News.communityReportId pointing at a deleted submission.
    // This does not affect live visibility (no status changes).
    let newsDoc = null;
    if (linkedNewsId && _isValidObjectId(linkedNewsId)) {
      try {
        newsDoc = await News.findById(linkedNewsId)
          .select('communityReportId')
          .lean();
      } catch (_) {
        newsDoc = null;
      }
    }

    // Cleanup: avoid leaving broken references.
    if (linkedNewsId && newsDoc && newsDoc.communityReportId && String(newsDoc.communityReportId) === String(doc._id)) {
      await News.updateOne({ _id: linkedNewsId }, { $set: { communityReportId: null } });
    }

    await ReporterStoryLink.deleteMany({ submissionId: id });
    await CommunitySubmission.deleteOne({ _id: id });

    await logAudit(req, 'COMMUNITY_REPORTER_STORY_PERMANENT_DELETE', id, {
      entity: 'CommunitySubmission',
      linkedNewsId,
      linkedArticleId,
      affectsLiveSite: false,
    });
    return res.status(200).json({
      ok: true,
      success: true,
      action: 'permanent_delete',
      message: 'Story permanently deleted',
      id,
      isDeleted: true,
      linkedArticleId: linkedNewsId,
      articleId: linkedArticleId,
      affectsLiveSite: false,
      row: null,
    });
  } catch (e) {
    console.error('[ADMIN][community-story][permanent-delete] error', { actor, message: e?.message || e });
    return _jsonError(res, 500, { code: 'PERMANENT_DELETE_FAILED', message: 'Failed to permanently delete story' });
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

    if (!_requireFounderOrAdminRole(req, res)) return;

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

    // Soft-delete in bulk (permanent delete is intentionally NOT supported in bulk).
    const now = new Date();
    let modifiedCount = 0;
    try {
      // Prefer update pipeline to preserve previousStatus where absent.
      const resUpd = await CommunitySubmission.updateMany(
        filter,
        [
          {
            $set: {
              isDeleted: true,
              deletedAt: now,
              deletedBy: actor,
              restoredAt: null,
              restoredBy: null,
              previousStatus: { $ifNull: ['$previousStatus', '$status'] },
              status: 'DELETED',
            },
          },
        ]
      );
      modifiedCount = typeof resUpd?.modifiedCount === 'number' ? resUpd.modifiedCount : (resUpd?.nModified || 0);
    } catch (e) {
      const resUpd = await CommunitySubmission.updateMany(
        filter,
        {
          $set: {
            isDeleted: true,
            deletedAt: now,
            deletedBy: actor,
            restoredAt: null,
            restoredBy: null,
            status: 'DELETED',
          },
        }
      );
      modifiedCount = typeof resUpd?.modifiedCount === 'number' ? resUpd.modifiedCount : (resUpd?.nModified || 0);
    }

    console.log('[ADMIN_DELETE][community-story][bulk] soft-deleted', { actor, requested: normalizedIds.length, modifiedCount, ids: normalizedIds });
    await logAudit(req, 'COMMUNITY_REPORTER_STORY_BULK_SOFT_DELETE', null, { entity: 'CommunitySubmission', requested: normalizedIds.length, modifiedCount, ids: normalizedIds });

    return res.status(200).json({ ok: true, success: true, action: 'bulk_soft_delete', modifiedCount, ids: normalizedIds });
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

    const approvedStatuses = ['approved', 'approve', 'approved_final', 'approved_founder', 'approved_by_founder', 'approved_by_admin', 'app', 'published', 'publish', 'published_final'];
    const publishedStatuses = ['published', 'publish', 'published_final'];
    const pendingStatuses = ['new', 'pending', 'under_review', 'underreview', 'ai_reviewed', 'pending_founder', 'pending_founder_review', 'pendingfounder', 'pendingfounderreview', 'review'];
    const rejectedStatuses = ['rejected', 'reject', 'trash', 'discarded', 'archived'];
    const withdrawnStatuses = ['withdrawn'];

    const pipeline = [
      { $match: { sourceType: 'community', isDeleted: { $ne: true } } },
      {
        $addFields: {
          _emailRaw: { $ifNull: ['$reporterEmailNorm', { $ifNull: ['$reporterEmail', { $ifNull: ['$email', '$contact.email'] }] }] },
          _nameRaw: { $ifNull: ['$reporterName', { $ifNull: ['$name', '$contact.name'] }] },
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
          _statusNorm: {
            $cond: [
              { $or: [{ $eq: ['$status', null] }, { $eq: ['$status', ''] }] },
              '',
              { $toLower: { $trim: { input: { $toString: '$status' } } } },
            ],
          },
          reporterKey: {
            $cond: [
              { $and: [{ $ne: ['$reporterProfileId', null] }, { $ne: ['$reporterProfileId', ''] }] },
              { $toString: '$reporterProfileId' },
              {
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
            ],
          },
        },
      },
      { $match: { reporterKey: { $ne: null } } },
      {
        $group: {
          _id: '$reporterKey',
          name: { $first: '$_nameRaw' },
          email: { $first: '$_emailNorm' },
          totalStories: { $sum: 1 },
          approvedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', approvedStatuses] }, 1, 0] } },
          pendingStories: { $sum: { $cond: [{ $in: ['$_statusNorm', pendingStatuses] }, 1, 0] } },
          rejectedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', rejectedStatuses] }, 1, 0] } },
          withdrawnStories: { $sum: { $cond: [{ $in: ['$_statusNorm', withdrawnStatuses] }, 1, 0] } },
          publishedStories: { $sum: { $cond: [{ $in: ['$_statusNorm', publishedStatuses] }, 1, 0] } },
          lastStoryAt: { $max: '$createdAt' },
        },
      },
      { $sort: { totalStories: -1, lastStoryAt: -1 } },
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
  deactivateReporterContact,
  reassignReporterContactStories,
  bulkDeleteReporterContacts,
  deleteCommunityReporterStory,
  restoreCommunityReporterStory,
  withdrawCommunityReporterStory,
  permanentDeleteCommunityReporterStory,
  bulkDeleteCommunityReporterStories,
};
