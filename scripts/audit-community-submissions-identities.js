/**
 * Audit: CommunitySubmission identity completeness & uniqueness
 *
 * Prints:
 * - total submissions
 * - distinct reporter emails (raw) + distinct identity emails (placeholder-filtered)
 * - distinct phones (normalized)
 * - distinct normalized names
 * - missing counts for email/phone/name/location
 *
 * Usage:
 *   MONGODB_URI="..." node scripts/audit-community-submissions-identities.js
 *   MONGODB_URI="..." node scripts/audit-community-submissions-identities.js --limit=20000
 */

require('dotenv').config();

const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const {
  normalizeEmailForIdentity,
  normalizePhoneForIdentity,
  normalizePersonNameKey,
  parseLooseLocationString,
  isPlaceholderEmail,
} = require('../lib/identity');

function parseArgs(argv) {
  const out = { limit: 0 };
  for (const raw of argv) {
    const a = String(raw || '').trim();
    if (!a) continue;
    if (a.startsWith('--limit=')) out.limit = Math.max(parseInt(a.split('=')[1] || '0', 10) || 0, 0);
  }
  return out;
}

function pickRawEmail(sub) {
  return (
    sub?.reporterEmailNorm ||
    sub?.reporterEmail ||
    sub?.email ||
    sub?.contact?.email ||
    null
  );
}

function pickRawPhone(sub) {
  return (
    sub?.contact?.phone ||
    sub?.contact?.whatsappNumber ||
    sub?.phone ||
    sub?.phoneNumber ||
    null
  );
}

function pickName(sub) {
  return sub?.reporterName || sub?.name || sub?.contact?.name || sub?.userName || null;
}

function pickLocation(sub) {
  const loc = sub?.locationDetail || sub?.location || null;
  if (loc && typeof loc === 'object') {
    const city = loc.city ? String(loc.city).trim() : '';
    const state = (loc.state || loc.stateProvince) ? String(loc.state || loc.stateProvince).trim() : '';
    const country = loc.country ? String(loc.country).trim() : '';
    if (city || state || country) return { city: city || null, state: state || null, country: country || null };
  }

  const city = sub?.city ? String(sub.city).trim() : '';
  const state = sub?.state ? String(sub.state).trim() : '';
  const country = sub?.country ? String(sub.country).trim() : '';
  if (city || state || country) return { city: city || null, state: state || null, country: country || null };

  if (sub?.reporterLocation) return parseLooseLocationString(sub.reporterLocation);
  return { city: null, state: null, country: null };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    console.error('MONGODB_URI (or legacy MONGO_URI) not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const cursor = CommunitySubmission.find({ isDeleted: { $ne: true } })
    .sort({ _id: 1 })
    .select('reporterEmail reporterEmailNorm email reporterName name userName reporterLocation city state country contact location locationDetail createdAt')
    .lean()
    .cursor();

  const emailsRaw = new Set();
  const emailsIdentity = new Set();
  const phones = new Set();
  const names = new Set();

  let scanned = 0;
  let missingEmail = 0;
  let missingPhone = 0;
  let missingName = 0;
  let missingLocation = 0;
  let placeholderEmailCount = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned += 1;
    if (args.limit && scanned > args.limit) break;

    const rawEmail = pickRawEmail(doc);
    const rawEmailNorm = rawEmail ? String(rawEmail).trim().toLowerCase() : null;
    if (rawEmailNorm) {
      emailsRaw.add(rawEmailNorm);
      if (isPlaceholderEmail(rawEmailNorm)) placeholderEmailCount += 1;
    }

    const emailId = normalizeEmailForIdentity(rawEmailNorm);
    if (emailId) emailsIdentity.add(emailId);

    const phoneId = normalizePhoneForIdentity(pickRawPhone(doc));
    if (phoneId) phones.add(phoneId);

    const nameKey = normalizePersonNameKey(pickName(doc));
    if (nameKey) names.add(nameKey);

    const loc = pickLocation(doc);
    const hasLoc = !!(String(loc?.city || '').trim() || String(loc?.state || '').trim() || String(loc?.country || '').trim());

    if (!emailId) missingEmail += 1;
    if (!phoneId) missingPhone += 1;
    if (!nameKey) missingName += 1;
    if (!hasLoc) missingLocation += 1;
  }

  const totalInDb = await CommunitySubmission.countDocuments({ isDeleted: { $ne: true } });

  console.log(
    JSON.stringify(
      {
        totalSubmissions: totalInDb,
        scanned,
        distinctReporterEmailsRaw: emailsRaw.size,
        distinctIdentityEmails: emailsIdentity.size,
        distinctPhones: phones.size,
        distinctNormalizedNames: names.size,
        missing: {
          email: missingEmail,
          phone: missingPhone,
          name: missingName,
          location: missingLocation,
        },
        placeholder: {
          submissionsWithPlaceholderEmail: placeholderEmailCount,
        },
        note: 'distinctIdentityEmails excludes placeholder/no-reply/example domains; identity matching uses email->phone->name+city/state.',
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error('Audit failed:', e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
