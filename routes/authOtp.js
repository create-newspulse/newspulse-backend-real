const express = require('express');
const crypto = require('crypto');
const OtpToken = require('../models/OtpToken');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { sendOtpEmail } = require('../lib/emailService');
const bcrypt = require('bcrypt');
const router = express.Router();

// OTP rate limiter (in-memory)
const otpRateLimit = { windowMs: 15 * 60 * 1000, maxAttempts: 10, attempts: new Map() };
function otpRegister(ip) {
  const now = Date.now();
  const rec = otpRateLimit.attempts.get(ip);
  if (!rec || now - rec.first > otpRateLimit.windowMs) {
    otpRateLimit.attempts.set(ip, { count: 1, first: now });
  } else { rec.count += 1; }
}
function otpLimited(ip) {
  const rec = otpRateLimit.attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > otpRateLimit.windowMs) { otpRateLimit.attempts.delete(ip); return false; }
  return rec.count >= otpRateLimit.maxAttempts;
}

// Frontend expects (standardized path will be /api/auth/otp/*):
// POST /auth/otp/request  or /api/auth/otp/request  { email } -> { ok: true, message }
// POST /auth/otp/verify   or /api/auth/otp/verify   { email, code } -> { ok: true, resetToken }
// POST /auth/otp/reset    or /api/auth/otp/reset    { email, resetToken, newPassword } -> { ok: true, message }
// Back-compat: also support code-based reset payload { email, code, newPassword }

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function handleRequest(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email is required' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (otpLimited(ip)) {
      return res.status(429).json({ ok: false, message: 'Too many OTP requests. Please try later.' });
    }
    otpRegister(ip);

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

    const codeHash = await bcrypt.hash(code, 10);
    await OtpToken.create({
      email: email.toLowerCase(),
      codeHash,
      expiresAt,
      used: false,
    });

    // Send email
    try {
      await sendOtpEmail(email, code);
      await ActivityLog.create({ type: 'otp_request', email: email.toLowerCase(), meta: { method: 'email' } });
      return res.json({ ok: true, message: 'If this email is registered, an OTP has been sent.' });
    } catch (emailErr) {
      console.error('[auth/otp/request] email send failed:', emailErr?.message || emailErr);
      // Still return success but log the error
      return res.json({ ok: true, message: 'If this email is registered, an OTP has been sent.' });
    }
  } catch (err) {
    console.error('[auth/otp/request] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not process OTP request' });
  }
}

router.post('/auth/otp/request', handleRequest);

async function handleVerify(req, res) {
  try {
    const { email, code } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ ok: false, message: 'Email and code are required' });
    }

    const otpRecord = await OtpToken.findOne({ email: email.toLowerCase(), used: false }).sort({ createdAt: -1 });
    if (!otpRecord) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
    }
    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({ ok: false, message: 'OTP has expired' });
    }

    const match = await bcrypt.compare(code.toString(), otpRecord.codeHash);
    if (!match) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    otpRecord.resetToken = resetToken;
    otpRecord.resetTokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await otpRecord.save();

    await ActivityLog.create({ type: 'otp_verify', email: email.toLowerCase(), meta: { codeVerified: true } });
    return res.json({ ok: true, resetToken });
  } catch (err) {
    console.error('[auth/otp/verify] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not verify OTP' });
  }
}

router.post('/auth/otp/verify', handleVerify);

// Back-compat endpoint accepts { email, code, newPassword } or { email, resetToken, newPassword }
router.post('/auth/reset-password', async (req, res) => {
  try {
    const { email, code, resetToken, newPassword } = req.body || {};
    if (!email || !newPassword) {
      return res.status(400).json({ ok: false, message: 'Email and new password are required' });
    }

    let otpRecord = null;
    if (resetToken) {
      otpRecord = await OtpToken.findOne({ email: email.toLowerCase(), resetToken, used: false }).sort({ createdAt: -1 });
      if (!otpRecord || !otpRecord.resetTokenExpiresAt || new Date() > otpRecord.resetTokenExpiresAt) {
        return res.status(400).json({ ok: false, message: 'Invalid or expired reset token' });
      }
    } else if (code) {
      otpRecord = await OtpToken.findOne({ email: email.toLowerCase(), used: false }).sort({ createdAt: -1 });
      if (!otpRecord) {
        return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
      }
      if (new Date() > otpRecord.expiresAt) {
        return res.status(400).json({ ok: false, message: 'OTP has expired' });
      }
      const match = await bcrypt.compare(code.toString(), otpRecord.codeHash);
      if (!match) {
        return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
      }
    } else {
      return res.status(400).json({ ok: false, message: 'Provide either resetToken or code' });
    }

    // Check if this is the founder email
    const founderEmail = (process.env.FOUNDER_EMAIL || '').toLowerCase();
    if (email.toLowerCase() !== founderEmail) {
      return res.status(403).json({ ok: false, message: 'Cannot reset password for this account' });
    }

    // Mark OTP as used
    otpRecord.used = true;
    await otpRecord.save();
    const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      user = await User.create({ email: email.toLowerCase(), name: process.env.FOUNDER_NAME || 'Founder', passwordHash: await bcrypt.hash(newPassword, rounds), role: 'founder' });
    } else {
      user.passwordHash = await bcrypt.hash(newPassword, rounds);
      await user.save();
    }
    await ActivityLog.create({ type: 'password_reset', email: email.toLowerCase(), meta: { via: 'otp' } });
    return res.json({ ok: true, message: 'Password has been updated.' });
  } catch (err) {
    console.error('[auth/reset-password] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not reset password' });
  }
});

// SPA-expected endpoint alias: POST /auth/otp/reset
// Accepts payload: { email, resetToken, newPassword } or { email, code, newPassword }
router.post('/auth/otp/reset', async (req, res) => {
  try {
    const { email, resetToken, code, newPassword } = req.body || {};
    if (!email || !newPassword) {
      return res.status(400).json({ ok: false, message: 'Email and new password are required' });
    }

    let otpRecord = null;
    if (resetToken) {
      otpRecord = await OtpToken.findOne({ email: email.toLowerCase(), resetToken, used: false }).sort({ createdAt: -1 });
      if (!otpRecord || !otpRecord.resetTokenExpiresAt || new Date() > otpRecord.resetTokenExpiresAt) {
        return res.status(400).json({ ok: false, message: 'Invalid or expired reset token' });
      }
    } else if (code) {
      otpRecord = await OtpToken.findOne({ email: email.toLowerCase(), used: false }).sort({ createdAt: -1 });
      if (!otpRecord) {
        return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
      }
      if (new Date() > otpRecord.expiresAt) {
        return res.status(400).json({ ok: false, message: 'OTP has expired' });
      }
      const match = await bcrypt.compare(code.toString(), otpRecord.codeHash);
      if (!match) {
        return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
      }
    } else {
      return res.status(400).json({ ok: false, message: 'Provide either resetToken or code' });
    }

    const founderEmail = (process.env.FOUNDER_EMAIL || '').toLowerCase();
    if (email.toLowerCase() !== founderEmail) {
      return res.status(403).json({ ok: false, message: 'Cannot reset password for this account' });
    }

    otpRecord.used = true;
    await otpRecord.save();

    const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
    let user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      user = await User.create({ email: email.toLowerCase(), name: process.env.FOUNDER_NAME || 'Founder', passwordHash: await bcrypt.hash(newPassword, rounds), role: 'founder' });
    } else {
      user.passwordHash = await bcrypt.hash(newPassword, rounds);
      await user.save();
    }

    await ActivityLog.create({ type: 'password_reset', email: email.toLowerCase(), meta: { via: 'otp' } });
    return res.json({ ok: true, message: 'Password has been updated.' });
  } catch (err) {
    console.error('[auth/otp/reset] error', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not reset password' });
  }
});

// (No extra relative /reset route; use /auth/otp/reset for both legacy and /api mounts)

module.exports = router;
