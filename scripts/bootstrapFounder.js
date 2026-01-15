// One-time helper script to bootstrap/reset the founder account in production.
//
// Usage (PowerShell):
//   $env:BASE_URL='https://newspulse-backend-real.onrender.com'
//   $env:OWNER_KEY='...your OWNER_BOOTSTRAP_KEY...'
//   $env:FOUNDER_EMAIL='founder@yourdomain.com'
//   $env:FOUNDER_PASSWORD='StrongPass123!'
//   $env:FOUNDER_NAME='Your Name'
//   node scripts/bootstrapFounder.js

const baseUrl = String(process.env.BASE_URL || '').trim() || 'http://localhost:5000';
const ownerKey = String(process.env.OWNER_KEY || process.env.OWNER_BOOTSTRAP_KEY || '').trim();

const email = String(process.env.FOUNDER_EMAIL || process.env.ADMIN_EMAIL || '').trim();
const password = String(process.env.FOUNDER_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const fullName = String(process.env.FOUNDER_NAME || 'Founder').trim();

async function main() {
  if (!ownerKey) {
    console.error('Missing OWNER_KEY (or OWNER_BOOTSTRAP_KEY) env var');
    process.exit(1);
  }
  if (!email || !password) {
    console.error('Missing FOUNDER_EMAIL/FOUNDER_PASSWORD (or ADMIN_EMAIL/ADMIN_PASSWORD) env vars');
    process.exit(1);
  }

  const url = baseUrl.replace(/\/$/, '') + '/api/admin/bootstrap-founder';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-owner-key': ownerKey,
    },
    body: JSON.stringify({ email, password, fullName }),
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }

  if (!res.ok) {
    console.error('Bootstrap failed:', res.status, json);
    process.exit(1);
  }

  console.log('Bootstrap ok:', json);
}

main().catch((e) => {
  console.error('Bootstrap error:', e?.message || e);
  process.exit(1);
});
