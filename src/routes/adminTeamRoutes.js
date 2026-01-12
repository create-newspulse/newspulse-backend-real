const express = require('express');
const mongoose = require('mongoose');

const { requireAdminAuth } = require('../../middleware/adminAuth');

let User = null;
try { User = require('../../models/User'); } catch (_) {}

const router = express.Router();

function isDbReady() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

// GET /api/admin/team/users
router.get('/users', requireAdminAuth, async (_req, res) => {
  if (!isDbReady() || !User) {
    return res.status(200).json({ ok: true, users: [] });
  }

  const docs = await User.find({ role: { $in: ['founder', 'admin', 'editor', 'staff'] } })
    .select('_id name email role status createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const users = (docs || []).map((u) => ({
    id: String(u._id),
    name: u.name || '',
    email: u.email || '',
    role: u.role || 'staff',
    status: u.status || 'active',
    createdAt: u.createdAt || null,
  }));

  return res.status(200).json({ ok: true, users });
});

module.exports = router;
