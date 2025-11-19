const express = require('express');
const router = express.Router();

// Frontend expects:
// POST /auth/otp/request { email } -> { ok: true, message: string }
// Stub implementation for now; DOES NOT send real email.
// TODO: Integrate real email/OTP storage when user accounts are added.

router.post('/auth/otp/request', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email is required' });
    }

    // TODO: Lookup user/admin by email when model exists.
    // If not found, we still respond generically to avoid account enumeration.

    return res.json({
      ok: true,
      message: 'If this email is registered, an OTP has been (stub) sent.'
    });
  } catch (err) {
    console.error('[auth/otp/request] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not process OTP request' });
  }
});

module.exports = router;
