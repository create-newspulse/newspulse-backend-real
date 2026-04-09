const express = require('express');
const router = express.Router();
const {
  classifyAndWrapMailerError,
  DEFAULT_MAIL_SCOPE,
  REPORTER_OTP_MAIL_SCOPE,
  sendMail,
  getTransporter,
  getMailerStatus,
} = require('../../lib/mailer');

function resolveRequestedScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === REPORTER_OTP_MAIL_SCOPE ? REPORTER_OTP_MAIL_SCOPE : DEFAULT_MAIL_SCOPE;
}

// GET /system/email-test -> reports configuration status
router.get('/', (req, res) => {
  const scope = resolveRequestedScope(req.query?.scope);
  const status = getMailerStatus({ scope });
  // getTransporter may throw if configuration is missing (intentional)
  let transporterReady = false;
  let transporterError = null;
  let backendCode = status.configured ? null : 'MAILER_NOT_CONFIGURED';
  try {
    const t = getTransporter(undefined, { scope });
    transporterReady = !!t;
  } catch (err) {
    const classified = classifyAndWrapMailerError(err, { provider: status.provider, scope });
    transporterReady = false;
    transporterError = classified?.message || err?.message || String(err);
    backendCode = classified?.backendCode || 'PROVIDER_UNAVAILABLE';
  }
  res.json({ ok: true, scope, provider: status.provider, providerOrder: status.providerOrder, config: status.resolved, missing: status.missing, backendCode, transport: status.transport, transporterReady, transporterError });
});

// POST /system/email-test/send { to?, subject?, text?, html? }
router.post('/send', async (req, res) => {
  const scope = resolveRequestedScope(req.query?.scope || req.body?.scope);
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
    }, { scope });
    return res.json({
      ok: true,
      scope,
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
    const status = getMailerStatus({ scope });
    const classified = classifyAndWrapMailerError(err, { provider: status.provider, scope });
    return res.status(500).json({ ok: false, scope, provider: classified.provider || status.provider, backendCode: classified.backendCode || 'PROVIDER_UNAVAILABLE', message: 'Send failed', error: classified?.message || err?.message || String(err) });
  }
});

module.exports = router;