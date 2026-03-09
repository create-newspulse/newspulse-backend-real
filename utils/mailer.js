const nodemailer = require('nodemailer');

const { getPublicBaseUrl } = require('../lib/publicBaseUrl');

function _parseBool(v, fallback) {
  if (v === undefined || v === null || String(v).trim() === '') return !!fallback;
  const s = String(v).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;
  return !!fallback;
}

function _env(key) {
  return String(process.env[key] || '').trim();
}

function _getAdsSmtpConfig() {
  const host = _env('ADS_SMTP_HOST') || _env('SMTP_HOST');
  const portRaw = _env('ADS_SMTP_PORT') || _env('SMTP_PORT') || '587';
  const port = Number.parseInt(String(portRaw), 10);
  const user = _env('ADS_SMTP_USER') || _env('SMTP_USER');
  const passRaw = _env('ADS_SMTP_PASS') || _env('SMTP_PASS');
  const pass = passRaw ? String(passRaw).replace(/\s+/g, '') : '';

  // Gmail STARTTLS default: 587 + secure=false
  const secureDefault = Number.isFinite(port) ? port === 465 : false;
  const secure = _parseBool(_env('ADS_SMTP_SECURE') || _env('SMTP_SECURE'), secureDefault);

  const missing = [];
  if (!host) missing.push('ADS_SMTP_HOST (or SMTP_HOST)');
  if (!Number.isFinite(port)) missing.push('ADS_SMTP_PORT (or SMTP_PORT)');
  if (!user) missing.push('ADS_SMTP_USER (or SMTP_USER)');
  if (!pass) missing.push('ADS_SMTP_PASS (or SMTP_PASS)');

  return { host, port, secure, user, pass, missing };
}

let _adsTransport = null;
function createAdsTransport() {
  const { host, port, secure, user, pass, missing } = _getAdsSmtpConfig();

  if (missing.length) {
    console.error('[ads][mailer][config-error] Missing SMTP env vars:', missing.join(', '));
    throw new Error('Ads SMTP not configured');
  }

  // Cache one transport per process.
  if (_adsTransport) return _adsTransport;

  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  // Verify asynchronously; do not block requests.
  transport.verify().then(() => {
    console.log('[ads-smtp] ready');
  }).catch((err) => {
    console.warn('[ads-smtp] not ready', err?.message || String(err));
  });

  _adsTransport = transport;
  return transport;
}

async function sendAdsInquiryMail({ name, email, message, createdAt, inquiryId, meta }) {
  const to = _env('ADS_INQUIRY_TO');
  if (!to) {
    console.error('[ads][mailer][config-error] Missing ADS_INQUIRY_TO');
    throw new Error('ADS_INQUIRY_TO is not set');
  }

  const { user } = _getAdsSmtpConfig();
  const from = _env('ADS_INQUIRY_FROM') || user;

  const ts = createdAt ? new Date(createdAt) : new Date();
  const tsIso = Number.isFinite(ts.getTime()) ? ts.toISOString() : new Date().toISOString();
  const site = getPublicBaseUrl() || _env('PUBLIC_BASE_URL') || _env('SITE_URL') || _env('PUBLIC_SITE_URL') || '';

  const subject = `New Ad Inquiry - ${String(name || '').trim() || 'Unknown'}`;
  const ip = meta && meta.ip ? String(meta.ip) : '';
  const userAgent = meta && meta.userAgent ? String(meta.userAgent) : '';
  const referer = meta && (meta.referer || meta.referrer) ? String(meta.referer || meta.referrer) : '';
  const siteFromMeta = meta && meta.site ? String(meta.site) : '';
  const siteFinal = siteFromMeta || site;

  const text = [
    `Name: ${String(name || '').trim()}`,
    `Email: ${String(email || '').trim()}`,
    `Timestamp: ${tsIso}`,
    `Site: ${siteFinal}`,
    ...(ip ? [`IP: ${ip}`] : []),
    ...(userAgent ? [`User-Agent: ${userAgent}`] : []),
    ...(referer ? [`Referer: ${referer}`] : []),
    ...(inquiryId ? [`InquiryId: ${String(inquiryId)}`] : []),
    '',
    'Message:',
    String(message || ''),
  ].join('\n');

  const transport = createAdsTransport();
  const start = Date.now();

  try {
    const info = await transport.sendMail({
      to,
      from,
      replyTo: String(email || '').trim() || undefined,
      subject,
      text,
    });

    console.log('[ads][mailer][sent]', {
      to,
      subject,
      messageId: info?.messageId,
      elapsedMs: Date.now() - start,
    });

    return info;
  } catch (err) {
    console.error('[ads][mailer][send-failed]', {
      to,
      subject,
      message: err?.message || String(err),
    });
    throw err;
  }
}

module.exports = {
  createAdsTransport,
  sendAdsInquiryMail,
};
