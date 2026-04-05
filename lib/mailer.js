const nodemailer = require('nodemailer');

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function isRenderLike() {
  return !!(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);
}

function isProductionLike() {
  return String(process.env.NODE_ENV || '').toLowerCase() === 'production' || isRenderLike();
}

function serializeMailError(error) {
  return {
    message: error?.message || String(error),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.responseCode ? { responseCode: error.responseCode } : {}),
    ...(error?.command ? { command: error.command } : {}),
    ...(error?.errno ? { errno: error.errno } : {}),
    ...(error?.syscall ? { syscall: error.syscall } : {}),
  };
}

function getMailConfig() {
  const emailMode = firstNonEmpty(process.env.EMAIL_MODE).toLowerCase();
  const smtpService = firstNonEmpty(process.env.SMTP_SERVICE, process.env.ADS_SMTP_SERVICE);
  const smtpHost = firstNonEmpty(process.env.SMTP_HOST, process.env.ADS_SMTP_HOST);
  const smtpPort = firstNonEmpty(process.env.SMTP_PORT, process.env.ADS_SMTP_PORT);
  const smtpUser = firstNonEmpty(process.env.SMTP_USER, process.env.ADS_SMTP_USER);
  const smtpPass = firstNonEmpty(process.env.SMTP_PASS, process.env.ADS_SMTP_PASS);
  const smtpFrom = firstNonEmpty(process.env.MAIL_FROM, process.env.FROM_EMAIL, process.env.EMAIL_FROM, process.env.SMTP_FROM, process.env.ADS_SMTP_FROM, process.env.ADS_SMTP_USER, smtpUser);
  const smtpSecure = firstNonEmpty(process.env.SMTP_SECURE, process.env.ADS_SMTP_SECURE);
  const smtpPool = firstNonEmpty(process.env.SMTP_POOL, process.env.ADS_SMTP_POOL);
  const smtpMaxConn = firstNonEmpty(process.env.SMTP_MAX_CONN, process.env.ADS_SMTP_MAX_CONN);
  const smtpDebug = firstNonEmpty(process.env.SMTP_DEBUG, process.env.ADS_SMTP_DEBUG);
  const appBaseUrl = firstNonEmpty(process.env.APP_BASE_URL, process.env.SITE_URL, process.env.PUBLIC_BASE_URL, process.env.RENDER_EXTERNAL_URL);

  const missing = [];
  if (!smtpHost && !smtpService) missing.push('SMTP_HOST|SMTP_SERVICE');
  if (!smtpPort && !smtpService) missing.push('SMTP_PORT');
  if (!smtpUser) missing.push('SMTP_USER');
  if (!smtpPass) missing.push('SMTP_PASS');
  if (!smtpFrom) missing.push('MAIL_FROM|FROM_EMAIL|EMAIL_FROM|SMTP_FROM');

  return {
    emailMode,
    smtpService,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpFrom,
    smtpSecure,
    smtpPool,
    smtpMaxConn,
    smtpDebug,
    appBaseUrl,
    missing,
  };
}

function getMailerStatus() {
  const config = getMailConfig();
  return {
    productionLike: isProductionLike(),
    renderLike: isRenderLike(),
    stubMode: config.emailMode === 'stub',
    configured: config.emailMode === 'stub' || config.missing.length === 0,
    missing: [...config.missing],
    resolved: {
      host: !!config.smtpHost,
      service: !!config.smtpService,
      port: !!config.smtpPort,
      user: !!config.smtpUser,
      pass: !!config.smtpPass,
      from: !!config.smtpFrom,
      appBaseUrl: !!config.appBaseUrl,
    },
  };
}

// Build & validate SMTP configuration eagerly so failures surface fast.
function buildTransport() {
  const config = getMailConfig();

  // If running in explicit stub mode, skip strict validation (but log warning)
  const stubMode = config.emailMode === 'stub';

  if (stubMode && isProductionLike()) {
    console.error('[EMAIL][config-error] Stub email mode is not allowed in production-like environments');
    const error = new Error('Email stub mode is not allowed in production');
    error.code = 'EMAIL_STUB_FORBIDDEN';
    throw error;
  }

  if (config.missing.length && !stubMode) {
    // Surface clear diagnostic for production/real email mode
    console.error('[EMAIL][config-error] Missing required env vars:', config.missing.join(', '));
    throw new Error('Email service not configured: ' + config.missing.join(', '));
  }

  const portNum = Number(config.smtpPort || 587);
  const secure = config.smtpSecure === 'true' || portNum === 465;
  const usePool = config.smtpPool === 'true';
  const maxConnections = config.smtpMaxConn ? Number(config.smtpMaxConn) : undefined;

  const baseConfig = {
    secure,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  };
  if (config.smtpService) {
    // Allows simple Gmail setup via SMTP_SERVICE=gmail + APP password.
    baseConfig.service = config.smtpService;
  } else {
    baseConfig.host = config.smtpHost;
    baseConfig.port = portNum;
  }
  if (usePool) {
    baseConfig.pool = true;
    if (maxConnections) baseConfig.maxConnections = maxConnections;
  }
  if (config.smtpDebug === 'true') {
    baseConfig.logger = true;
    baseConfig.debug = true;
  }

  console.log('[EMAIL][transporter-init]', {
    mode: stubMode ? 'stub' : 'smtp',
    host: baseConfig.host || baseConfig.service,
    port: baseConfig.port,
    secure: baseConfig.secure,
    pool: !!baseConfig.pool,
    fromConfigured: !!config.smtpFrom,
    appBaseUrlConfigured: !!config.appBaseUrl,
    productionLike: isProductionLike(),
  });

  const transport = nodemailer.createTransport(baseConfig);

  transport.verify().then(() => {
    console.log('[EMAIL][transporter-ready]', {
      host: baseConfig.host || baseConfig.service,
      port: baseConfig.port,
      secure: baseConfig.secure,
      user: config.smtpUser,
      pool: !!baseConfig.pool,
    });
  }).catch(err => {
    console.error('[EMAIL][verify-fail]', JSON.stringify(serializeMailError(err)));
  });

  return transport;
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    // Do not silently swallow configuration errors - let callers handle thrown errors
    transporter = buildTransport();
  }
  return transporter;
}

async function sendMail(options) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP transporter unavailable (missing configuration)');
  }
  const from = getMailConfig().smtpFrom;
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
      error: serializeMailError(err),
      ts: new Date().toISOString(),
    }));
    throw err;
  }
}

module.exports = { getTransporter, sendMail, getMailerStatus };