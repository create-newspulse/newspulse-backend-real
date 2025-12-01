const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');
const ReporterContact = require('../models/ReporterContact');
const CommunitySubmission = require('../models/CommunitySubmission');

const router = express.Router();

// Placeholder admin community-reporter routes to ensure server boots.
// Keep responses minimal; real implementations can extend these.
router.get('/submissions', requireAdminAuth, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;
    const { source, q } = req.query || {};

    // Map external status query to internal statuses. Default missing to "pending" grouping.
    const rawStatus = (req.query.status || 'pending').toString().toLowerCase();
    let statusFilter; // either {$in: [...]} or direct equality string or undefined
    if (rawStatus === 'pending') {
      statusFilter = { $in: ['pending', 'PENDING_FOUNDER', 'under_review'] };
    } else if (rawStatus === 'rejected') {
      statusFilter = { $in: ['rejected', 'REJECTED'] };
    } else if (rawStatus === 'approved') {
      statusFilter = { $in: ['approved', 'APPROVED'] };
    } else if (rawStatus === 'all') {
      // No status restriction (future list views). Safer current default is to leave unfiltered.
      statusFilter = undefined;
    } else {
      // Fallback: treat as direct equality to allow future explicit statuses.
      statusFilter = rawStatus;
    }

    // Base filter: exclude soft-deleted if your schema uses such flags.
    // Note: current schema has no deleted flags; keep placeholder for future.
    const filter = {};

    // Backwards compatibility: submissions without sourceType are treated as community reporters.
    // (Submissions created before reporter directory integration lacked sourceType.)
    if (!source || source === 'all') {
      // no sourceType restriction applied here
    }
    if (source === 'community') {
      filter.$or = [
        { sourceType: 'community' },
        { sourceType: { $exists: false } },
        { sourceType: null },
      ];
    } else if (source === 'journalist' || source === 'journalists' || source === 'verified_journalists') {
      filter.sourceType = 'journalist';
    } // else source=all -> no sourceType restriction

    // Apply status filter if provided
    if (statusFilter !== undefined) {
      filter.status = statusFilter;
    }

    // Optional simple text search on headline or location
    if (q && String(q).trim()) {
      const regex = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = (filter.$or || []).concat([
        { headline: regex },
        { location: regex },
      ]);
    }

    const query = CommunitySubmission.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit);
    const [items, total] = await Promise.all([
      query.lean(),
      CommunitySubmission.countDocuments(filter),
    ]);

    const mapped = items.map(s => ({
      id: s._id.toString(),
      headline: s.headline,
      story: s.body,
      category: s.category,
      location: s.location || (s.locationDetail && s.locationDetail.city) || null,
      status: s.status,
      sourceType: s.sourceType || 'community', // compatibility default
      reporterVerificationLevel: s.reporterVerificationLevel || 'community_default',
      reporterId: s.reporterId || null,
      reporterName: s.reporterName || s.name || (s.contact && s.contact.name) || null,
      reporterEmail: s.reporterEmail || s.email || (s.contact && s.contact.email) || null,
      riskScore: s.riskScore || 0,
      flags: s.flags || [],
      createdAt: s.createdAt,
    }));

    console.log('[ADMIN_COMMUNITY][list] rawStatus=%s, appliedStatusFilter=%j, count=%d', rawStatus, statusFilter, mapped.length);

    // Response shape expected by admin UI
    return res.json({ success: true, submissions: mapped, total, page, limit });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][submissions] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Failed to load submissions' });
  }
});

// GET /admin/community/journalist-applications
router.get('/journalist-applications', requireAdminAuth, async (req, res) => {
  try {
    const { status = 'pending' } = req.query || {};
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitRaw = Math.max(parseInt(req.query.limit || '20', 10), 1);
    const limit = Math.min(limitRaw, 100);
    const skip = (page - 1) * limit;

    const filter = { reporterType: 'journalist' };
    if (status) filter.verificationLevel = status;

    const [items, total] = await Promise.all([
      ReporterContact.find(filter).sort({ verifiedAt: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      ReporterContact.countDocuments(filter),
    ]);

    const enriched = await Promise.all(items.map(async (c) => {
      let storiesCount = 0;
      try { storiesCount = await CommunitySubmission.countDocuments({ reporterId: c._id }); } catch (_) {}
      return {
        _id: c._id,
        id: c._id.toString(),
        name: c.fullName || null,
        email: c.email || null,
        phone: c.phoneFull || null,
        city: c.cityTownVillage || null,
        state: c.stateName || null,
        country: c.country || null,
        reporterType: c.reporterType,
        verificationLevel: c.verificationLevel,
        status: c.status,
        languages: c.languages || [],
        organisationName: c.organisationName || null,
        organisationType: c.organisationType || null,
        positionTitle: c.positionTitle || null,
        beatsProfessional: c.beatsProfessional || [],
        yearsExperience: c.yearsExperience || null,
        ethicsStrikes: c.ethicsStrikes || 0,
        journalistCharterAccepted: c.journalistCharterAccepted || false,
        charterAcceptedAt: c.charterAcceptedAt || null,
        storiesCount,
        verifiedBy: c.verifiedBy || null,
        verifiedAt: c.verifiedAt || null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    }));

    return res.json({ ok: true, items: enriched, page, limit, total });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][journalist-applications] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});

// POST /admin/community/journalist-applications/:id/verify
router.post('/journalist-applications/:id/verify', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const contact = await ReporterContact.findById(id);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    contact.reporterType = 'journalist';
    contact.verificationLevel = 'verified';
    contact.status = 'active';
    contact.verifiedBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
    contact.verifiedAt = new Date();
    if (typeof contact.save === 'function') {
      await contact.save();
    }
    return res.json({ ok: true, contact });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][verify] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to verify journalist' });
  }
});

// POST /admin/community/journalist-applications/:id/reject
router.post('/journalist-applications/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { reason } = req.body || {};
    const contact = await ReporterContact.findById(id);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    contact.reporterType = 'journalist';
    contact.verificationLevel = 'revoked';
    if (reason) {
      contact.behaviourNotes = contact.behaviourNotes || [];
      contact.behaviourNotes.push({ note: String(reason), createdBy: (req.admin && (req.admin.email || req.admin.id)) || 'system' });
    }
    if (typeof contact.save === 'function') {
      await contact.save();
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][reject] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to reject journalist' });
  }
});

// NEW: POST /admin/community/reporters/:id/status
router.post('/reporters/:id/status', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const { status, verificationLevel, addStrike, note } = req.body || {};
    const contact = await ReporterContact.findById(id);
    if (!contact) return res.status(404).json({ ok: false, message: 'Reporter contact not found' });
    const allowedStatus = ['active','watchlist','suspended','banned'];
    if (status) {
      if (!allowedStatus.includes(status)) return res.status(400).json({ ok: false, message: 'Invalid status' });
      contact.status = status;
    }
    const allowedVerif = ['community_default','pending','verified','limited','revoked'];
    if (verificationLevel) {
      if (!allowedVerif.includes(verificationLevel)) return res.status(400).json({ ok: false, message: 'Invalid verificationLevel' });
      contact.verificationLevel = verificationLevel;
    }
    if (addStrike === true) {
      contact.ethicsStrikes = (contact.ethicsStrikes || 0) + 1;
    }
    if (note) {
      contact.behaviourNotes = contact.behaviourNotes || [];
      contact.behaviourNotes.push({ note: String(note), createdBy: (req.admin && (req.admin.email || req.admin.id)) || 'system' });
    }
    if (typeof contact.save === 'function') {
      await contact.save();
    }
    return res.json({ ok: true, contact });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY_REPORTER][status] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to update reporter status' });
  }
});

module.exports = router;

// Detail view alias: GET /api/admin/community-reporter/submissions/:id
// Reuse the same response shape as legacy admin route
router.get('/submissions/:id', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res.status(400).json({ success: false, message: 'Missing submission id' });
    }
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) {
      return res.status(400).json({ success: false, message: 'Invalid submission id format' });
    }
    const submission = await CommunitySubmission.findById(id).lean();
    if (!submission) {
      return res.status(404).json({ success: false, message: 'Submission not found' });
    }
    return res.json({ success: true, submission });
  } catch (err) {
    console.error('[ADMIN_COMMUNITY_REPORTER][submission-detail] error', err?.message || err);
    return res.status(500).json({ success: false, message: 'Failed to load submission' });
  }
});

// POST /api/admin/community-reporter/submissions/:id/decision
// Accepts body { decision: 'approve'|'reject', rejectReason?, status? } and maps to internal status
router.post('/submissions/:id/decision', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Missing submission id' });
    }
    const isObjectIdLike = /^[a-fA-F0-9]{24}$/.test(id);
    if (!isObjectIdLike) {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid submission id format' });
    }
    let submission;
    try {
      submission = await CommunitySubmission.findById(id);
    } catch (findErr) {
      console.error('[ADMIN_COMMUNITY][decision][find-error]', findErr?.message || findErr);
      return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to load submission for decision', error: findErr?.message || String(findErr) });
    }
    if (!submission) {
      return res.status(404).json({ ok: false, success: false, status: 404, message: 'Submission not found' });
    }

    // Support multiple input keys: decision, status, action
    const decisionInput = (req.body && (req.body.decision || req.body.status || req.body.action)) || '';
    const decisionRaw = String(decisionInput).trim().toLowerCase();
    const rejectReason = (req.body && (req.body.rejectReason || req.body.reason)) || undefined;
    const hardDelete = Boolean(req.query.hard === '1' || req.query.hard === 'true' || req.body?.hard === true || req.body?.hardDelete === true);

    try {
      console.log('[ADMIN_COMMUNITY][decision] id=%s body=%j hard=%s by=%s', id, req.body || {}, hardDelete, (req.admin && (req.admin.email || req.admin.id)) || 'system');
    } catch (_) {}

    // Extended synonym lists
    const approveSet = new Set(['approve','approved','publish','published','ok']);
    const rejectSet = new Set(['reject','rejected','deny','denied','trash','delete','deleted','remove','discard']);

    if (approveSet.has(decisionRaw)) {
      submission.status = 'APPROVED';
      submission.rejectReason = undefined;
    } else if (rejectSet.has(decisionRaw)) {
      if (hardDelete === true) {
        try {
          const del = await CommunitySubmission.deleteOne({ _id: id });
          console.log('[ADMIN_COMMUNITY][decision][hard-delete] id=%s deleted=%j', id, del);
          return res.json({ ok: true, success: true, deleted: true, submissionId: id });
        } catch (delErr) {
          console.error('[ADMIN_COMMUNITY][decision][hard-delete][error]', delErr?.message || delErr);
          return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to hard delete submission' });
        }
      }
      submission.status = 'REJECTED';
      submission.rejectReason = rejectReason || 'Not specified';
    } else {
      return res.status(400).json({ ok: false, success: false, status: 400, message: 'Invalid decision' });
    }

    // Audit metadata if fields exist
    try {
      if ('decisionBy' in submission) {
        submission.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
      }
      if ('decisionAt' in submission) {
        submission.decisionAt = new Date();
      }
      if ('updatedAt' in submission) {
        submission.updatedAt = new Date();
      }
    } catch (_) {}

    try {
      console.log('[ADMIN_COMMUNITY][decision][pre-save]', { id: submission._id.toString(), status: submission.status, rejectReason: submission.rejectReason });
      if (typeof submission.save === 'function') {
        await submission.save();
      }
      console.log('[ADMIN_COMMUNITY][decision][post-save]', { id: submission._id.toString(), status: submission.status });
    } catch (saveErr) {
      console.error('[community decision][save-error]', saveErr?.message || saveErr);
      // Fallback for legacy docs failing validation: perform direct update without full validation
      try {
        const setObj = { status: submission.status };
        if (submission.status === 'REJECTED') {
          setObj.rejectReason = submission.rejectReason || 'Not specified';
        } else {
          setObj.rejectReason = undefined;
        }
        if ('decisionBy' in submission) setObj.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
        if ('decisionAt' in submission) setObj.decisionAt = new Date();
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[community decision][fallback-update]', upd);
        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh });
      } catch (updErr) {
        console.error('[community decision][fallback-update-error]', updErr?.message || updErr);
        return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to apply decision', error: updErr?.message || String(updErr) });
      }
    }

    return res.json({ ok: true, success: true, submission });
  } catch (err) {
    console.error('[community decision][unhandled]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, status: 500, message: 'Failed to apply decision', error: err?.message || String(err) });
  }
});

// Explicit action endpoints used by some admin UI builds
router.post('/submissions/:id/approve', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Submission not found' });
    submission.status = 'APPROVED';
    submission.rejectReason = undefined;
    try {
      if ('decisionBy' in submission) submission.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
      if ('decisionAt' in submission) submission.decisionAt = new Date();
      if ('updatedAt' in submission) submission.updatedAt = new Date();
    } catch (_) {}
    try {
      await submission.save();
      return res.json({ ok: true, success: true, submission });
    } catch (e) {
      // Fallback update without validation
      try {
        const setObj = { status: 'APPROVED', rejectReason: undefined };
        if ('decisionBy' in submission) setObj.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
        if ('decisionAt' in submission) setObj.decisionAt = new Date();
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[ADMIN_COMMUNITY][approve][fallback-update]', upd);
        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh });
      } catch (ue) {
        console.error('[ADMIN_COMMUNITY][approve][fallback-error]', ue?.message || ue);
        return res.status(500).json({ ok: false, success: false, message: 'Approve failed', error: ue?.message || String(ue) });
      }
    }
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][approve][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Approve failed' });
  }
});

router.post('/submissions/:id/reject', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    const rejectReason = (req.body && (req.body.rejectReason || req.body.reason)) || 'Not specified';
    const hardDelete = Boolean(req.query.hard === '1' || req.query.hard === 'true' || req.body?.hard === true || req.body?.hardDelete === true);
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid submission id' });
    }
    if (hardDelete) {
      try {
        const del = await CommunitySubmission.deleteOne({ _id: id });
        console.log('[ADMIN_COMMUNITY][reject][hard-delete]', { id, del });
        return res.json({ ok: true, success: true, deleted: true, submissionId: id });
      } catch (delErr) {
        console.error('[ADMIN_COMMUNITY][reject][hard-delete][error]', delErr?.message || delErr);
        return res.status(500).json({ ok: false, success: false, message: 'Failed to hard delete' });
      }
    }
    const submission = await CommunitySubmission.findById(id);
    if (!submission) return res.status(404).json({ ok: false, message: 'Submission not found' });
    submission.status = 'REJECTED';
    submission.rejectReason = rejectReason;
    try {
      if ('decisionBy' in submission) submission.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
      if ('decisionAt' in submission) submission.decisionAt = new Date();
      if ('updatedAt' in submission) submission.updatedAt = new Date();
    } catch (_) {}
    try {
      await submission.save();
      return res.json({ ok: true, success: true, submission });
    } catch (e) {
      // Fallback update without validation
      try {
        const setObj = { status: 'REJECTED', rejectReason };
        if ('decisionBy' in submission) setObj.decisionBy = (req.admin && (req.admin.email || req.admin.id)) || 'system';
        if ('decisionAt' in submission) setObj.decisionAt = new Date();
        if ('updatedAt' in submission) setObj.updatedAt = new Date();
        const upd = await CommunitySubmission.updateOne({ _id: submission._id }, { $set: setObj });
        console.log('[ADMIN_COMMUNITY][reject][fallback-update]', upd);
        const fresh = await CommunitySubmission.findById(submission._id).lean();
        return res.json({ ok: true, success: true, submission: fresh });
      } catch (ue) {
        console.error('[ADMIN_COMMUNITY][reject][fallback-error]', ue?.message || ue);
        return res.status(500).json({ ok: false, success: false, message: 'Reject failed', error: ue?.message || String(ue) });
      }
    }
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][reject][error]', e?.message || e);
    return res.status(500).json({ ok: false, success: false, message: 'Reject failed' });
  }
});

// Debug route to inspect raw document quickly (admin only)
router.get('/submissions/:id/debug', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id || !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ ok: false, message: 'Invalid id' });
    }
    let doc;
    try { doc = await CommunitySubmission.findById(id).lean({ virtuals: true }); } catch (e) {
      console.error('[ADMIN_COMMUNITY][debug][find-error]', e?.message || e);
      return res.status(500).json({ ok: false, message: 'Find error', error: e?.message || String(e) });
    }
    if (!doc) return res.status(404).json({ ok: false, message: 'Not found' });
    return res.json({ ok: true, doc });
  } catch (e) {
    console.error('[ADMIN_COMMUNITY][debug][unhandled]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Unhandled', error: e?.message || String(e) });
  }
});
