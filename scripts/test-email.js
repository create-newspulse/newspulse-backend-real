#!/usr/bin/env node
/*
 * Test email sender for NewsPulse backend.
 * Usage:
 *   node scripts/test-email.js --to=user@example.com --subject="Test" --text="Hello" --html="<p>Hello</p>"
 * Env vars required: either SMTP_HOST/SMTP_SERVICE + SMTP_USER + SMTP_PASS,
 * or RESEND_API_KEY (+ RESEND_FROM or a shared FROM alias).
 */
require('dotenv').config();
const { sendMail, getTransporter } = require('../lib/mailer');

function parseArgs(argv) {
  const out = {};
  argv.forEach(arg => {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const val = arg.slice(eq + 1);
        out[key] = val;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.debug) {
    process.env.SMTP_DEBUG = 'true';
  }
  const to = args.to || process.env.FOUNDER_EMAIL || process.env.SMTP_USER || process.env.ADS_SMTP_USER;
  if (!to) {
    console.error('No recipient provided (--to) and no fallback (FOUNDER_EMAIL/SMTP_USER/ADS_SMTP_USER).');
    process.exit(1);
  }
  const subject = args.subject || 'NewsPulse Test Email';
  const text = args.text || 'Plain text body for NewsPulse test email.';
  const html = args.html || `<p><strong>NewsPulse Test Email</strong></p><p>Timestamp: ${new Date().toISOString()}</p>`;
  const transporter = getTransporter();
  if (!transporter) {
    console.error('[TEST-EMAIL] Transporter not available. Missing required env vars?');
    console.error('Required: SMTP_HOST|SMTP_SERVICE + SMTP_USER + SMTP_PASS, or RESEND_API_KEY + RESEND_FROM (or MAIL_FROM/FROM_EMAIL/EMAIL_FROM)');
    process.exit(3);
  }
  console.log('[TEST-EMAIL] Attempting send...', { to, subject });
  if (process.env.SMTP_DEBUG === 'true') {
    console.log('[TEST-EMAIL] Debug mode active (SMTP_DEBUG=true).');
  }
  console.log('[TEST-EMAIL] From header resolved as:', process.env.EMAIL_FROM || process.env.MAIL_FROM || process.env.FROM_EMAIL || process.env.ADS_SMTP_FROM || process.env.SMTP_USER || process.env.ADS_SMTP_USER);
  console.log('[TEST-EMAIL] Envelope from resolved as:', process.env.SMTP_FROM || '(default transport envelope)');
  try {
    const info = await sendMail({ to, subject, text, html });
    console.log('[TEST-EMAIL][SUCCESS]', JSON.stringify({
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      envelope: info.envelope,
    }, null, 2));
    if (info.rejected && info.rejected.length) {
      console.warn('[TEST-EMAIL][WARN] Some recipients were rejected:', info.rejected);
    }
    process.exit(0);
  } catch (err) {
    console.error('[TEST-EMAIL][FAIL]', err?.message || err);
    if (err && err.response) {
      console.error('[TEST-EMAIL][SMTP-RESPONSE]', err.response);
    }
    if (err && err.code) {
      console.error('[TEST-EMAIL][CODE]', err.code);
    }
    process.exit(2);
  }
}

main();