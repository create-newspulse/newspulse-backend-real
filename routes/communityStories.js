const express = require('express');
const mongoose = require('mongoose');
const News = require('../models/News');
const CommunitySubmission = require('../models/CommunitySubmission');
let requireAdminAuth = (_req, _res, next) => next();
try { ({ requireAdminAuth } = require('../middleware/adminAuth')); } catch (_) {}

const router = express.Router();

// Determine if an article is community-origin
function isCommunityArticle(doc) {
  if (!doc) return false;
  if (doc.source === 'community') return true;
  if (doc.communityReportId) return true;
  return false;
}

// Build filter for "my" community stories belonging to current user.
// Since News doesn't store submittedBy, we derive via linked CommunitySubmission.
async function fetchSubmissionMap(ids) {
  if (!ids.length) return new Map();
  const subs = await CommunitySubmission.find({ _id: { $in: ids } }, 'reporterEmail reporterName email name city location state country').lean();
  const map = new Map();
  subs.forEach(s => map.set(String(s._id), s));
  return map;
}

// GET /api/community/stories/my
router.get('/stories/my', requireAdminAuth, async (req, res) => {
  try {
    // Auth user (admin/founder). For community ownership filtering we match submission reporterEmail if available.
    const currentEmail = req.admin?.email?.toLowerCase();

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (page - 1) * limit;
    const statusParam = (req.query.status || '').trim();
    const q = (req.query.q || '').trim();

    const baseFilter = { $or: [{ source: 'community' }, { communityReportId: { $exists: true } }] };
    if (statusParam && statusParam !== 'all') {
      baseFilter.status = statusParam;
    }
    if (q) {
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      baseFilter.$and = [
        { $or: [ { title: regex }, { description: regex }, { content: regex } ] }
      ];
    }

    // Initial query (community-origin only)
    const query = News.find(baseFilter).sort({ createdAt: -1 });
    const total = await News.countDocuments(baseFilter);
    const articles = await query.skip(skip).limit(limit).lean();

    // Collect linked submission IDs
    const subIds = articles.filter(a => a.communityReportId).map(a => a.communityReportId);
    const subMap = await fetchSubmissionMap(subIds);

    // Ownership filter: include only those whose submission reporterEmail matches current user (if currentEmail present)
    const owned = currentEmail
      ? articles.filter(a => {
          if (!isCommunityArticle(a)) return false;
          if (a.communityReportId) {
            const sub = subMap.get(String(a.communityReportId));
            const email = (sub?.reporterEmail || sub?.email || '').toLowerCase();
            return email === currentEmail;
          }
          // No linked submission -> treat as not owned by reporter
          return false;
        })
      : articles;

    const items = owned.map(a => {
      const sub = a.communityReportId ? subMap.get(String(a.communityReportId)) : null;
      return {
        _id: a._id,
        title: a.title,
        summary: a.description,
        content: a.content,
        status: a.status,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        language: a.language,
        category: a.category,
        location: sub?.city || sub?.location || null,
        city: sub?.city || null,
        source: a.source || null,
        submittedBy: (sub?.reporterEmail || sub?.email || null),
      };
    });

    return res.json({ ok: true, items, total: owned.length });
  } catch (e) {
    console.error('[COMMUNITY_STORIES][my-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load stories' });
  }
});

// POST /api/community/stories/:id/withdraw (optional)
router.post('/stories/:id/withdraw', requireAdminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, message: 'invalid id' });
    }
    const doc = await News.findById(id);
    if (!doc || !isCommunityArticle(doc)) {
      return res.status(404).json({ ok: false, message: 'Article not found' });
    }

    // Ownership enforcement if submission exists
    const currentEmail = req.admin?.email?.toLowerCase();
    if (doc.communityReportId && currentEmail) {
      const sub = await CommunitySubmission.findById(doc.communityReportId, 'reporterEmail email').lean();
      const email = (sub?.reporterEmail || sub?.email || '').toLowerCase();
      if (email && email !== currentEmail) {
        return res.status(403).json({ ok: false, message: 'Forbidden' });
      }
    }

    // Allowed statuses to withdraw: draft, scheduled (return to archived)
    if (!['draft','scheduled','published'].includes(doc.status)) {
      // Already archived/deleted; treat as idempotent success
      return res.json({ ok: true, article: doc });
    }
    doc.status = 'archived'; // Using archived as withdrawn marker (schema enum safe)
    await doc.save();
    return res.json({ ok: true, article: doc });
  } catch (e) {
    console.error('[COMMUNITY_STORIES][withdraw-error]', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to withdraw story' });
  }
});

module.exports = router;