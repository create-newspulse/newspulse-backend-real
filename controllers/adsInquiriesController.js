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
const sanitizeHtml = require('sanitize-html');

const AdInquiry = require('../models/AdInquiry');
const AuditLog = require('../models/AuditLog');
const adsMailer = require('../utils/mailer');
const { normalizeAdOpportunityKey } = require('../src/constants/adSlots');

const STATUS_VALUES = ['new', 'read', 'deleted'];
const PUBLIC_AD_INQUIRY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const PUBLIC_AD_INQUIRY_RATE_LIMIT_MAX = 8;
const publicAdInquiryRateBuckets = new Map();

function _getAdsDbState() {
  const connection = (AdInquiry && AdInquiry.db) ? AdInquiry.db : mongoose.connection;
  const readyState = typeof connection?.readyState === 'number' ? connection.readyState : -1;
  const dbName = connection?.name ? String(connection.name) : null;
  return {
    readyState,
    dbName,
    sameAsDefaultConnection: connection === mongoose.connection,
  };
}

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return _getAdsDbState().readyState === 1;
}

function _logAdsDebug(tag, details) {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return;

  const db = _getAdsDbState();
  console.log('[ads][debug]', tag, {
    readyState: db.readyState,
    dbName: db.dbName,
    sameAsDefaultConnection: db.sameAsDefaultConnection,
    ...(details && typeof details === 'object' ? details : {}),
  });
}

function _ensureDbReady(req, res, tag) {
  if (isDbReady()) return true;

  _logAdsDebug(tag, {
    url: req.originalUrl,
    status: 'db-unavailable',
  });

  res.status(503).json({ success: false, message: 'Database unavailable' });
  return false;
}

function _buildUnreadFilter() {
  return {
    status: { $ne: 'deleted' },
    $or: [
      { isRead: false },
      { isRead: { $exists: false }, status: 'new' },
    ],
  };
}

function _buildSearchFilter(searchRaw) {
  if (!searchRaw) return null;
  const q = _escapeRegex(searchRaw);
  const rx = new RegExp(q, 'i');
  return {
    $or: [
      { advertiserName: rx },
      { companyName: rx },
      { name: rx },
      { email: rx },
      { phone: rx },
      { message: rx },
      { placement: rx },
      { budget: rx },
    ],
  };
}

function _buildListFilter(status, searchRaw) {
  const filters = [];

  if (status !== 'all') {
    filters.push({ status });
  }

  const searchFilter = _buildSearchFilter(searchRaw);
  if (searchFilter) filters.push(searchFilter);

  if (filters.length === 0) return {};
  if (filters.length === 1) return filters[0];
  return { $and: filters };
}

function _toLoggableInquirySample(doc) {
  if (!doc || typeof doc !== 'object') return null;
  return {
    _id: doc._id ? String(doc._id) : null,
    advertiserName: doc.advertiserName || doc.name || null,
    email: doc.email || null,
    status: doc.status || null,
    isRead: typeof doc.isRead === 'boolean' ? doc.isRead : undefined,
    createdAt: doc.createdAt || null,
  };
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _isValidEmail(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function _splitEmailList(v) {
  const s = String(v || '').trim();
  if (!s) return [];
  return s
    .split(/[,;\s]+/g)
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean)
    .filter((x) => _isValidEmail(x));
}

function _getInternalAdsEmails() {
  // These are *internal* addresses used for notifications/SMTP.
  // They should never be persisted as the advertiser's email.
  const internal = new Set();

  for (const e of _splitEmailList(process.env.ADS_INQUIRY_TO)) internal.add(e);
  for (const e of _splitEmailList(process.env.ADS_INQUIRY_FROM)) internal.add(e);
  for (const e of _splitEmailList(process.env.ADS_SMTP_USER)) internal.add(e);
  for (const e of _splitEmailList(process.env.SMTP_USER)) internal.add(e);

  return internal;
}

function _getReqIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '');
  const forwardedIp = forwarded.split(',')[0].trim();
  return forwardedIp || req?.ip || req?.socket?.remoteAddress || null;
}

function _sanitizePublicText(value, { maxLength = 500, allowNewlines = false } = {}) {
  if (value === undefined || value === null) return '';
  let text = String(value)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  text = sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} });
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = allowNewlines
    ? text.split('\n').map((line) => line.replace(/[\t ]+/g, ' ').trim()).join('\n')
    : text.replace(/\s+/g, ' ').trim();
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, maxLength).trim();
}

function _isPublicAdInquiryRateLimited(req) {
  const now = Date.now();
  const key = String(_getReqIp(req) || 'unknown');
  const bucket = publicAdInquiryRateBuckets.get(key);

  if (!bucket || now - bucket.windowStart > PUBLIC_AD_INQUIRY_RATE_LIMIT_WINDOW_MS) {
    publicAdInquiryRateBuckets.set(key, { windowStart: now, count: 1 });
    return false;
  }

  bucket.count += 1;
  return bucket.count > PUBLIC_AD_INQUIRY_RATE_LIMIT_MAX;
}

function _looksLikeSpamInquiry({ advertiserName, email, message }) {
  const name = String(advertiserName || '').trim();
  const msg = String(message || '').trim();
  const alphaNumeric = `${name} ${msg}`.replace(/[^a-z0-9]/gi, '');
  if (alphaNumeric.length < 6) return true;
  if (/^(.)\1{5,}$/i.test(alphaNumeric)) return true;

  const linkCount = (msg.match(/https?:\/\//gi) || []).length;
  if (linkCount > 3) return true;

  const emailLocal = String(email || '').split('@')[0].toLowerCase();
  if (emailLocal && name.toLowerCase() === emailLocal && msg.toLowerCase() === emailLocal) return true;

  return false;
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
  const referrer = meta.referrer ?? meta.referer ?? null;

  return {
    id: String(doc._id),
    advertiserName: doc.advertiserName || doc.name || null,
    companyName: doc.companyName ?? null,
    // Backward-compat: older callers used `name`
    name: doc.name || doc.advertiserName || null,
    email: doc.email,
    phone: doc.phone ?? null,
    message: doc.message,
    budget: doc.budget ?? null,
    placement: doc.placement ?? null,
    status: doc.status,
    isRead: typeof doc.isRead === 'boolean' ? doc.isRead : (doc.status === 'read'),
    ..._toReplyMetadata(doc),
    readAt: doc.readAt || null,
    deletedAt: doc.deletedAt || null,
    meta: {
      ip: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
      // Provide both keys to avoid breaking existing callers.
      referrer,
      referer: meta.referer ?? referrer,
      site: meta.site ?? null,
    },
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function _toReplyMetadata(doc, options = {}) {
  const includeReplyHistory = !!options.includeReplyHistory;
  const rawHistory = Array.isArray(doc?.replyHistory) ? doc.replyHistory : [];
  const replyCount = Number.isFinite(doc?.replyCount) ? doc.replyCount : rawHistory.length;
  const hasReply = typeof doc?.hasReply === 'boolean'
    ? doc.hasReply
    : !!(replyCount > 0 || doc?.lastRepliedAt || doc?.lastReplySubject);

  const metadata = {
    hasReply,
    replyCount,
    lastRepliedAt: doc?.lastRepliedAt || null,
    lastRepliedBy: doc?.lastRepliedBy ?? null,
    lastReplySubject: doc?.lastReplySubject ?? null,
  };

  if (includeReplyHistory) {
    metadata.replyHistory = rawHistory.map((entry) => ({
      subject: entry?.subject ?? null,
      repliedAt: entry?.repliedAt || null,
      repliedBy: entry?.repliedBy ?? null,
    }));
  }

  return metadata;
}

function _toInquiryItemV2(doc, options = {}) {
  if (!doc) return null;

  return {
    _id: String(doc._id),
    advertiserName: doc.advertiserName || doc.name || null,
    companyName: doc.companyName ?? null,
    email: doc.email ?? null,
    phone: doc.phone ?? null,
    message: doc.message ?? null,
    status: doc.status,
    isRead: typeof doc.isRead === 'boolean' ? doc.isRead : (doc.status === 'read'),
    ..._toReplyMetadata(doc, options),
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

function _inferRestoreStatus(doc) {
  // Business rule:
  // - If we stored a previousStatus, restore that (unless it was deleted).
  // - Otherwise, if it was read, restore to read; else new.
  const prev = doc && doc.previousStatus ? String(doc.previousStatus).toLowerCase() : '';
  if (prev && prev !== 'deleted' && STATUS_VALUES.includes(prev)) return prev;
  const isRead = typeof doc?.isRead === 'boolean' ? doc.isRead : (doc?.status === 'read');
  if (isRead || doc?.readAt) return 'read';
  return 'new';
}

function _escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _parseBulkIds(body) {
  const payload = body && typeof body === 'object' ? body : {};
  const idsRaw = payload.ids;
  if (!Array.isArray(idsRaw) || idsRaw.length === 0) {
    return { ok: false, message: 'ids must be a non-empty array', ids: [] };
  }

  const unique = new Set();
  for (const v of idsRaw) {
    const id = String(v || '').trim();
    if (!id) continue;
    if (!mongoose.isValidObjectId(id)) continue;
    unique.add(id);
  }

  return { ok: true, ids: Array.from(unique) };
}

function _buildAdsPermanentDeleteAuditDoc(req, inquiry, deletedAt) {
  if (!inquiry || !inquiry._id) return null;

  const actor = req?.admin && typeof req.admin === 'object'
    ? req.admin
    : (req?.user && typeof req.user === 'object' ? req.user : {});

  const actorId = actor?.id ? String(actor.id) : null;
  const actorEmail = actor?.email ? String(actor.email) : null;
  const actorRole = actor?.role ? String(actor.role) : null;
  const inquiryId = String(inquiry._id);
  const advertiserName = inquiry?.advertiserName || inquiry?.name || null;
  const advertiserEmail = inquiry?.email ? String(inquiry.email) : null;
  const deletedAtIso = deletedAt instanceof Date ? deletedAt.toISOString() : new Date().toISOString();

  return {
    action: 'permanent_delete',
    key: `ads_inquiry:${inquiryId}`,
    before: {
      inquiryId,
      advertiserName,
      advertiserEmail,
      status: inquiry?.status || null,
    },
    after: null,
    actor: {
      id: actorId,
      email: actorEmail,
      role: actorRole,
    },
    ip: _getReqIp(req),
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 500) || null,
    meta: {
      entity: 'ads_inquiry',
      inquiryId,
      advertiserName,
      advertiserEmail,
      deletedBy: actorEmail || actorId,
      deletedAt: deletedAtIso,
      action: 'permanent_delete',
    },
  };
}

async function _createAdsPermanentDeleteAuditLogs(req, inquiries, deletedAt) {
  const docs = (Array.isArray(inquiries) ? inquiries : [inquiries])
    .map((inquiry) => _buildAdsPermanentDeleteAuditDoc(req, inquiry, deletedAt))
    .filter(Boolean);

  if (docs.length === 0) return;

  try {
    if (docs.length === 1) {
      await AuditLog.create(docs[0]);
      return;
    }

    await AuditLog.insertMany(docs, { ordered: false });
  } catch (e) {
    console.warn('[ads][audit] permanent delete log failed', { message: e?.message || String(e), count: docs.length });
  }
}

async function submitPublicAdInquiry(req, res) {
  try {
    res.set('Cache-Control', 'no-store');

    if (_isPublicAdInquiryRateLimited(req)) {
      return res.status(429).json({ ok: false, success: false, message: 'Too many requests' });
    }

    if (!isDbReady()) {
      return res.status(503).json({ ok: false, success: false, message: 'Database unavailable' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (_sanitizePublicText(body.website || body.url || body.homepage, { maxLength: 200 })) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid inquiry' });
    }

    // Accept both new and legacy field names
    const advertiserName = _sanitizePublicText(body.advertiserName || body.advertiser_name || body.contactName || body.contact_name || body.name, { maxLength: 120 });
    const companyName = _sanitizePublicText(body.companyName || body.company_name || body.company, { maxLength: 160 });
    const emailPrimary = _sanitizePublicText(body.email, { maxLength: 254 }).toLowerCase();
    const emailAlternate = _sanitizePublicText(
      body.advertiserEmail ||
      body.advertiser_email ||
      body.contactEmail ||
      body.contact_email ||
      '',
      { maxLength: 254 }
    ).toLowerCase();

    const internalEmails = _getInternalAdsEmails();
    const primaryLooksInternal = emailPrimary && internalEmails.has(emailPrimary.toLowerCase());
    const alternateOk = emailAlternate && _isValidEmail(emailAlternate) && !internalEmails.has(emailAlternate.toLowerCase());

    // Prefer the primary email unless it matches a known internal inbox and a valid alternate is provided.
    const email = (primaryLooksInternal && alternateOk) ? emailAlternate : emailPrimary;
    const phone = _sanitizePublicText(body.phone, { maxLength: 60 });
    const message = _sanitizePublicText(body.message, { maxLength: 5000, allowNewlines: true });
    const budget = _sanitizePublicText(body.budget, { maxLength: 120 });
    const rawPlacement = _sanitizePublicText(body.placement || body.slot || body.adSlot || body.ad_slot, { maxLength: 120 });
    const placement = normalizeAdOpportunityKey(rawPlacement) || rawPlacement;
    const target = _sanitizePublicText(body.target, { maxLength: 240 });
    const startDate = _sanitizePublicText(body.startDate || body.start_date, { maxLength: 80 });
    const pageUrl = _sanitizePublicText(body.pageUrl || body.page_url, { maxLength: 500 });
    const source = _sanitizePublicText(body.source, { maxLength: 120 });

    if (!_isNonEmptyString(advertiserName)) {
      return res.status(400).json({ ok: false, success: false, message: 'Missing required field: name' });
    }
    if (!_isNonEmptyString(email)) {
      return res.status(400).json({ ok: false, success: false, message: 'Missing required field: email' });
    }
    if (!_isValidEmail(email)) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid email' });
    }
    if (!_isNonEmptyString(message)) {
      return res.status(400).json({ ok: false, success: false, message: 'Missing required field: message' });
    }
    if (_looksLikeSpamInquiry({ advertiserName, email, message })) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid inquiry' });
    }

    const ip = req.ip ? String(req.ip) : null;
    const userAgent = req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : null;
    const referrer = (req.headers && (req.headers['referrer'] || req.headers['referer']))
      ? String(req.headers['referrer'] || req.headers['referer'])
      : null;
    const site = (req.headers && req.headers.origin) ? String(req.headers.origin) : null;

    const inquiry = await AdInquiry.create({
      advertiserName,
      companyName: companyName || null,
      email,
      phone: phone || null,
      message,
      budget: budget || null,
      placement: placement || null,
      target: target || null,
      startDate: startDate || null,
      pageUrl: pageUrl || null,
      source: source || null,
      // keep legacy field populated for older clients/exports
      name: advertiserName,
      status: 'new',
      isRead: false,
      readAt: null,
      deletedAt: null,
      meta: {
        ip,
        userAgent,
        referrer,
        referer: referrer,
        site: site || source || null,
      },
    });

    const id = inquiry && inquiry._id ? String(inquiry._id) : null;
    console.log(`[ads] inquiry saved id=${id}`);

    let emailSent = false;
    try {
      await adsMailer.sendAdsInquiryMail({
        name: advertiserName,
        advertiserName,
        companyName: companyName || undefined,
        email,
        phone: phone || undefined,
        message,
        budget: budget || undefined,
        placement: placement || undefined,
        target: target || undefined,
        startDate: startDate || undefined,
        pageUrl: pageUrl || undefined,
        source: source || undefined,
        createdAt: inquiry?.createdAt || new Date(),
        inquiryId: id,
        meta: {
          ip,
          userAgent,
          referrer,
          referer: referrer,
          site: site || source || null,
        },
      });
      emailSent = true;
      console.log(`[ads] email sent id=${id}`);
    } catch (e) {
      console.warn(`[ads] email failed id=${id} error=${e?.message || String(e)}`);
    }

    // Keep response minimal/stable for the public website.
    return res.status(201).json({ ok: true, success: true, id, ...(emailSent ? {} : { warning: 'email_failed' }) });
  } catch (e) {
    console.error('[ads] submitPublicAdInquiry failed', { message: e?.message || String(e) });
    return res.status(500).json({ ok: false, success: false, message: 'Failed to submit inquiry' });
  }
}

// Admin Panel (production) expects these exact endpoints under /api/ads/*
// and expects stable JSON shapes.
async function listAdminAdInquiriesV2(req, res) {
  try {
    if (!_ensureDbReady(req, res, 'list:precheck')) return;

    const page = Math.max(_parseInt(req.query.page, 1), 1);
    const limit = _clampInt(_parseInt(req.query.limit, 20), 1, 100);
    const skip = (page - 1) * limit;
    const searchRaw = String(req.query.search || '').trim();

    const statusRaw = String(req.query.status || '').trim().toLowerCase();
    const status = statusRaw && (statusRaw === 'all' || STATUS_VALUES.includes(statusRaw)) ? statusRaw : 'new';

    _logAdsDebug('list:request', {
      url: req.originalUrl,
      status,
      page,
      limit,
      search: searchRaw,
    });

    const filter = _buildListFilter(status, searchRaw);

    _logAdsDebug('list:query', {
      url: req.originalUrl,
      requestedStatus: status,
      mongoFilter: filter,
      skip,
      limit,
      sort: { createdAt: -1 },
    });

    const [items, total] = await Promise.all([
      AdInquiry.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      AdInquiry.countDocuments(filter),
    ]);

    const totalPages = Math.max(Math.ceil((typeof total === 'number' ? total : 0) / limit), 1);

    _logAdsDebug('list:result', {
      url: req.originalUrl,
      status,
      resultCount: Array.isArray(items) ? items.length : 0,
      total: typeof total === 'number' ? total : 0,
      firstItemSample: Array.isArray(items) && items.length > 0 ? _toLoggableInquirySample(items[0]) : null,
    });

    return res.status(200).json({
      success: true,
      items: (items || []).map(_toInquiryItemV2),
      total: typeof total === 'number' ? total : 0,
      page,
      pages: totalPages,
    });
  } catch (e) {
    console.error('[ads] listAdminAdInquiriesV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function getAdminAdInquiryByIdV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const doc = await AdInquiry.findById(id).lean();
    if (!doc) return res.status(404).json({ success: false, message: 'Not found' });

    return res.status(200).json({ success: true, item: _toInquiryItemV2(doc, { includeReplyHistory: true }) });
  } catch (e) {
    console.error('[ads] getAdminAdInquiryByIdV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function getAdminUnreadCountV2(req, res) {
  try {
    if (!_ensureDbReady(req, res, 'unread-count:precheck')) return;

    _logAdsDebug('unread-count:request', {
      url: req.originalUrl,
    });

    const filter = _buildUnreadFilter();

    const count = await AdInquiry.countDocuments(filter);

    _logAdsDebug('unread-count:result', {
      url: req.originalUrl,
      unreadCount: typeof count === 'number' ? count : 0,
    });

    return res.status(200).json({ success: true, unreadCount: typeof count === 'number' ? count : 0 });
  } catch (e) {
    console.error('[ads] getAdminUnreadCountV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function getAdminAdInquiryDiagnostics(req, res) {
  try {
    const env = String(process.env.NODE_ENV || '').toLowerCase();
    if (env === 'production') {
      return res.status(404).json({ success: false, message: 'Not found' });
    }

    if (!_ensureDbReady(req, res, 'diagnostics:precheck')) return;

    const unreadFilter = _buildUnreadFilter();
    const [
      total,
      unreadCount,
      byStatus,
      byStatusRead,
    ] = await Promise.all([
      AdInquiry.countDocuments({}),
      AdInquiry.countDocuments(unreadFilter),
      AdInquiry.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      AdInquiry.aggregate([
        { $group: { _id: { status: '$status', isRead: '$isRead' }, count: { $sum: 1 } } },
        { $sort: { '_id.status': 1, '_id.isRead': 1 } },
      ]),
    ]);

    const db = _getAdsDbState();
    const countsByStatus = {
      new: 0,
      read: 0,
      deleted: 0,
    };
    for (const row of byStatus || []) {
      const key = String(row?._id || '');
      if (!Object.prototype.hasOwnProperty.call(countsByStatus, key)) continue;
      countsByStatus[key] = typeof row?.count === 'number' ? row.count : 0;
    }

    _logAdsDebug('diagnostics:result', {
      url: req.originalUrl,
      total: typeof total === 'number' ? total : 0,
      unreadCount: typeof unreadCount === 'number' ? unreadCount : 0,
      countsByStatus,
    });

    return res.status(200).json({
      success: true,
      db: {
        name: db.dbName,
        collection: AdInquiry.collection?.name ? String(AdInquiry.collection.name) : null,
        readyState: db.readyState,
      },
      totals: {
        inquiries: typeof total === 'number' ? total : 0,
        unread: typeof unreadCount === 'number' ? unreadCount : 0,
      },
      countsByStatus,
      countsByStatusAndRead: byStatusRead || [],
    });
  } catch (e) {
    console.error('[ads] getAdminAdInquiryDiagnostics failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function replyToAdInquiryV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const subject = String(body.subject || '').trim();
    const message = String(body.message || '').trim();

    if (!_isNonEmptyString(subject)) {
      return res.status(400).json({ success: false, message: 'Missing required field: subject' });
    }
    if (!_isNonEmptyString(message)) {
      return res.status(400).json({ success: false, message: 'Missing required field: message' });
    }

    const admin = req.admin && typeof req.admin === 'object' ? req.admin : {};
    const adminEmail = admin.email ? String(admin.email) : '';

    console.log('[ads][reply] requested', {
      inquiryId: id,
      adminEmail: adminEmail || null,
      at: new Date().toISOString(),
    });

    const inquiry = await AdInquiry.findById(id).lean();
    if (!inquiry) return res.status(404).json({ success: false, message: 'Inquiry not found' });

    const toEmailRaw = String(inquiry.email || '').trim();
    if (!toEmailRaw) {
      return res.status(400).json({ success: false, message: 'Valid advertiser email not found' });
    }
    if (!_isValidEmail(toEmailRaw)) {
      return res.status(400).json({ success: false, message: 'Valid advertiser email not found' });
    }

    // Safety guard: do not send replies to internal inbox addresses.
    const internalEmails = _getInternalAdsEmails();
    if (internalEmails.has(toEmailRaw.toLowerCase())) {
      return res.status(400).json({ success: false, message: 'Valid advertiser email not found' });
    }

    console.log('[ads][reply] sending', {
      inquiryId: id,
      to: toEmailRaw,
      adminEmail: adminEmail || null,
      at: new Date().toISOString(),
    });

    await adsMailer.sendAdsReplyMail({
      to: toEmailRaw,
      subject,
      message,
      inquiryId: id,
      admin: { id: admin.id, email: adminEmail, role: admin.role },
    });

    const repliedAt = new Date();
    const repliedBy = adminEmail || (admin.id ? String(admin.id) : null);
    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      {
        $set: {
          hasReply: true,
          lastRepliedAt: repliedAt,
          lastRepliedBy: repliedBy,
          lastReplySubject: subject,
        },
        $inc: { replyCount: 1 },
        $push: {
          replyHistory: {
            subject,
            repliedAt,
            repliedBy,
          },
        },
      },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) {
      console.error('[ads][reply] tracking update failed', {
        inquiryId: id,
        adminEmail: adminEmail || null,
        at: repliedAt.toISOString(),
      });
      return res.status(500).json({ success: false, message: 'Reply sent but failed to persist reply metadata' });
    }

    console.log('[ads][reply] sent', {
      inquiryId: id,
      to: toEmailRaw,
      adminEmail: adminEmail || null,
      at: repliedAt.toISOString(),
      status: 'sent',
    });

    return res.status(200).json({
      success: true,
      message: 'Reply sent successfully',
      reply: _toReplyMetadata(updated, { includeReplyHistory: true }),
    });
  } catch (e) {
    const errMessage = e?.message || String(e);
    console.error('[ads][reply] failed', { message: errMessage });

    // Treat missing SMTP config as a service dependency issue (503), not a generic 500.
    if (/smtp\s+not\s+configured/i.test(errMessage)) {
      return res.status(503).json({
        success: false,
        code: 'ADS_SMTP_NOT_CONFIGURED',
        message: 'Ads SMTP not configured',
      });
    }

    return res.status(500).json({ success: false, message: 'Failed to send email' });
  }
}

async function trashAdminInquiry(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const existing = await AdInquiry.findById(id).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Not found' });

    const prevStatus = existing.status && existing.status !== 'deleted' ? String(existing.status) : null;

    await AdInquiry.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'deleted',
          deletedAt: new Date(),
          isRead: true,
          ...(prevStatus ? { previousStatus: prevStatus } : {}),
        },
      },
      { new: true, runValidators: true }
    ).lean();

    console.log(`[ads] inquiry moved to trash id=${id}`);
    return res.status(200).json({ success: true, message: 'Inquiry moved to trash' });
  } catch (e) {
    console.error('[ads] trashAdminInquiry failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function restoreAdminInquiryV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const existing = await AdInquiry.findById(id).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Not found' });

    const restoreStatus = _inferRestoreStatus(existing);
    const isRead = restoreStatus === 'read';

    await AdInquiry.findByIdAndUpdate(
      id,
      {
        $set: {
          status: restoreStatus,
          deletedAt: null,
          isRead,
          ...(isRead ? { readAt: existing.readAt || new Date() } : {}),
        },
        $unset: { previousStatus: 1 },
      },
      { new: true, runValidators: true }
    ).lean();

    console.log(`[ads] inquiry restored id=${id} status=${restoreStatus}`);
    return res.status(200).json({ success: true, message: 'Inquiry restored' });
  } catch (e) {
    console.error('[ads] restoreAdminInquiryV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function permanentDeleteAdminInquiryV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const deleted = await AdInquiry.findByIdAndDelete(id).lean();
    if (!deleted) return res.status(404).json({ success: false, message: 'Not found' });

  const deletedAt = new Date();
  await _createAdsPermanentDeleteAuditLogs(req, deleted, deletedAt);

    console.log(`[ads] inquiry permanently deleted id=${id}`);
    return res.status(200).json({ success: true, message: 'Inquiry deleted permanently', deletedCount: 1 });
  } catch (e) {
    console.error('[ads] permanentDeleteAdminInquiryV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function bulkMarkReadV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const parsed = _parseBulkIds(req.body);
    if (!parsed.ok) return res.status(400).json({ success: false, processed: 0, message: parsed.message });

    // If all provided IDs were invalid, treat as a no-op.
    if (parsed.ids.length === 0) return res.status(200).json({ success: true, processed: 0, message: 'Bulk mark read complete' });

    const now = new Date();
    const result = await AdInquiry.updateMany(
      { _id: { $in: parsed.ids } },
      { $set: { status: 'read', isRead: true, readAt: now } },
      { runValidators: true }
    );

    const processed = typeof result?.modifiedCount === 'number'
      ? result.modifiedCount
      : (typeof result?.nModified === 'number' ? result.nModified : 0);

    console.log(`[ads] bulk read processed=${processed} requested=${parsed.ids.length}`);
    return res.status(200).json({ success: true, processed, message: 'Bulk mark read complete' });
  } catch (e) {
    console.error('[ads] bulkMarkReadV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, processed: 0, message: e?.message || String(e) });
  }
}

async function bulkTrashV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const parsed = _parseBulkIds(req.body);
    if (!parsed.ok) return res.status(400).json({ success: false, processed: 0, message: parsed.message });
    if (parsed.ids.length === 0) return res.status(200).json({ success: true, processed: 0, message: 'Bulk trash complete' });

    const docs = await AdInquiry.find({ _id: { $in: parsed.ids } }).lean();
    const now = new Date();

    const ops = [];
    for (const doc of docs || []) {
      if (!doc?._id) continue;
      if (String(doc.status || '').toLowerCase() === 'deleted') continue;

      const prevStatus = doc.previousStatus || (doc.status && doc.status !== 'deleted' ? String(doc.status) : null);
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              status: 'deleted',
              deletedAt: now,
              isRead: true,
              ...(prevStatus ? { previousStatus: prevStatus } : {}),
            },
          },
        },
      });
    }

    if (ops.length === 0) return res.status(200).json({ success: true, processed: 0, message: 'Bulk trash complete' });

    await AdInquiry.bulkWrite(ops, { ordered: false });
    console.log(`[ads] bulk trash processed=${ops.length} requested=${parsed.ids.length}`);
    return res.status(200).json({ success: true, processed: ops.length, message: 'Bulk trash complete' });
  } catch (e) {
    console.error('[ads] bulkTrashV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, processed: 0, message: e?.message || String(e) });
  }
}

async function bulkRestoreV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const parsed = _parseBulkIds(req.body);
    if (!parsed.ok) return res.status(400).json({ success: false, processed: 0, message: parsed.message });
    if (parsed.ids.length === 0) return res.status(200).json({ success: true, processed: 0, message: 'Bulk restore complete' });

    const docs = await AdInquiry.find({ _id: { $in: parsed.ids } }).lean();
    const now = new Date();

    const ops = [];
    for (const doc of docs || []) {
      if (!doc?._id) continue;
      if (String(doc.status || '').toLowerCase() !== 'deleted') continue;

      const restoreStatus = _inferRestoreStatus(doc);
      const isRead = restoreStatus === 'read';

      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: {
              status: restoreStatus,
              deletedAt: null,
              isRead,
              ...(isRead ? { readAt: doc.readAt || now } : {}),
            },
            $unset: { previousStatus: 1 },
          },
        },
      });
    }

    if (ops.length === 0) return res.status(200).json({ success: true, processed: 0, message: 'Bulk restore complete' });

    await AdInquiry.bulkWrite(ops, { ordered: false });
    console.log(`[ads] bulk restore processed=${ops.length} requested=${parsed.ids.length}`);
    return res.status(200).json({ success: true, processed: ops.length, message: 'Bulk restore complete' });
  } catch (e) {
    console.error('[ads] bulkRestoreV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, processed: 0, message: e?.message || String(e) });
  }
}

async function bulkPermanentDeleteV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const parsed = _parseBulkIds(req.body);
    if (!parsed.ok) return res.status(400).json({ success: false, processed: 0, message: parsed.message });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const idsReceived = Array.isArray(body.ids) ? body.ids : [];

    const dbMeta = {
      readyState: mongoose?.connection?.readyState,
      db: mongoose?.connection?.name ? String(mongoose.connection.name) : null,
      host: mongoose?.connection?.host ? String(mongoose.connection.host) : null,
      port: mongoose?.connection?.port ? Number(mongoose.connection.port) : null,
      collection: AdInquiry?.collection?.name ? String(AdInquiry.collection.name) : null,
      model: AdInquiry?.modelName ? String(AdInquiry.modelName) : 'AdInquiry',
    };

    // If caller sent ids but none were valid ObjectIds, treat as a request error.
    if (idsReceived.length > 0 && parsed.ids.length === 0) {
      console.warn('[ads] bulkPermanentDeleteV2 no valid ids after validation', {
        idsReceived,
        idsParsed: parsed.ids,
        db: dbMeta,
      });
      return res.status(400).json({ success: false, processed: 0, deletedCount: 0, message: 'No valid ids provided' });
    }

    if (parsed.ids.length === 0) {
      console.warn('[ads] bulkPermanentDeleteV2 called with empty ids', { idsReceived, db: dbMeta });
      return res.status(400).json({ success: false, processed: 0, deletedCount: 0, message: 'ids must be a non-empty array' });
    }

    // Safety: only permanently delete inquiries that are already soft-deleted.
    const filter = { _id: { $in: parsed.ids }, status: 'deleted' };

    console.log('[ads] bulkPermanentDeleteV2 request', {
      idsReceived,
      idsParsed: parsed.ids,
      requestedCount: idsReceived.length,
      parsedCount: parsed.ids.length,
      db: dbMeta,
    });

    const matchedDocs = await AdInquiry.find(filter).lean();
    const matchedCount = Array.isArray(matchedDocs) ? matchedDocs.length : 0;
    const result = await AdInquiry.deleteMany(filter);
    const deletedCount = typeof result?.deletedCount === 'number' ? result.deletedCount : 0;

    console.log('[ads] bulkPermanentDeleteV2 result', {
      matchedCount: typeof matchedCount === 'number' ? matchedCount : 0,
      deletedCount,
      requestedCount: idsReceived.length,
      parsedCount: parsed.ids.length,
      db: dbMeta,
    });

    if (!deletedCount) {
      const message = matchedCount
        ? 'Matched inquiries but failed to delete'
        : 'No deleted inquiries matched the provided ids';
      return res.status(matchedCount ? 500 : 200).json({
        success: matchedCount ? false : true,
        processed: 0,
        deletedCount: 0,
        message,
      });
    }

    const deletedAt = new Date();
    await _createAdsPermanentDeleteAuditLogs(req, matchedDocs.slice(0, deletedCount), deletedAt);

    return res.status(200).json({ success: true, message: 'Inquiries deleted permanently', deletedCount, processed: deletedCount });
  } catch (e) {
    console.error('[ads] bulkPermanentDeleteV2 failed', { message: e?.message || String(e) });
    return res.status(500).json({ success: false, processed: 0, deletedCount: 0, message: e?.message || String(e) });
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
      { $set: { status: 'read', isRead: true, readAt: new Date() } },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ success: false, message: 'Not found' });

    console.log(`[ads] inquiry marked read id=${id}`);
    // Legacy response shape for existing admin panel endpoints/tests
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
}

async function markAdminInquiryReadV2(req, res) {
  try {
    if (!isDbReady()) return res.status(503).json({ success: false, message: 'Database unavailable' });

    const id = String(req.params.id || '').trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: 'Invalid id' });
    }

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      { $set: { status: 'read', isRead: true, readAt: new Date() } },
      { new: true, runValidators: true }
    ).lean();

    if (!updated) return res.status(404).json({ success: false, message: 'Not found' });

    console.log(`[ads] inquiry marked read id=${id}`);
    return res.status(200).json({ success: true, message: 'Inquiry marked read' });
  } catch (e) {
    console.error('[ads] markAdminInquiryReadV2 failed', { message: e?.message || String(e) });
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
      { $set: { status: 'deleted', isRead: true, deletedAt: new Date() } },
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

    const existing = await AdInquiry.findById(id).lean();
    if (!existing) return res.status(404).json({ success: false, message: 'Not found' });

    const restoreStatus = _inferRestoreStatus(existing);
    const isRead = restoreStatus === 'read';

    const updated = await AdInquiry.findByIdAndUpdate(
      id,
      {
        $set: {
          status: restoreStatus,
          deletedAt: null,
          isRead,
          ...(isRead ? { readAt: existing.readAt || new Date() } : {}),
        },
        $unset: { previousStatus: 1 },
      },
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
  listAdminAdInquiriesV2,
  getAdminAdInquiryByIdV2,
  getAdminUnreadCountV2,
  getAdminAdInquiryDiagnostics,
  trashAdminInquiry,
  restoreAdminInquiryV2,
  permanentDeleteAdminInquiryV2,
  replyToAdInquiryV2,
  bulkMarkReadV2,
  bulkTrashV2,
  bulkRestoreV2,
  bulkPermanentDeleteV2,
  markAdminInquiryRead,
  markAdminInquiryReadV2,
  patchAdminInquiryStatusById,
  deleteAdminInquiry,
  restoreAdminInquiry,
  hardDeleteAdminInquiry,
  STATUS_VALUES,
};
