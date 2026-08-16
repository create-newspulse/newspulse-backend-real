const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const { cleanupNonDeliverablePushRegistrations } = require('../services/pushRegistrationCleanup');

function parseCleanupArgs(argv = process.argv.slice(2)) {
  const confirm = argv.includes('--confirm');
  const dryRun = !confirm || argv.includes('--dry-run');
  return { confirm, dryRun };
}

async function main(argv = process.argv.slice(2)) {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('Missing MONGODB_URI (or legacy MONGO_URI). Aborting push registration cleanup.');

  const args = parseCleanupArgs(argv);
  await mongoose.connect(mongoUri);
  const result = await cleanupNonDeliverablePushRegistrations({ dryRun: args.dryRun });
  console.log(JSON.stringify({
    ok: result.ok,
    dryRun: result.dryRun,
    confirm: args.confirm,
    retentionDays: result.retentionDays,
    cutoff: result.cutoff.toISOString(),
    eligibleCount: result.eligibleCount,
    deletedCount: result.deletedCount,
  }, null, 2));
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('[cleanup:push-registrations] failed:', error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await mongoose.disconnect().catch(() => {});
    });
}

module.exports = { parseCleanupArgs, main };