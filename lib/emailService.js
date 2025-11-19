const nodemailer = require('nodemailer');

// Email transporter configuration
let transporter = null;

function getTransporter() {
  if (!transporter) {
    const smtpHost = process.env.SMTP_HOST || '';
    const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
    const smtpUser = process.env.SMTP_USER || '';
    const smtpPass = process.env.SMTP_PASS || '';
    const smtpFrom = process.env.SMTP_FROM || smtpUser;

    if (!smtpHost || !smtpUser || !smtpPass) {
      console.warn('⚠️  SMTP not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS in env.');
      return null;
    }

    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });

    console.log(`✅ SMTP transporter configured for ${smtpHost}:${smtpPort}`);
  }
  return transporter;
}

async function sendOtpEmail(toEmail, otpCode) {
  const transport = getTransporter();
  if (!transport) {
    throw new Error('SMTP not configured');
  }

  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
  const subject = 'NewsPulse Admin - Password Reset OTP';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2>Password Reset Request</h2>
      <p>You requested a password reset for your NewsPulse admin account.</p>
      <p>Your OTP code is:</p>
      <div style="background: #f4f4f4; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
        ${otpCode}
      </div>
      <p>This code will expire in <strong>10 minutes</strong>.</p>
      <p>If you did not request this, please ignore this email.</p>
      <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
      <p style="color: #888; font-size: 12px;">NewsPulse Admin Panel</p>
    </div>
  `;

  await transport.sendMail({
    from: fromAddress,
    to: toEmail,
    subject,
    html,
  });
}

module.exports = { sendOtpEmail, getTransporter };
