/*
Manual verification (local):

1) Public submit
curl -X POST http://localhost:5051/api/public/ads/inquiry \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com","message":"Hello"}'

2) Admin list (requires admin JWT)
curl "http://localhost:5051/admin-api/ads/inquiries?status=new&page=1&limit=20" \
  -H "Authorization: Bearer <ADMIN_JWT>"

3) Admin unread count
curl http://localhost:5051/admin-api/ads/inquiries/unread-count \
  -H "Authorization: Bearer <ADMIN_JWT>"

4) Admin update status
curl -X PATCH http://localhost:5051/admin-api/ads/inquiries/<ID> \
  -H "Authorization: Bearer <ADMIN_JWT>" \
  -H "Content-Type: application/json" \
  -d '{"status":"read"}'
*/

const mongoose = require('mongoose');

const AdInquiry = require('../models/AdInquiry');
const adsMailer = require('../utils/mailer');

const STATUS_VALUES = ['new', 'read', 'deleted'];

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _isValidEmail(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function _parseInt(v, fallback) {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function _toDto(doc) {
  if (!doc) return null;

  const meta = doc.meta && typeof doc.meta === 'object' ? doc.meta : {};

  return {
    id: String(doc._id),
    name: doc.name,
    email: doc.email,
    message: doc.message,
    status: doc.status,
    readAt: doc.readAt || null,
    deletedAt: doc.deletedAt || null,
    meta: {
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      referer: meta.referer ?? null,
      site: meta.site ?? null,
    },
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function submitPublicAdInquiry(req, res) {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ success: false, message: 'Database unavailable' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const message = String(body.message || '').trim();

    if (!_isNonEmptyString(name)) {
      return res.status(400).json({ success: false, message: 'Missing required field: name' });
    }
    if (!_isNonEmptyString(email)) {
      return res.status(400).json({ success: false, message: 'Missing required field: email' });
    }
    if (!_isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }
    if (!_isNonEmptyString(message)) {
      return res.status(400).json({ success: false, message: 'Missing required field: message' });
    }

    const ip = req.ip ? String(req.ip) : null;
    const userAgent = req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : null;
    const referer = (req.headers && (req.headers['referer'] || req.headers['referrer']))
      ? String(req.headers['referer'] || req.headers['referrer'])
      : null;
    const site = (req.headers && req.headers.origin) ? String(req.headers.origin) : null;

    const inquiry = await AdInquiry.create({
      name,
      email,
      message,
      status: 'new',
      readAt: null,
      deletedAt: null,
      meta: {
        ip,
        userAgent,
        referer,
        site,
      },
    });

    const id = inquiry && inquiry._id ? String(inquiry._id) : null;
    console.log(`[ads] inquiry saved id=${id}`);

    let emailSent = false;
    try {
      await adsMailer.sendAdsInquiryMail({
        name,
        email,
        message,
        createdAt: inquiry?.createdAt || new Date(),
        inquiryId: id,
        meta: {
          ip,
          userAgent,
          referer,
          site,
        },
      });
      emailSent = true;
      console.log(`[ads] email sent id=${id}`);
    } catch (e) {
      console.warn(`[ads] email failed id=${id} error=${e?.message || String(e)}`);
    }

    // Keep response minimal/stable for the public website.
    return res.status(201).json({ success: true, id });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function listAdminAdInquiries(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const statusRaw = String(req.query.status || 'new').trim().toLowerCase();
    const status = statusRaw === 'all' ? 'all' : (STATUS_VALUES.includes(statusRaw) ? statusRaw : 'new');

    const page = Math.max(_parseInt(req.query.page, 1), 1);
    const limit = _clampInt(_parseInt(req.query.limit, 20), 1, 100);
    const skip = (page - 1) * limit;

    const searchRaw = String(req.query.search || '').trim();

    const filter = {};
    if (status !== 'all') filter.status = status;

    if (searchRaw) {
      const q = _escapeRegex(searchRaw);
      const rx = new RegExp(q, 'i');
      filter.$or = [
        { name: rx },
        { email: rx },
        { message: rx },
      ];
    }

    const [items, total] = await Promise.all([
      AdInquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdInquiry.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      items: (items || []).map(_toDto),
      page,
      limit,
      total: typeof total === 'number' ? total : 0,
    });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function getAdminUnreadCount(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const count = await AdInquiry.countDocuments({ status: 'new' });
    return res.status(200).json({ success: true, unread: typeof count === 'number' ? count : 0 });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function patchAdminInquiryStatus(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const statusRaw = String(body.status || '').trim().toLowerCase();
    if (!STATUS_VALUES.includes(statusRaw)) {
      return res.status(400).json({ success: false, message: 'Invalid status' });
    }

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      { $set: { status: statusRaw } },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ success: false, message: 'Not found' });

    return res.status(200).json(_toDto(updated));
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function markAdminInquiryRead(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      { $set: { status: 'read', readAt: new Date() } },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ success: false, message: 'Not found' });

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function patchAdminInquiryStatusById(req, res) {
  return patchAdminInquiryStatus(req, res);
}

async function deleteAdminInquiry(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      { $set: { status: 'deleted', deletedAt: new Date() } },
      { new: true, runValidators: true }
    ).lean();
    if (!updated) return res.status(404).json({ success: false, message: 'Not found' });

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function restoreAdminInquiry(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      { $set: { status: 'new', deletedAt: null } },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ success: false, message: 'Not found' });
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function hardDeleteAdminInquiry(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const deleted = await AdInquiry.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ success: false, message: 'Not found' });

    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

module.exports = {
  submitPublicAdInquiry,
  listAdminAdInquiries,
  getAdminUnreadCount,
  markAdminInquiryRead,
  patchAdminInquiryStatusById,
  deleteAdminInquiry,
  restoreAdminInquiry,
  hardDeleteAdminInquiry,
  STATUS_VALUES,
};
