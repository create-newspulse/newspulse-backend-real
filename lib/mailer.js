const nodemailer = require('nodemailer');

// Build & validate SMTP configuration eagerly so failures surface fast.
function buildTransport() {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
    EMAIL_FROM,
    SMTP_FROM,
  } = process.env;

  const missing = [];
  if (!SMTP_HOST) missing.push('SMTP_HOST');
  if (!SMTP_PORT) missing.push('SMTP_PORT');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  const fromAddress = EMAIL_FROM || SMTP_FROM || SMTP_USER;
  if (!fromAddress) missing.push('EMAIL_FROM|SMTP_FROM');

  if (missing.length) {
    console.error('[EMAIL][config-error] Missing required env vars:', missing.join(', '));
    // Throw so callers can decide to degrade gracefully.
    throw new Error('Email service not configured: ' + missing.join(', '));
  }

  const portNum = Number(SMTP_PORT || 587);
  const secure = SMTP_SECURE === 'true' || portNum === 465;

  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: portNum,
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  // Optional verification to detect auth/connect issues early.
  transport.verify().then(() => {
    console.log('[EMAIL][transporter-ready]', {
      host: SMTP_HOST,
      port: portNum,
      secure,
      user: SMTP_USER,
    });
  }).catch(err => {
    console.error('[EMAIL][verify-fail]', err?.message || err);
  });

  return transport;
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    try {
      transporter = buildTransport();
    } catch (e) {
      // Keep null so callers can handle absence.
      transporter = null;
    }
  }
  return transporter;
}

async function sendMail(options) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP transporter unavailable (missing configuration)');
  }
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;
  const mailOptions = { from, ...options };
  let info;
  const start = Date.now();
  try {
    info = await transport.sendMail(mailOptions);
    const elapsedMs = Date.now() - start;
    console.log('[EMAIL][sent]', JSON.stringify({
      to: mailOptions.to,
      subject: mailOptions.subject,
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      envelope: info.envelope,
      elapsedMs,
      ts: new Date().toISOString(),
    }));
    return info;
  } catch (err) {
    console.error('[EMAIL][send-error]', JSON.stringify({
      to: mailOptions.to,
      subject: mailOptions.subject,
      error: err?.message || err,
      ts: new Date().toISOString(),
    }));
    throw err;
  }
}

module.exports = { getTransporter, sendMail };