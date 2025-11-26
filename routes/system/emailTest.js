const express = require('express');
const router = express.Router();
const { sendMail, getTransporter } = require('../../lib/mailer');

// GET /system/email-test -> reports configuration status
router.get('/', (req, res) => {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    EMAIL_FROM,
    SMTP_FROM,
  } = process.env;
  const config = {
    host: !!SMTP_HOST,
    port: !!SMTP_PORT,
    user: !!SMTP_USER,
    pass: !!SMTP_PASS,
    from: !!(EMAIL_FROM || SMTP_FROM || SMTP_USER),
  };
  // getTransporter may throw if configuration is missing (intentional)
  let transporterReady = false;
  let transporterError = null;
  try {
    const t = getTransporter();
    transporterReady = !!t;
  } catch (err) {
    transporterReady = false;
    transporterError = err?.message || String(err);
  }
  res.json({ ok: true, config, transporterReady, transporterError });
});

// POST /system/email-test/send { to?, subject?, text?, html? }
router.post('/send', async (req, res) => {
  const { to, subject, text, html } = req.body || {};
  const target = to || process.env.FOUNDER_EMAIL || process.env.SMTP_USER;
  if (!target) {
    return res.status(400).json({ ok: false, message: 'Target email (to) not provided and no fallback (FOUNDER_EMAIL/SMTP_USER).' });
  }
  try {
    const info = await sendMail({
      to: target,
      subject: subject || 'NewsPulse Test Email',
      text: text || 'This is a test email from NewsPulse backend email-test route.',
      html: html || `<p><strong>NewsPulse Test Email</strong></p><p>Timestamp: ${new Date().toISOString()}</p>`,
    });
    return res.json({
      ok: true,
      message: 'Email attempted',
      result: {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
        envelope: info.envelope,
        response: info.response,
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Send failed', error: err?.message || String(err) });
  }
});

module.exports = router;