const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { repairNewsPulseTtlIndexes } = require('../lib/newsPulseTtlIndexes');

function parseArgs(argv) {
  const args = new Set((argv || []).slice(2));
  return { apply: args.has('--apply') };
}

async function main() {
  const options = parseArgs(process.argv);
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  if (!mongoUri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10_000,
  });

  const result = await repairNewsPulseTtlIndexes(mongoose.connection.db, { apply: options.apply });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error('[news-pulse-ttl-repair] failed', { message: error?.message || String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });