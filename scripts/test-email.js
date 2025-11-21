#!/usr/bin/env node
/*
 * Test email sender for NewsPulse backend.
 * Usage:
 *   node scripts/test-email.js --to=user@example.com --subject="Test" --text="Hello" --html="<p>Hello</p>"
 * Env vars required: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, (EMAIL_FROM|SMTP_FROM optional)
 */
require('dotenv').config();
const { sendMail } = require('../lib/mailer');

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
  const to = args.to || process.env.FOUNDER_EMAIL || process.env.SMTP_USER;
  if (!to) {
    console.error('No recipient provided (--to) and no fallback (FOUNDER_EMAIL/SMTP_USER).');
    process.exit(1);
  }
  const subject = args.subject || 'NewsPulse Test Email';
  const text = args.text || 'Plain text body for NewsPulse test email.';
  const html = args.html || `<p><strong>NewsPulse Test Email</strong></p><p>Timestamp: ${new Date().toISOString()}</p>`;
  console.log('[TEST-EMAIL] Attempting send...', { to, subject });
  try {
    const info = await sendMail({ to, subject, text, html });
    console.log('[TEST-EMAIL][SUCCESS]', JSON.stringify({
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      response: info.response,
      envelope: info.envelope,
    }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error('[TEST-EMAIL][FAIL]', err?.message || err);
    process.exit(2);
  }
}

main();