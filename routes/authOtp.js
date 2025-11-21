const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const OtpToken = require('../models/OtpToken');
const User = require('../models/User');
const ActivityLog = require('../models/ActivityLog');
const { sendMail } = require('../lib/mailer');
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

// OTP Flow (standard path will be /api/admin/auth/otp/*):
// 1) POST /request  { email } -> always { ok:true, message:'OTP sent' }
// 2) POST /verify   { email, otp } -> { ok:true, resetToken } when valid
// 3) POST /reset    { email, resetToken, newPassword } -> { ok:true, message:'Password updated successfully' }
// Security: generic success on request to avoid email enumeration; still logs outcome internally.

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function handleRequest(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, message: 'Email is required' });
    }
    console.log('[OTP_ROUTE_HIT][request] email=', email);
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (otpLimited(ip)) {
      return res.status(429).json({ ok: false, message: 'Too many OTP requests. Please try later.' });
    }
    otpRegister(ip);
    const lowerEmail = email.toLowerCase();
    // Gating logic: allow when founder matches OR founder email not set OR OTP_ALLOW_ANY=1.
    const founderEmail = (process.env.FOUNDER_EMAIL || '').toLowerCase();
    const allowAny = (process.env.OTP_ALLOW_ANY || '0') === '1';
    const founderMatch = founderEmail && lowerEmail === founderEmail;
    const gatingAllowed = allowAny || founderMatch || !founderEmail;
    if (!gatingAllowed) {
      return res.json({ ok: true, message: 'If this email is registered, an OTP has been sent.' });
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
      email: lowerEmail,
      codeHash,
      expiresAt,
      used: false,
    });
    // Fast response strategy: send email in background and respond immediately.
    const payload = { ok: true, message: 'If this email is registered, an OTP has been sent.' };
    if ((process.env.OTP_DEV_ECHO || '') === '1') { payload.devCode = code; }

    // Validate minimal SMTP config; if missing, still respond success but log.
    const missingSmtp = !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS;
    if (missingSmtp) {
      console.warn('[OTP_REQUEST][smtp-missing] SMTP env vars not fully set; email will not be sent.');
      await ActivityLog.create({ type: 'otp_request_fail', email: lowerEmail, meta: { error: 'smtp_missing' } });
      return res.json(payload);
    }

    // Background send with timeout safeguard (does not block response)
    const EMAIL_TIMEOUT_MS = parseInt(process.env.OTP_EMAIL_TIMEOUT_MS || '5000', 10);
    const sendPromise = sendMail({
      to: lowerEmail,
      subject: 'News Pulse Admin OTP',
      text: `Your News Pulse verification code is ${code}. It expires in 10 minutes.`,
    });
    // Wrap with timeout; if exceeded, we detach logging but user already has response.
    Promise.race([
      sendPromise.then(() => ({ sent: true })),
      new Promise(resolve => setTimeout(() => resolve({ sent: false, timeout: true }), EMAIL_TIMEOUT_MS)),
    ]).then(async (result) => {
      try {
        if (result.sent) {
          await ActivityLog.create({ type: 'otp_request', email: lowerEmail, meta: { method: 'email', expiresAt } });
          console.log('[OTP_REQUEST][sent] email=', lowerEmail, 'expiresAt=', expiresAt.toISOString());
        } else if (result.timeout) {
          console.warn('[OTP_REQUEST][timeout] email send taking too long (detached). email=', lowerEmail);
          // Attempt final resolution logging
          sendPromise.then(async () => {
            console.log('[OTP_REQUEST][late-success] email=', lowerEmail);
            await ActivityLog.create({ type: 'otp_request', email: lowerEmail, meta: { method: 'email_late', expiresAt } });
          }).catch(async (lateErr) => {
            console.error('[OTP_REQUEST][late-fail]', lateErr?.message || lateErr);
            await ActivityLog.create({ type: 'otp_request_fail', email: lowerEmail, meta: { error: lateErr?.message || 'late_send_failed' } });
          });
        } else {
          console.error('[OTP_REQUEST][unknown-race-state]');
        }
      } catch (bgErr) {
        console.error('[OTP_REQUEST][bg-log-error]', bgErr?.message || bgErr);
      }
    }).catch(err => {
      console.error('[OTP_REQUEST][race-error]', err?.message || err);
    });

    return res.json(payload);
  } catch (err) {
    console.error('[OTP_ERROR][request-handler]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not process OTP request' });
  }
}
// Absolute legacy path
router.post('/auth/otp/request', handleRequest);
// Relative path for /api/admin/auth/otp mounting
router.post('/request', handleRequest);
// New explicit reset-request alias expected by admin panel
router.post('/auth/otp/request-reset', handleRequest);
router.post('/request-reset', handleRequest);

async function handleVerify(req, res) {
  try {
    const { email, otp, code } = req.body || {}; // accept otp or code field
    const provided = otp || code;
    if (!email || !provided) {
      return res.status(400).json({ ok: false, message: 'Email and otp are required' });
    }
    console.log('[OTP_ROUTE_HIT][verify] email=', email);
    const lowerEmail = email.toLowerCase();
    const otpRecord = await OtpToken.findOne({ email: lowerEmail, used: false }).sort({ createdAt: -1 });
    if (!otpRecord) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
    }
    if (new Date() > otpRecord.expiresAt) {
      return res.status(400).json({ ok: false, message: 'OTP has expired' });
    }
    const match = await bcrypt.compare(provided.toString(), otpRecord.codeHash);
    if (!match) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired OTP' });
    }
    const resetToken = crypto.randomBytes(32).toString('hex');
    otpRecord.resetToken = resetToken;
    otpRecord.resetTokenExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
    await otpRecord.save();
    await ActivityLog.create({ type: 'otp_verify', email: lowerEmail, meta: { codeVerified: true } });
    console.log('[OTP_VERIFY][success] email=', lowerEmail, 'resetTokenExpiresAt=', otpRecord.resetTokenExpiresAt.toISOString());
    return res.json({ ok: true, resetToken });
  } catch (err) {
    console.error('[OTP_ERROR][verify-handler]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not verify OTP' });
  }
}
router.post('/auth/otp/verify', handleVerify);
router.post('/verify', handleVerify);

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

// Reset strictly via resetToken
async function handleReset(req, res) {
  try {
    const { email, resetToken, newPassword } = req.body || {};
    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ ok: false, message: 'Email, resetToken and newPassword are required' });
    }
    console.log('[OTP_ROUTE_HIT][reset] email=', email);
    const lowerEmail = email.toLowerCase();
    const otpRecord = await OtpToken.findOne({ email: lowerEmail, resetToken, used: false }).sort({ createdAt: -1 });
    if (!otpRecord || !otpRecord.resetTokenExpiresAt || new Date() > otpRecord.resetTokenExpiresAt) {
      return res.status(400).json({ ok: false, message: 'Invalid or expired reset token' });
    }
    otpRecord.used = true;
    await otpRecord.save();
    const rounds = parseInt(process.env.PASSWORD_HASH_ROUNDS || '10', 10);
    let user = await User.findOne({ email: lowerEmail });
    if (!user) {
      user = await User.create({ email: lowerEmail, name: process.env.FOUNDER_NAME || 'Founder', passwordHash: await bcrypt.hash(newPassword, rounds), role: 'founder' });
    } else {
      user.passwordHash = await bcrypt.hash(newPassword, rounds);
      await user.save();
    }
    await ActivityLog.create({ type: 'password_reset', email: lowerEmail, meta: { via: 'resetToken' } });
    console.log('[OTP_RESET][success] email=', lowerEmail);
    return res.json({ ok: true, message: 'Password updated successfully' });
  } catch (err) {
    console.error('[OTP_ERROR][reset-handler]', err?.message || err);
    return res.status(500).json({ ok: false, message: 'Could not reset password' });
  }
}

router.post('/auth/otp/reset', handleReset);
router.post('/reset', handleReset);

// Note: relative routes (/request,/verify,/reset) allow mounting under /api/admin/auth/otp
// while absolute legacy paths remain available for backward compatibility.

module.exports = router;
