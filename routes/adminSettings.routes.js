const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');

const { requireAdminAuth } = require('../middleware/adminAuth');
const SystemSetting = require('../models/SystemSetting');

const router = express.Router();

const AnyObjectSchema = z.record(z.any());

const ADMIN_SETTINGS_KEY = 'settings_center_admin';
const PUBLIC_SETTINGS_KEY = 'settings_center_public';

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function defaultAdminSettings() {
  return {
    // Keep the legacy placeholder key so older UIs don't break.
    sections: {},
    // Newer UIs can use this.
    adminPanel: {},
  };
}

function defaultPublicSettings() {
  return {
    publicSite: {
      homeModules: {},
      liveTV: {},
      footer: {},
    },
  };
}

async function readSetting(key, fallbackValue) {
  if (!isDbReady()) {
    return { value: fallbackValue, updatedAt: null, source: 'default' };
  }

  const doc = await SystemSetting.findOne({ key }).lean();
  if (!doc || typeof doc.value !== 'object' || doc.value === null) {
    return { value: fallbackValue, updatedAt: null, source: 'default' };
  }

  return { value: doc.value, updatedAt: doc.updatedAt || null, source: 'db' };
}

async function writeSetting(key, value, admin) {
  if (!isDbReady()) {
    return { ok: false, status: 503, message: 'Database unavailable' };
  }

  const updatedBy = {
    id: admin && admin.id ? String(admin.id) : null,
    email: admin && admin.email ? String(admin.email) : null,
    role: admin && admin.role ? String(admin.role) : null,
  };

  const doc = await SystemSetting.findOneAndUpdate(
    { key },
    { $set: { key, value, updatedBy } },
    { upsert: true, new: true },
  ).lean();

  return { ok: true, status: 200, updatedAt: doc?.updatedAt || null };
}

// GET /api/admin/settings
router.get('/settings', requireAdminAuth, async (_req, res, next) => {
  try {
    const fallback = defaultAdminSettings();
    const { value, updatedAt } = await readSetting(ADMIN_SETTINGS_KEY, fallback);
    return res.status(200).json({ ok: true, success: true, status: 200, data: value, updatedAt });
  } catch (e) {
    return next(e);
  }
});

// PUT /api/admin/settings
router.put('/settings', requireAdminAuth, async (req, res, next) => {
  try {
    const parsed = AnyObjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid settings payload' });
    }

    const result = await writeSetting(ADMIN_SETTINGS_KEY, parsed.data, req.admin);
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, success: false, message: result.message });
    }

    return res.status(200).json({ ok: true, success: true, status: 200, updatedAt: result.updatedAt });
  } catch (e) {
    return next(e);
  }
});

// GET /api/admin/public-settings
router.get('/public-settings', requireAdminAuth, async (_req, res, next) => {
  try {
    const fallback = defaultPublicSettings();
    const { value, updatedAt } = await readSetting(PUBLIC_SETTINGS_KEY, fallback);
    return res.status(200).json({ ok: true, success: true, status: 200, data: value, updatedAt });
  } catch (e) {
    return next(e);
  }
});

// PUT /api/admin/public-settings
router.put('/public-settings', requireAdminAuth, async (req, res, next) => {
  try {
    const parsed = AnyObjectSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, success: false, message: 'Invalid public settings payload' });
    }

    const result = await writeSetting(PUBLIC_SETTINGS_KEY, parsed.data, req.admin);
    if (!result.ok) {
      return res.status(result.status).json({ ok: false, success: false, message: result.message });
    }

    return res.status(200).json({ ok: true, success: true, status: 200, updatedAt: result.updatedAt });
  } catch (e) {
    return next(e);
  }
});

// IMPORTANT: If tickers are managed elsewhere (e.g. Broadcast Center), never 404.
// This is a fallback only — if a dedicated tickers router is mounted earlier, it will handle the request.
router.get('/public-settings/tickers', requireAdminAuth, (_req, res) => {
  return res.status(200).json({ ok: true, success: true, status: 200, managedIn: 'broadcast-center' });
});

module.exports = router;
