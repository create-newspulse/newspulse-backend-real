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

function maskEmail(e) {
  try {
    const [user, domain] = e.split('@');
    if (!user || !domain) return e;
    const maskedUser = user.length <= 2 ? user[0] + '*' : user.slice(0, 2) + '***';
    return maskedUser + '@' + domain;
  } catch (_) { return e; }
}

async function handleRequest(req, res) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ ok: false, success: false, message: 'Email is required' });
    }
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    if (otpLimited(ip)) {
      return res.status(429).json({ ok: false, success: false, message: 'Too many OTP requests. Please try later.' });
    }
    otpRegister(ip);
    const lowerEmail = email.toLowerCase();
    const masked = maskEmail(lowerEmail);
    console.log('[OTP_REQUEST][start]', { emailMasked: masked, ip });

    // Gating logic
    const founderEmail = (process.env.FOUNDER_EMAIL || '').toLowerCase();
    const allowAny = (process.env.OTP_ALLOW_ANY || '0') === '1';
    const founderMatch = founderEmail && lowerEmail === founderEmail;
    const gatingAllowed = allowAny || founderMatch || !founderEmail;
    if (!gatingAllowed) {
      return res.json({ ok: true, success: true, message: 'If this email is registered, an OTP has been sent.' });
    }

    // Basic SMTP config presence check BEFORE generating OTP
    const smtpMissing = !process.env.SMTP_HOST && !process.env.SMTP_SERVICE || !process.env.SMTP_USER || !process.env.SMTP_PASS;
    if (smtpMissing) {
      console.error('[OTP_REQUEST][smtp-missing]', { host: !!process.env.SMTP_HOST, service: !!process.env.SMTP_SERVICE, user: !!process.env.SMTP_USER, pass: !!process.env.SMTP_PASS });
      return res.status(500).json({ ok: false, success: false, message: 'Email service is not configured.' });
    }

    // Invalidate previous unused OTPs
    await OtpToken.updateMany({ email: lowerEmail, used: false }, { $set: { used: true } });

    // Generate and store OTP
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const codeHash = await bcrypt.hash(code, 10);
    await OtpToken.create({ email: lowerEmail, codeHash, expiresAt, used: false });
    console.log('[OTP_REQUEST][generated]', { emailMasked: masked, expiresAt: expiresAt.toISOString() });

    // Attempt to send email synchronously
    try {
      const info = await sendMail({
        to: lowerEmail,
        subject: 'News Pulse Admin OTP',
        text: `Your News Pulse verification code is ${code}. It expires in 10 minutes.`,
      });
      const accepted = Array.isArray(info?.accepted) ? info.accepted : [];
      if (!accepted.length) {
        console.error('[OTP_REQUEST][send-empty-accepted]', { emailMasked: masked, messageId: info?.messageId });
        await ActivityLog.create({ type: 'otp_request_fail', email: lowerEmail, meta: { error: 'smtp_not_accepted' } });
        return res.status(500).json({ ok: false, success: false, message: 'Could not send OTP email. Please try again or contact support.' });
      }
      await ActivityLog.create({ type: 'otp_request', email: lowerEmail, meta: { method: 'email', expiresAt, messageId: info.messageId } });
      console.log('[OTP_REQUEST][sent]', { emailMasked: masked, messageId: info.messageId, expiresAt: expiresAt.toISOString(), accepted });
      const response = { ok: true, success: true, message: 'OTP sent to your email.', emailMasked: masked };
      if ((process.env.OTP_DEV_ECHO || '') === '1') response.devCode = code; // dev only
      return res.json(response);
    } catch (sendErr) {
      console.error('[OTP_REQUEST][send-error]', sendErr?.message || sendErr);
      await ActivityLog.create({ type: 'otp_request_fail', email: lowerEmail, meta: { error: sendErr?.message || 'send_failed' } });
      return res.status(500).json({ ok: false, success: false, message: 'Could not send OTP email. Please try again or contact support.' });
    }
  } catch (err) {
    console.error('[OTP_ERROR][request-handler]', err?.message || err);
    return res.status(500).json({ ok: false, success: false, message: 'Could not process OTP request' });
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
