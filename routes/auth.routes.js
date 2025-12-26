const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

function normalizeEmail(v) {
	return String(v || '').toLowerCase().trim();
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
	try {
		const email = normalizeEmail(req.body?.email || req.body?.username);
		const password = String(req.body?.password || '');

		if (!email || !password) {
			return res.status(400).json({ success: false, message: 'Email and password required' });
		}

		const adminEmail = normalizeEmail(process.env.ADMIN_EMAIL);
		const adminPass = String(process.env.ADMIN_PASS || '');

		const founderEmail = normalizeEmail(process.env.FOUNDER_EMAIL);
		const founderPass = String(process.env.FOUNDER_PASSWORD || '');

		let role = null;
		if (email === adminEmail && password === adminPass) role = 'admin';
		if (email === founderEmail && password === founderPass) role = 'founder';

		if (!role) {
			return res.status(401).json({ success: false, message: 'Invalid credentials' });
		}

		if (!process.env.JWT_SECRET) {
			return res.status(500).json({ success: false, message: 'JWT_SECRET missing on server' });
		}

		const token = jwt.sign({ email, role }, process.env.JWT_SECRET, { expiresIn: '7d' });

		// Set cookies with common names (so whatever your middleware expects, it works)
		res.cookie('token', token, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 7 * 86400000 });
		res.cookie('np_token', token, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 7 * 86400000 });
		// Also set the cookie name supported by existing admin auth middleware
		res.cookie('np_admin_token', token, { httpOnly: true, secure: true, sameSite: 'none', maxAge: 7 * 86400000 });

		return res.json({
			success: true,
			token,
			user: { email, role },
		});
	} catch (err) {
		return res.status(500).json({ success: false, message: err.message });
	}
});

// GET /api/auth/me
// Stable shape for admin panel auth bootstrap.
router.get('/me', requireAdminAuth, (req, res) => {
	const a = req.admin || {};
	const role = (a.role === 'founder' || a.role === 'admin') ? a.role : 'admin';
	return res.json({
		ok: true,
		success: true,
		role,
		user: {
			id: a.id || 'unknown',
			email: a.email || '',
			role,
		},
	});
});

module.exports = router;
