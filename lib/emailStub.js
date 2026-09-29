// Simple stub email sender used for OTP and other notifications in development.
// Replace with a real provider (HTTP API) in production.

async function sendEmail({ to, subject, text }) {
  const ts = new Date().toISOString();
  console.log('[EMAIL][stub-send]', { queued: true, ts });
  return { ok: true, ts };
}

module.exports = { sendEmail };