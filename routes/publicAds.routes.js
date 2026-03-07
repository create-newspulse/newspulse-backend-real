const express = require('express');
const mongoose = require('mongoose');

const AdInquiry = require('../models/AdInquiry');
const mailer = require('../lib/mailer');

const {
  getActiveAd,
  postImpression,
  postClick,
} = require('../controllers/publicAdsController');

const router = express.Router();

function isDbReady() {
  const env = String(process.env.NODE_ENV || '').toLowerCase();
  if (env === 'test') return true;
  return mongoose.connection && mongoose.connection.readyState === 1;
}

function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function _isValidEmail(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  // Lightweight email validation.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// GET /api/public/ads?slot=HOME_728x90
router.get('/ads', getActiveAd);

// GET /api/public/ads/slot/:slot
router.get('/ads/slot/:slot', (req, res, next) => {
  req.query = req.query || {};
  req.query.slot = req.params.slot;
  return getActiveAd(req, res, next);
});

// POST /api/public/ads/:id/impression
router.post('/ads/:id/impression', postImpression);

// POST /api/public/ads/:id/click
router.post('/ads/:id/click', postClick);

// POST /api/public/ads/inquiry
// Body: { name, email, message }
router.post('/ads/inquiry', async (req, res) => {
  try {
    if (!isDbReady()) {
      return res.status(503).json({ success: false, message: 'Database unavailable' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const message = String(body.message || '').trim();

    if (!_isNonEmptyString(name)) {
      return res.status(400).json({ success: false, message: 'Missing required field: name' });
    }
    if (!_isNonEmptyString(email)) {
      return res.status(400).json({ success: false, message: 'Missing required field: email' });
    }
    if (!_isValidEmail(email)) {
      return res.status(400).json({ success: false, message: 'Invalid email' });
    }
    if (!_isNonEmptyString(message)) {
      return res.status(400).json({ success: false, message: 'Missing required field: message' });
    }

    const ip = req.ip ? String(req.ip) : null;
    const userAgent = req.headers && req.headers['user-agent'] ? String(req.headers['user-agent']) : null;

    const inquiry = await AdInquiry.create({
      name,
      email,
      message,
      status: 'new',
      ...(ip ? { ip } : {}),
      ...(userAgent ? { userAgent } : {}),
    });

    // Best-effort email notification (do not block storing inquiries if SMTP is down).
    try {
      const to = String(process.env.ADS_INQUIRY_TO || '').trim();
      const from = String(process.env.ADS_INQUIRY_FROM || '').trim();
      if (to) {
        const createdAt = inquiry && inquiry.createdAt ? new Date(inquiry.createdAt).toISOString() : new Date().toISOString();
        const subject = `New Ad Inquiry — ${name} (${email})`;
        const text = [
          `Name: ${name}`,
          `Email: ${email}`,
          `CreatedAt: ${createdAt}`,
          `IP: ${ip || ''}`,
          `User-Agent: ${userAgent || ''}`,
          '',
          'Message:',
          message,
          '',
          `InquiryId: ${inquiry && inquiry._id ? String(inquiry._id) : ''}`,
        ].join('\n');

        await mailer.sendMail({
          to,
          ...(from ? { from } : {}),
          replyTo: email,
          subject,
          text,
        });
      }
    } catch (e) {
      try {
        console.warn('[ads][inquiry][email-failed]', {
          id: inquiry && inquiry._id ? String(inquiry._id) : null,
          message: e?.message || String(e),
        });
      } catch (_) {}
    }

    return res.status(200).json({ success: true, id: String(inquiry._id) });
  } catch (e) {
    return res.status(500).json({ success: false, message: e?.message || String(e) });
  }
});

module.exports = router;
