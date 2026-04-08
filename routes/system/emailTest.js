const express = require('express');
const router = express.Router();
const { classifyAndWrapMailerError, sendMail, getTransporter, getMailerStatus } = require('../../lib/mailer');

// GET /system/email-test -> reports configuration status
router.get('/', (req, res) => {
  const status = getMailerStatus();
  // getTransporter may throw if configuration is missing (intentional)
  let transporterReady = false;
  let transporterError = null;
  let backendCode = status.configured ? null : 'MAILER_NOT_CONFIGURED';
  try {
    const t = getTransporter();
    transporterReady = !!t;
  } catch (err) {
    const classified = classifyAndWrapMailerError(err, { provider: status.provider });
    transporterReady = false;
    transporterError = classified?.message || err?.message || String(err);
    backendCode = classified?.backendCode || 'PROVIDER_UNAVAILABLE';
  }
  res.json({ ok: true, provider: status.provider, config: status.resolved, missing: status.missing, backendCode, transporterReady, transporterError });
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
    const status = getMailerStatus();
    const classified = classifyAndWrapMailerError(err, { provider: status.provider });
    return res.status(500).json({ ok: false, provider: classified.provider || status.provider, backendCode: classified.backendCode || 'PROVIDER_UNAVAILABLE', message: 'Send failed', error: classified?.message || err?.message || String(err) });
  }
});

module.exports = router;