// lib/sendgridEmail.js
// SendGrid-based email sending for OTP and other transactional emails.

const sgMail = require('@sendgrid/mail');

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || process.env.EMAIL_FROM || 'no-reply@newspulse.co.in';

if (!SENDGRID_API_KEY) {
  console.warn('[EMAIL][config] SENDGRID_API_KEY not set – SendGrid emails will fail.');
} else {
  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
    console.log('[EMAIL][sendgrid-init] API key set. From:', SENDGRID_FROM_EMAIL);
  } catch (e) {
    console.error('[EMAIL][sendgrid-init-error]', e?.message || e);
  }
}

function buildOtpHtml(otp) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin:0 auto;">
      <h2 style="color:#1a1a1a;">News Pulse Admin OTP</h2>
      <p>Your verification code is:</p>
      <div style="font-size:32px;font-weight:bold;letter-spacing:6px;padding:12px 20px;background:#f5f7fa;border:1px solid #e2e8f0;border-radius:8px;text-align:center;">${otp}</div>
      <p style="margin-top:20px;">This code expires in <strong>10 minutes</strong>.</p>
      <p>If you did not request this password reset, you can ignore this email.</p>
      <hr style="margin:28px 0;border:none;border-top:1px solid #e2e8f0;" />
      <p style="font-size:12px;color:#64748b;">&copy; ${new Date().getFullYear()} News Pulse Admin</p>
    </div>
  `;
}

async function sendOtpEmail(to, otp) {
  if (!SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY not configured');
  }
  const msg = {
    to,
    from: SENDGRID_FROM_EMAIL,
    subject: 'News Pulse Admin OTP',
    text: `Your News Pulse Admin OTP is: ${otp}. It is valid for 10 minutes.`,
    html: buildOtpHtml(otp),
  };
  try {
    const [response] = await sgMail.send(msg);
    const requestId = response && response.headers ? (response.headers['x-message-id'] || response.headers['x-sendgrid-message-id'] || response.headers['x-request-id']) : undefined;
    console.log('[EMAIL][send-success]', { to, statusCode: response.statusCode, requestId });
    return { statusCode: response.statusCode };
  } catch (error) {
    const errMsg = error?.response?.body?.errors ? JSON.stringify(error.response.body.errors) : (error?.message || error);
    console.error('[EMAIL][send-error]', { to, subject: msg.subject, error: errMsg });
    throw error;
  }
}

module.exports = { sendOtpEmail };
