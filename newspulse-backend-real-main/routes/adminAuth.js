const express = require('express');
const { requireAdminAuth } = require('../../middleware/adminAuth');
const router = express.Router();

router.get('/session', (req, res, next) => {
  const denied = { status: () => denied, json: () => res.status(200).json({ success: false, user: null }) };
  return requireAdminAuth(req, denied, () => {
    if (!req.admin) return next();
    const { id, email, name, role } = req.admin;
    return res.status(200).json({ success: true, user: { id, email, name, role } });
  });
});

module.exports = router;
