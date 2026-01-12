const express = require('express');
const jwt = require('jsonwebtoken');
const { requireAdminAuth } = require('../middleware/adminAuth');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('../models/User');

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

		if (!process.env.JWT_SECRET) {
			return res.status(500).json({ success: false, message: 'JWT_SECRET missing on server' });
		}

		const dbReady = mongoose.connection && mongoose.connection.readyState === 1;
		if (dbReady) {
			const user = await User.findOne({ email });
			if (user) {
				if (user.status === 'suspended') {
					return res.status(403).json({ success: false, message: 'Account suspended' });
				}
				const ok = await bcrypt.compare(password, user.passwordHash);
				if (!ok) return res.status(401).json({ success: false, message: 'Invalid credentials' });
				user.lastLoginAt = new Date();
				await user.save();
				const token = jwt.sign({ sub: String(user._id), userId: String(user._id), email: user.email, name: user.name, role: user.role, tokenVersion: typeof user.tokenVersion === 'number' ? user.tokenVersion : 0, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '7d' });
				// Set cookies with common names (so whatever your middleware expects, it works)
				const isHttps = Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
				const cookieOpts = {
					httpOnly: true,
					secure: isHttps,
					sameSite: isHttps ? 'none' : 'lax',
					maxAge: 7 * 86400000,
					path: '/',
				};
				res.cookie('token', token, cookieOpts);
				res.cookie('np_token', token, cookieOpts);
				res.cookie('np_admin_token', token, cookieOpts);
				return res.json({ success: true, token, user: { id: String(user._id), email: user.email, role: user.role, name: user.name, mustChangePassword: Boolean(user.mustChangePassword || user.forceReset) } });
			}
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

		if (dbReady) {
			const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
			const created = await User.findOneAndUpdate(
				{ email },
				{
					$setOnInsert: {
						email,
						name: role === 'founder' ? (process.env.FOUNDER_NAME || 'Founder') : 'Admin',
						passwordHash: await bcrypt.hash(password, rounds),
						role,
						status: 'active',
						tokenVersion: 0,
						mustChangePassword: false,
						createdAt: new Date(),
					},
					$set: { role, lastLoginAt: new Date() },
				},
				{ upsert: true, new: true },
			);
			const token = jwt.sign({ sub: String(created._id), userId: String(created._id), email, name: created.name, role, tokenVersion: typeof created.tokenVersion === 'number' ? created.tokenVersion : 0, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '7d' });
			const isHttps = Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
			const cookieOpts = {
				httpOnly: true,
				secure: isHttps,
				sameSite: isHttps ? 'none' : 'lax',
				maxAge: 7 * 86400000,
				path: '/',
			};
			res.cookie('token', token, cookieOpts);
			res.cookie('np_token', token, cookieOpts);
			res.cookie('np_admin_token', token, cookieOpts);
			return res.json({ success: true, token, user: { id: String(created._id), email, role, name: created.name, mustChangePassword: Boolean(created.mustChangePassword || created.forceReset) } });
		}

		const token = jwt.sign({ email, role, tokenVersion: 0, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '7d' });

		const isHttps = Boolean(req.secure) || String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
		const cookieOpts = {
			httpOnly: true,
			secure: isHttps,
			sameSite: isHttps ? 'none' : 'lax',
			maxAge: 7 * 86400000,
			path: '/',
		};

		res.cookie('token', token, cookieOpts);
		res.cookie('np_token', token, cookieOpts);
		res.cookie('np_admin_token', token, cookieOpts);
		return res.json({ success: true, token, user: { email, role } });
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
