const nodemailer = require('nodemailer');

const GRIEVANCE_SUBJECT = 'New Grievance Submission - News Pulse';

let cachedTransporter = null;
let cachedTransporterKey = null;

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parseBool(value, fallback = false) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return !!fallback;
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return !!fallback;
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

function resolveSmtpSecurity(smtpPort, smtpSecureRaw) {
  const portNumber = smtpPort ? Number(smtpPort) : null;
  const hasExplicitSecure = String(smtpSecureRaw || '').trim() !== '';
  const explicitSecure = hasExplicitSecure ? parseBool(smtpSecureRaw, false) : null;

  if (portNumber === 465) {
    return {
      secure: true,
      adjusted: hasExplicitSecure && explicitSecure === false,
    };
  }

  if (portNumber === 587) {
    return {
      secure: false,
      adjusted: hasExplicitSecure && explicitSecure === true,
    };
  }

  return {
    secure: parseBool(smtpSecureRaw, portNumber === 465),
    adjusted: false,
  };
}

function getGrievanceMailConfig() {
  const smtpHost = firstNonEmpty(process.env.GRIEVANCE_SMTP_HOST);
  const smtpPortRaw = firstNonEmpty(process.env.GRIEVANCE_SMTP_PORT);
  const smtpUser = firstNonEmpty(process.env.GRIEVANCE_SMTP_USER);
  const smtpPass = firstNonEmpty(process.env.GRIEVANCE_SMTP_PASS);
  const to = firstNonEmpty(process.env.GRIEVANCE_TO_EMAIL);
  const smtpSecureRaw = firstNonEmpty(process.env.GRIEVANCE_SMTP_SECURE);
  const smtpPort = smtpPortRaw ? Number(smtpPortRaw) : null;
  const security = resolveSmtpSecurity(smtpPort, smtpSecureRaw);

  const missing = [];
  if (!to) missing.push('GRIEVANCE_TO_EMAIL');
  if (!smtpHost) missing.push('GRIEVANCE_SMTP_HOST');
  if (!smtpPort) missing.push('GRIEVANCE_SMTP_PORT');
  if (!smtpUser) missing.push('GRIEVANCE_SMTP_USER');
  if (!smtpPass) missing.push('GRIEVANCE_SMTP_PASS');

  return {
    to,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpSecure: security.secure,
    adjustedSecure: security.adjusted,
    configured: missing.length === 0,
    missing,
    cacheKey: JSON.stringify({
      smtpHost,
      smtpPort,
      smtpUser,
      smtpPassPresent: !!smtpPass,
      smtpSecure: security.secure,
    }),
  };
}

function buildConfigError(config) {
  const error = new Error(
    config?.missing?.length
      ? `Grievance mailer missing env: ${config.missing.join(', ')}`
      : 'Grievance mailer is not configured'
  );
  error.code = 'GRIEVANCE_MAILER_NOT_CONFIGURED';
  return error;
}

function getTransporter() {
  const config = getGrievanceMailConfig();
  if (!config.configured) {
    throw buildConfigError(config);
  }

  if (cachedTransporter && cachedTransporterKey === config.cacheKey) {
    return cachedTransporter;
  }

  cachedTransporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
  cachedTransporterKey = config.cacheKey;
  return cachedTransporter;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatHtmlValue(value) {
  const escaped = escapeHtml(value);
  return escaped ? escaped.replace(/\n/g, '<br/>') : 'N/A';
}

function formatTextValue(value) {
  const text = String(value || '').trim();
  return text || 'N/A';
}

function buildTextBody(payload) {
  return [
    'A new grievance has been submitted on News Pulse.',
    '',
    `Full Name: ${formatTextValue(payload.fullName)}`,
    `Email: ${formatTextValue(payload.email)}`,
    `Phone: ${formatTextValue(payload.phone)}`,
    `Address: ${formatTextValue(payload.address)}`,
    `Article/Page URL or content reference: ${formatTextValue(payload.contentReference)}`,
    `Date of publication: ${formatTextValue(payload.publicationDate)}`,
    `Violation part: ${formatTextValue(payload.violationPart)}`,
    `Violation summary: ${formatTextValue(payload.violationSummary)}`,
    `Declaration accepted: ${payload.declarationAccepted ? 'Yes' : 'No'}`,
    `Submitted at timestamp: ${formatTextValue(payload.submittedAt)}`,
    `Request IP: ${formatTextValue(payload.requestIp)}`,
  ].join('\n');
}

function buildHtmlBody(payload) {
  return [
    '<div style="font-family:Arial,sans-serif;line-height:1.6;color:#111">',
    '<h2 style="margin:0 0 16px">New Grievance Submission - News Pulse</h2>',
    '<table style="border-collapse:collapse;width:100%">',
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Full Name</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.fullName)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Email</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.email)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Phone</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.phone)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Address</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.address)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Article/Page URL or content reference</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.contentReference)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Date of publication</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.publicationDate)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Violation part</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.violationPart)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Violation summary</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.violationSummary)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Declaration accepted</td><td style="padding:6px 10px;border:1px solid #ddd">${payload.declarationAccepted ? 'Yes' : 'No'}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Submitted at timestamp</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.submittedAt)}</td></tr>`,
    `<tr><td style="padding:6px 10px;border:1px solid #ddd;font-weight:700">Request IP</td><td style="padding:6px 10px;border:1px solid #ddd">${formatHtmlValue(payload.requestIp)}</td></tr>`,
    '</table>',
    '</div>',
  ].join('');
}

async function sendGrievanceMail(payload) {
  const config = getGrievanceMailConfig();
  if (!config.configured) {
    throw buildConfigError(config);
  }

  const transporter = getTransporter();
  return transporter.sendMail({
    from: config.smtpUser,
    to: config.to,
    replyTo: payload.email,
    subject: GRIEVANCE_SUBJECT,
    text: buildTextBody(payload),
    html: buildHtmlBody(payload),
  });
}

module.exports = {
  GRIEVANCE_SUBJECT,
  getGrievanceMailConfig,
  getTransporter,
  sendGrievanceMail,
  serializeMailError,
};