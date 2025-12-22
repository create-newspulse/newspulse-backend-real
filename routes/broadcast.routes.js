const express = require('express');
const mongoose = require('mongoose');

const BroadcastItem = require('../models/BroadcastItem');
const BroadcastSettings = require('../models/BroadcastSettings');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

function requireAdminAuthIfProd(req, res, next) {
	const env = String(process.env.NODE_ENV || 'development').toLowerCase();
	if (env === 'production') return requireAdminAuth(req, res, next);
	return next();
}

function ensureDbOr503(res) {
	if (mongoose.connection.readyState !== 1) {
		res.status(503).json({ ok: false, message: 'Database unavailable' });
		return false;
	}
	return true;
}

function isDbReady() {
	return mongoose.connection.readyState === 1;
}

function defaultSettings() {
	return {
		breakingEnabled: false,
		liveEnabled: false,
		breakingMode: 'manual',
		liveMode: 'auto',
		updatedAt: new Date(),
	};
}

async function getOrCreateSettings() {
	let s = await BroadcastSettings.findOne({});
	if (!s) {
		try {
			s = await BroadcastSettings.create(defaultSettings());
		} catch (_) {
			s = await BroadcastSettings.findOne({});
		}
	}
	return s;
}

function sanitizeMode(v) {
	return v === 'auto' || v === 'manual' ? v : undefined;
}

function sanitizeLanguage(v) {
	const s = String(v || '').trim().toLowerCase();
	if (s === 'hi' || s === 'gu' || s === 'en') return s;
	return null;
}

function sanitizeType(v) {
	const s = String(v || '').trim().toLowerCase();
	if (s === 'breaking' || s === 'live') return s;
	return null;
}

function pickSettingsResponse(s) {
	const safe = s || {};
	return {
		breakingEnabled: !!safe.breakingEnabled,
		liveEnabled: !!safe.liveEnabled,
		breakingMode: safe.breakingMode === 'auto' ? 'auto' : 'manual',
		liveMode: safe.liveMode === 'manual' ? 'manual' : 'auto',
		updatedAt: safe.updatedAt || null,
	};
}

// ADMIN: GET /api/broadcast/settings
router.get('/settings', requireAdminAuthIfProd, async (_req, res) => {
	if (!isDbReady()) {
		return res.status(200).json(defaultSettings());
	}
	const s = await getOrCreateSettings();
	return res.status(200).json(pickSettingsResponse(s));
});

// ADMIN: PUT /api/broadcast/settings
router.put('/settings', requireAdminAuthIfProd, async (req, res) => {
	if (!ensureDbOr503(res)) return;

	const s = await getOrCreateSettings();
	const body = req.body && typeof req.body === 'object' ? req.body : {};

	if (Object.prototype.hasOwnProperty.call(body, 'breakingEnabled')) s.breakingEnabled = !!body.breakingEnabled;
	if (Object.prototype.hasOwnProperty.call(body, 'liveEnabled')) s.liveEnabled = !!body.liveEnabled;

	const bm = sanitizeMode(body.breakingMode);
	const lm = sanitizeMode(body.liveMode);
	if (bm) s.breakingMode = bm;
	if (lm) s.liveMode = lm;
	s.updatedAt = new Date();

	await s.save();
	return res.json(pickSettingsResponse(s));
});

// ADMIN: GET /api/broadcast/items?type=breaking|live&language=en|hi|gu
router.get('/items', requireAdminAuthIfProd, async (req, res) => {
	if (!isDbReady()) {
		return res.status(200).json([]);
	}

	const type = sanitizeType(req.query.type);
	if (!type) {
		return res.status(400).json({ success: false, message: 'Invalid type. Expected breaking|live' });
	}

	const language = Object.prototype.hasOwnProperty.call(req.query, 'language')
		? sanitizeLanguage(req.query.language)
		: null;
	if (Object.prototype.hasOwnProperty.call(req.query, 'language') && !language) {
		return res.status(400).json({ success: false, message: 'Invalid language. Expected en|hi|gu' });
	}
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

	const filter = { type, createdAt: { $gte: since } };
	if (language) filter.language = language;

	const items = await BroadcastItem.find(filter).sort({ createdAt: -1 }).lean();
	return res.status(200).json(items);
});

// ADMIN: POST /api/broadcast/items
router.post('/items', requireAdminAuthIfProd, async (req, res) => {
	if (!ensureDbOr503(res)) return;

	const body = req.body && typeof req.body === 'object' ? req.body : {};
	const type = sanitizeType(body.type);
	const language = Object.prototype.hasOwnProperty.call(body, 'language')
		? sanitizeLanguage(body.language)
		: 'en';
	if (Object.prototype.hasOwnProperty.call(body, 'language') && !language) {
		return res.status(400).json({ success: false, message: 'Invalid language. Expected en|hi|gu' });
	}
	const text = typeof body.text === 'string' ? body.text.trim() : '';

	if (!type) return res.status(400).json({ success: false, message: 'Invalid type. Expected breaking|live' });
	if (!text) return res.status(400).json({ success: false, message: 'text is required' });
	if (text.length > 160) return res.status(400).json({ success: false, message: 'text must be <= 160 chars' });

	const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

	const item = await BroadcastItem.create({
		type,
		language,
		text: text,
		isLive: false,
		expiresAt,
	});

	return res.status(201).json(item);
});

// ADMIN: PATCH /api/broadcast/items/:id
router.patch('/items/:id', requireAdminAuthIfProd, async (req, res) => {
	if (!ensureDbOr503(res)) return;

	const { id } = req.params;
	const body = req.body && typeof req.body === 'object' ? req.body : {};

	let item = null;
	try {
		item = await BroadcastItem.findById(id);
	} catch (_) {
		// invalid id
	}
	if (!item) return res.status(404).json({ message: 'Not found' });

	if (typeof body.isLive === 'boolean') item.isLive = body.isLive;
	if (typeof body.text === 'string') {
		const nextText = body.text.trim();
		if (!nextText) return res.status(400).json({ success: false, message: 'text cannot be empty' });
		if (nextText.length > 160) return res.status(400).json({ success: false, message: 'text must be <= 160 chars' });
		item.text = nextText;
	}

	await item.save();
	return res.json(item);
});

// ADMIN: DELETE /api/broadcast/items/:id
router.delete('/items/:id', requireAdminAuthIfProd, async (req, res) => {
	if (!ensureDbOr503(res)) return;

	const { id } = req.params;
	let deleted = null;
	try {
		deleted = await BroadcastItem.findByIdAndDelete(id);
	} catch (_) {
		// ignore
	}
	if (!deleted) return res.status(404).json({ message: 'Not found' });
	return res.json({ ok: true });
});

// PUBLIC: GET /api/broadcast/public?language=gu
// Returns settings + last-24h breaking/live items (stable shape for website).
router.get('/public', async (req, res) => {
	// If DB is down, still return a stable shape.
	if (mongoose.connection.readyState !== 1) {
		return res.json({
			settings: defaultSettings(),
			breakingLiveItems: [],
			liveUpdates: [],
		});
	}

	const language = Object.prototype.hasOwnProperty.call(req.query, 'language')
		? sanitizeLanguage(req.query.language)
		: 'en';
	if (Object.prototype.hasOwnProperty.call(req.query, 'language') && !language) {
		return res.status(400).json({ success: false, message: 'Invalid language. Expected en|hi|gu' });
	}
	let s = await BroadcastSettings.findOne({}).lean();
	if (!s) s = defaultSettings();

	const settings = pickSettingsResponse(s);
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const baseFilter = { language, createdAt: { $gte: since } };

	const [breakingLiveItems, liveUpdates] = await Promise.all([
		settings.breakingEnabled
			? BroadcastItem.find({ ...baseFilter, type: 'breaking' }).sort({ createdAt: -1 }).lean()
			: Promise.resolve([]),
		settings.liveEnabled
			? BroadcastItem.find({ ...baseFilter, type: 'live' }).sort({ createdAt: -1 }).lean()
			: Promise.resolve([]),
	]);

	return res.json({ settings, breakingLiveItems, liveUpdates });
});

module.exports = router;
