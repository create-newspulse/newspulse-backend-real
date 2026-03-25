/**
 * Repair/Backfill: Community Reporter identity normalization
 * - Scans CommunitySubmission documents
 * - Upserts ReporterContact (email-keyed) when possible
 * - Backfills submission.reporterId from the upserted contact id (best-effort)
 * - Resolves/attaches ReporterProfile identity (reporterProfileId)
 * - Recomputes ReporterProfile story stats from linked submissions
 *
 * Safe by default: does NOT write unless you pass --write
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node scripts/repair-community-reporter-identities.js --write
 *   MONGODB_URI="..." node scripts/repair-community-reporter-identities.js --write --only-missing --limit=500
 */

require('dotenv').config();

const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');
const { upsertReporterContactFromSubmission } = require('../services/reporterContactService');
const {
  resolveAndAttachForSubmission,
  recomputeReporterProfileStoryStats,
} = require('../services/reporterIdentityResolution.service');

function parseArgs(argv) {
  const out = {
    write: false,
    onlyMissing: false,
    force: false,
    forceIfPlaceholder: false,
    limit: 0,
    since: null,
    until: null,
  };

  for (const raw of argv) {
    const a = String(raw || '').trim();
    if (!a) continue;

    if (a === '--write') out.write = true;
    else if (a === '--dry-run') out.write = false;
    else if (a === '--only-missing') out.onlyMissing = true;
    else if (a === '--force') out.force = true;
    else if (a === '--force-if-placeholder') out.forceIfPlaceholder = true;
    else if (a.startsWith('--limit=')) out.limit = Math.max(parseInt(a.split('=')[1] || '0', 10) || 0, 0);
    else if (a.startsWith('--since=')) {
      const d = new Date(a.split('=')[1]);
      out.since = isNaN(d.getTime()) ? null : d;
    } else if (a.startsWith('--until=')) {
      const d = new Date(a.split('=')[1]);
      out.until = isNaN(d.getTime()) ? null : d;
    }
  }

  return out;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    console.error('MONGODB_URI (or legacy MONGO_URI) not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
  console.log(
    JSON.stringify(
      {
        mode: args.write ? 'write' : 'dry-run',
        onlyMissing: args.onlyMissing,
        force: args.force,
        forceIfPlaceholder: args.forceIfPlaceholder,
        limit: args.limit || null,
        since: args.since ? args.since.toISOString() : null,
        until: args.until ? args.until.toISOString() : null,
      },
      null,
      2
    )
  );

  const filter = { isDeleted: { $ne: true } };
  if (args.since || args.until) {
    filter.createdAt = {};
    if (args.since) filter.createdAt.$gte = args.since;
    if (args.until) filter.createdAt.$lte = args.until;
  }

  const cursor = CommunitySubmission.find(filter).sort({ _id: 1 }).lean().cursor();

  let scanned = 0;
  let considered = 0;
  let wouldProcess = 0;
  let processed = 0;

  let contactUpserts = 0;
  let reporterIdBackfills = 0;
  let profileLinksOk = 0;
  let profileLinksSkipped = 0;
  let profileLinksFailed = 0;
  let statsRecomputed = 0;

  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned += 1;

    if (args.onlyMissing && doc.reporterProfileId) {
      continue;
    }

    considered += 1;
    if (args.limit && considered > args.limit) break;

    if (!args.write) {
      wouldProcess += 1;
      if (wouldProcess % 200 === 0) {
        console.log(`Dry-run progress: scanned=${scanned}, wouldProcess=${wouldProcess}`);
      }
      continue;
    }

    processed += 1;

    // 1) Upsert contact (email-keyed) when possible
    let contactId = null;
    try {
      const out = await upsertReporterContactFromSubmission(doc);
      if (out && out.contactId) {
        contactUpserts += 1;
        contactId = String(out.contactId);
      }
    } catch (e) {
      // best-effort
    }

    // 2) Backfill reporterId on submission if missing
    if (!doc.reporterId && contactId && mongoose.isValidObjectId(contactId)) {
      try {
        const write = await CommunitySubmission.updateOne(
          { _id: doc._id, reporterId: { $in: [null, undefined, ''] } },
          { $set: { reporterId: new mongoose.Types.ObjectId(contactId) } }
        );
        if (write && (write.modifiedCount || write.nModified)) reporterIdBackfills += 1;
        doc.reporterId = contactId;
      } catch (_) {}
    }

    // 3) Resolve + attach reporter profile
    try {
      const r = await resolveAndAttachForSubmission(doc, { force: args.force, forceIfPlaceholder: args.forceIfPlaceholder });
      if (r && r.ok) {
        if (r.skipped) profileLinksSkipped += 1;
        else profileLinksOk += 1;

        const pid = r.profileId;
        if (pid) {
          try {
            await recomputeReporterProfileStoryStats(pid, { reason: 'backfill-script' });
            statsRecomputed += 1;
          } catch (_) {}
        }
      } else {
        profileLinksFailed += 1;
      }
    } catch (_) {
      profileLinksFailed += 1;
    }

    if (processed % 50 === 0) {
      console.log(
        `Progress: processed=${processed}, scanned=${scanned}, upserts=${contactUpserts}, backfills=${reporterIdBackfills}, linksOk=${profileLinksOk}, skipped=${profileLinksSkipped}, failed=${profileLinksFailed}`
      );
    }
  }

  console.log(
    JSON.stringify(
      {
        scanned,
        considered,
        mode: args.write ? 'write' : 'dry-run',
        wouldProcess: args.write ? null : wouldProcess,
        processed: args.write ? processed : null,
        contactUpserts,
        reporterIdBackfills,
        profileLinksOk,
        profileLinksSkipped,
        profileLinksFailed,
        statsRecomputed,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error('Backfill failed:', e?.message || e);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});
