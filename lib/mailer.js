const nodemailer = require('nodemailer');

// Build & validate SMTP configuration eagerly so failures surface fast.
function buildTransport() {
  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
    SMTP_SERVICE,
    EMAIL_FROM,
    SMTP_FROM,
    SMTP_POOL,
    SMTP_MAX_CONN,
    SMTP_DEBUG,
  } = process.env;

  const missing = [];
  if (!SMTP_HOST && !SMTP_SERVICE) missing.push('SMTP_HOST|SMTP_SERVICE');
  if (!SMTP_PORT && !SMTP_SERVICE) missing.push('SMTP_PORT');
  if (!SMTP_USER) missing.push('SMTP_USER');
  if (!SMTP_PASS) missing.push('SMTP_PASS');
  const fromAddress = EMAIL_FROM || SMTP_FROM || SMTP_USER;
  if (!fromAddress) missing.push('EMAIL_FROM|SMTP_FROM');

  if (missing.length) {
    console.error('[EMAIL][config-error] Missing required env vars:', missing.join(', '));
    throw new Error('Email service not configured: ' + missing.join(', '));
  }

  const portNum = Number(SMTP_PORT || 587);
  const secure = SMTP_SECURE === 'true' || portNum === 465;
  const usePool = SMTP_POOL === 'true';
  const maxConnections = SMTP_MAX_CONN ? Number(SMTP_MAX_CONN) : undefined;

  const baseConfig = {
    secure,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  };
  if (SMTP_SERVICE) {
    // Allows simple Gmail setup via SMTP_SERVICE=gmail + APP password.
    baseConfig.service = SMTP_SERVICE;
  } else {
    baseConfig.host = SMTP_HOST;
    baseConfig.port = portNum;
  }
  if (usePool) {
    baseConfig.pool = true;
    if (maxConnections) baseConfig.maxConnections = maxConnections;
  }
  if (SMTP_DEBUG === 'true') {
    baseConfig.logger = true;
    baseConfig.debug = true;
  }

  const transport = nodemailer.createTransport(baseConfig);

  transport.verify().then(() => {
    console.log('[EMAIL][transporter-ready]', {
      host: baseConfig.host || baseConfig.service,
      port: baseConfig.port,
      secure: baseConfig.secure,
      user: SMTP_USER,
      pool: !!baseConfig.pool,
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
      transporter = null; // Keep null so callers can handle absence.
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
  const start = Date.now();
  try {
    const info = await transport.sendMail(mailOptions);
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