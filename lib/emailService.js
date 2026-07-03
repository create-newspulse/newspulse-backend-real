const nodemailer = require('nodemailer');

// Email transporter configuration
const transporters = new Map();

function getDefaultEmailConfig() {
  const smtpHost = process.env.SMTP_HOST || '';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS || '';
  const fromAddress = (process.env.EMAIL_FROM || process.env.SMTP_FROM || smtpUser);

  return {
    cacheKey: 'default',
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    fromAddress,
    missingMessage: '⚠️  SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in env.',
  };
}

function getPrivacyEmailConfig() {
  const smtpHost = process.env.SMTP_HOST || '';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpUser = process.env.SMTP_USER_PRIVACY || process.env.SMTP_USER || '';
  const smtpPass = process.env.SMTP_PASS_PRIVACY || process.env.SMTP_PASS || '';
  const fromAddress = process.env.SMTP_FROM_PRIVACY
    || process.env.SMTP_FROM
    || (smtpUser ? `News Pulse Privacy <${smtpUser}>` : '');

  return {
    cacheKey: `privacy:${smtpHost}:${smtpPort}:${smtpUser}`,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    fromAddress,
    missingMessage: '⚠️  Privacy SMTP not configured. Set SMTP_USER_PRIVACY/SMTP_PASS_PRIVACY or fallback SMTP_USER/SMTP_PASS in env.',
  };
}

function createTransporter(config) {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });
}

function getTransporter() {
  const config = getDefaultEmailConfig();
  if (!transporters.has(config.cacheKey)) {
    if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
      console.warn(config.missingMessage);
      return null;
    }

    transporters.set(config.cacheKey, createTransporter(config));
    console.log(`✅ SMTP transporter configured for ${config.smtpHost}:${config.smtpPort}`);
  }
  return transporters.get(config.cacheKey);
}

function getPrivacyTransporter() {
  const config = getPrivacyEmailConfig();
  if (!transporters.has(config.cacheKey)) {
    if (!config.smtpHost || !config.smtpUser || !config.smtpPass) {
      console.warn(config.missingMessage);
      return null;
    }

    transporters.set(config.cacheKey, createTransporter(config));
    console.log(`✅ Privacy SMTP transporter configured for ${config.smtpHost}:${config.smtpPort}`);
  }
  return transporters.get(config.cacheKey);
}

function resetTransporters() {
  transporters.clear();
}

function otpTemplate(code) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Password Reset Request</h2>
      <p>You requested a password reset for your NewsPulse admin account.</p>
      <p>Your OTP code is:</p>
      <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
        ${code}
      </div>
      <p>This code will expire in <strong>10 minutes</strong>.</p>
      <p>If you did not request this, please ignore this email.</p>
      <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
      <p style="color: #888; font-size: 12px;">NewsPulse Admin Panel</p>
    </div>
  `;
}

async function sendOtpEmail(toEmail, otpCode) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP not configured');
  }

  const fromAddress = getDefaultEmailConfig().fromAddress;
  const subject = 'NewsPulse Admin - Password Reset OTP';
  const html = otpTemplate(otpCode);

  await transport.sendMail({
    from: fromAddress,
    to: toEmail,
    subject,
    html,
  });
}

module.exports = {
  sendOtpEmail,
  getTransporter,
  getPrivacyTransporter,
  getDefaultEmailConfig,
  getPrivacyEmailConfig,
  otpTemplate,
  resetTransporters,
};
