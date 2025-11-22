// Simple stub email sender used for OTP and other notifications in development.
// Replace with a real provider (HTTP API) in production.

async function sendEmail({ to, subject, text }) {
  const ts = new Date().toISOString();
  // Basic OTP extraction heuristic for logging (looks for 6 consecutive digits)
  const otpMatch = text && text.match(/\b(\d{6})\b/);
  const otp = otpMatch ? otpMatch[1] : undefined;
  console.log('[EMAIL][stub-send]', JSON.stringify({ to, subject, text, otp, ts }));
  return { ok: true, to, subject, otp, ts };
}

module.exports = { sendEmail };