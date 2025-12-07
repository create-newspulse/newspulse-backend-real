const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Base dir for nested app code
const BASE = './newspulse-backend-real-main';

// Nested routes and modules
const newsRoutes = require(`${BASE}/routes/news`);
const adminRoutes = require(`${BASE}/routes/admin`);
const adminAuthRoutes = require(`${BASE}/routes/adminAuth`);
const aiTrainingInfoRoutes = require(`${BASE}/routes/system/aiTrainingInfo`);
const systemHealthRoutes = require(`${BASE}/routes/system/health`);
const communityRoutes = require(`${BASE}/routes/community`);
const adminCommunityRoutes = require(`${BASE}/routes/adminCommunity`);
const communityAdminContactsRoutes = require(`${BASE}/routes/communityAdminContacts`);
const communityReporterRoutes = require(`${BASE}/routes/communityReporterRoutes`);
const adminSettingsRoutes = require(`${BASE}/routes/adminSettings`);
const communityReporterSettingsRouter = require(`${BASE}/routes/adminSettings/communityReporterSettings`);
const CommunitySubmission = require(`${BASE}/models/CommunitySubmission`);
const { requireAdminAuth } = require('./middleware/adminAuth');
let aiRoutes = null;
let feedRoutes = null;
try { aiRoutes = require(`${BASE}/routes/ai`); } catch (_) { console.warn('[init] optional routes/ai not found; skipping'); }
try { feedRoutes = require(`${BASE}/routes/feed`); } catch (_) { console.warn('[init] optional routes/feed not found; skipping'); }

dotenv.config();

const app = express();

// CORS
const allowedOrigins = [
  'http://localhost:5173',
  'https://admin.newspulse.co.in',
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.options('*', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.options('/system/ai-training-info', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.options('/api/admin/community/*', cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// Lightweight system endpoints
app.get('/system/health', (req, res) => {
  res.json({ ok: true, status: 'online', env: process.env.NODE_ENV || 'development', uptime: process.uptime() });
});
app.get('/system/ai-training-info', (req, res) => {
  res.json({ success: true, status: 'online', lastUpdated: process.env.AI_TRAINING_LAST_UPDATED || new Date().toISOString() });
});

// Mongo
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI || MONGO_URI === 'YOUR_MONGO_URI_HERE') {
  console.warn('⚠️ MONGO_URI is not set correctly; starting server without DB connection for now.');
} else {
  mongoose
    .connect(MONGO_URI)
    .then(() => console.log('✅ MongoDB connected'))
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err.message);
    });
}

// Home
app.get('/', (req, res) => { res.send('🟢 News Pulse Admin Backend is Live'); });

// API Routes
app.use('/api/news', newsRoutes);
app.use('/api/community', communityRoutes);
app.use('/api/community-reporter', communityReporterRoutes);
app.use('/admin', adminRoutes);
app.use('/admin-auth', adminAuthRoutes);
app.use('/system/ai-training-info', aiTrainingInfoRoutes);
app.use('/api/system/ai-training-info', aiTrainingInfoRoutes);
app.use('/api/system/health', systemHealthRoutes);
app.use('/system/health', systemHealthRoutes);
app.use('/api/admin/community', adminCommunityRoutes);
// Admin Settings (includes /api/admin/settings/community-reporter)
app.use('/api/admin', adminSettingsRoutes);
app.use('/admin-api/admin', adminSettingsRoutes);
// Community Reporter Settings router (same mount /api/admin)
app.use('/api/admin', communityReporterSettingsRouter);
if (aiRoutes) app.use('/api/ai', aiRoutes);
if (feedRoutes) app.use('/api/feed', feedRoutes);
app.use('/api/admin/community', communityAdminContactsRoutes);
app.use('/admin-api/admin/community', communityAdminContactsRoutes);
app.use('/admin/community', communityAdminContactsRoutes);

// Aliases and fallbacks
app.get('/admin/community/journalist-applications', requireAdminAuth, (req, res, next) => {
  try { req.url = '/journalist-applications'; return communityAdminContactsRoutes(req, res, next); } catch (e) {
    console.error('[nested][ALIAS][journalist-applications] delegate failed', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load journalist applications' });
  }
});
app.get('/admin/community/reporter-contacts', requireAdminAuth, async (req, res, next) => {
  if (res.headersSent) return next();
  if (communityAdminContactsRoutes) return next();
  return res.json({ ok: true, items: [], total: 0 });
});
app.get('/admin/community/reporter-stories', requireAdminAuth, async (req, res) => {
  try {
    const reporterKeyRaw = (req.query.reporterKey || '').toString().trim();
    if (!reporterKeyRaw) return res.status(400).json({ ok: false, message: 'Missing reporterKey' });
    const reporterKey = reporterKeyRaw.toLowerCase();
    const pageNum = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit || '20', 10), 1), 100);
    const skip = (pageNum - 1) * limitNum;
    const status = (req.query.status || '').toString().trim();

    const baseFilter = {
      $or: [
        { reporterEmail: reporterKey },
        { 'contact.email': reporterKey },
        { email: reporterKey },
      ],
    };
    if (status && status !== 'all') {
      baseFilter.$and = (baseFilter.$and || []).concat([{ status }]);
    }

    const [docs, total] = await Promise.all([
      CommunitySubmission.find(baseFilter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      CommunitySubmission.countDocuments(baseFilter),
    ]);
    const items = docs.map(d => ({
      id: d._id.toString(),
      title: d.headline || '',
      summary: null,
      status: d.status || 'draft',
      language: d.language || 'en',
      category: d.category || null,
      city: (d.location?.city || d.city || d.locationDetail?.city || null),
      createdAt: d.createdAt ? d.createdAt.toISOString() : null,
      updatedAt: d.updatedAt ? d.updatedAt.toISOString() : null,
      aiRisk: typeof d.riskScore === 'number' ? String(d.riskScore) : null,
      priority: d.priority || null,
    }));
    return res.json({ ok: true, items, total, page: pageNum, limit: limitNum });
  } catch (e) {
    console.error('[ADMIN][reporter-stories] error', e?.message || e);
    return res.status(500).json({ ok: false, message: 'Failed to load reporter stories' });
  }
});

app.get('/api/admin/me', requireAdminAuth, (req, res) => {
  const a = req.admin || {};
  return res.json({ success: true, admin: { id: a.id || 'unknown', email: a.email || '', role: a.role || 'admin' } });
});

// Public config
let _communityReporterFlagCache = { myCommunityStoriesEnabled: false };
app.get('/api/community-reporter/config', (req, res) => {
  return res.json({ ok: true, communityMyStoriesEnabled: _communityReporterFlagCache.myCommunityStoriesEnabled });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, success: false, status: 404, message: 'Route not found', path: req.originalUrl });
});

// 500
app.use((err, req, res, next) => {
  try { console.error('Error:', err && err.message ? err.message : err, 'path=', req.originalUrl); } catch (_) {}
  res.status(500).json({ ok: false, success: false, status: 500, message: 'Internal server error' });
});

// Start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  try {
    const reporterRoutes = [];
    app._router && app._router.stack && app._router.stack.forEach(layer => {
      if (layer.route && layer.route.path && layer.route.path.includes('reporter')) {
        reporterRoutes.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
        layer.handle.stack.forEach(rLayer => {
          if (rLayer.route && rLayer.route.path && rLayer.route.path.includes('reporter')) {
            reporterRoutes.push(prefix + rLayer.route.path);
          }
        });
      }
    });
    console.log('[startup][reporter-routes]', reporterRoutes);
  } catch (e) {
    console.warn('[startup][reporter-routes] failed', e?.message || e);
  }
});

function extractPrefix(regexp) {
  try {
    const src = (regexp && regexp.source) || '';
    const m = src.match(/\\\/(admin[^\\^]+|api[^\\^]+|system[^\\^]+)/i);
    if (m && m[1]) return '/' + m[1];
  } catch (_) {}
  return '';
}

// Debug routes list
app.get('/_debug/routes', (req, res) => {
  const list = [];
  try {
    app._router && app._router.stack && app._router.stack.forEach(layer => {
      if (layer.route && layer.route.path) {
        list.push(layer.route.path);
      } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
        const prefix = layer.regexp && layer.regexp.fast_slash ? '' : extractPrefix(layer.regexp);
        layer.handle.stack.forEach(rLayer => { if (rLayer.route && rLayer.route.path) list.push(prefix + rLayer.route.path); });
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Introspection failed', error: e?.message || e });
  }
  return res.json({ ok: true, total: list.length, reporter: list.filter(r => r.includes('reporter')), all: list });
});

module.exports = app;
