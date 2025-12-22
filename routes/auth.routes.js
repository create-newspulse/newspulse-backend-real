const express = require('express');
const { requireAdminAuth } = require('../middleware/adminAuth');

const router = express.Router();

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
