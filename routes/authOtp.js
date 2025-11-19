const express = require('express');
const OtpToken = require('../models/OtpToken');
const { sendOtpEmail } = require('../lib/emailService');
const router = express.Router();

// Frontend expects:
// POST /auth/otp/request { email } -> { ok: true, message: string }
// POST /auth/otp/verify { email, code } -> { ok: true, message: string }
// POST /auth/reset-password { email, code, newPassword } -> { ok: true, message: string }

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

router.post('/auth/otp/request', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email is required' });
    }

    // Check if email matches founder email (only founder can reset for now)
    const founderEmail = (process.env.FOUNDER_EMAIL || '').toLowerCase();
    if (!founderEmail || email.toLowerCase() !== founderEmail) {
      // Generic response to avoid account enumeration
      return res.json({
        ok: true,
        message: 'If this email is registered, an OTP has been sent.'
      });
    }

    // Invalidate any existing unused OTPs for this email
    await OtpToken.updateMany(
      { email: email.toLowerCase(), used: false },
      { $set: { used: true } }
    );

    // Generate new OTP
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await OtpToken.create({
      email: email.toLowerCase(),
      code,
      expiresAt,
      used: false,
    });

    // Send email
    try {
      await sendOtpEmail(email, code);
      return res.json({
        ok: true,
        message: 'OTP has been sent to your email address.'
      });
    } catch (emailErr) {
      console.error('[auth/otp/request] email send failed:', emailErr?.message || emailErr);
      // Still return success but log the error
      return res.json({
        ok: true,
        message: 'OTP generated. (Email sending may be unavailable - check logs for code)'
      });
    }
  } catch (err) {
    console.error('[auth/otp/request] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not process OTP request' });
  }
});

router.post('/auth/otp/verify', async (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ ok: false, message: 'Email and code are required' });
    }

    const otpRecord = await OtpToken.findOne({
      email: email.toLowerCase(),
      code: code.toString(),
      used: false,
    });

    if (!otpRecord) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
    }

    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({ ok: false, message: 'OTP has expired' });
    }

    return res.json({
      ok: true,
      message: 'OTP verified successfully'
    });
  } catch (err) {
    console.error('[auth/otp/verify] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not verify OTP' });
  }
});

router.post('/auth/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body || {};
    if (!email || !code || !newPassword) {
      return res.status(400).json({ ok: false, message: 'Email, code, and new password are required' });
    }

    const otpRecord = await OtpToken.findOne({
      email: email.toLowerCase(),
      code: code.toString(),
      used: false,
    });

    if (!otpRecord) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
    }

    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({ ok: false, message: 'OTP has expired' });
    }

    // Check if this is the founder email
    const founderEmail = (process.env.FOUNDER_EMAIL || '').toLowerCase();
    if (email.toLowerCase() !== founderEmail) {
      return res.status(403).json({ ok: false, message: 'Cannot reset password for this account' });
    }

    // Mark OTP as used
    otpRecord.used = true;
    await otpRecord.save();

    // TODO: In production, update the password in the database
    // For now, we just update the env variable (requires restart)
    console.warn(`⚠️  Password reset requested for ${email}. Update FOUNDER_PASSWORD in env to: ${newPassword}`);

    return res.json({
      ok: true,
      message: 'Password reset request processed. Contact admin to complete the change.'
    });
  } catch (err) {
    console.error('[auth/reset-password] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not reset password' });
  }
});

module.exports = router;
