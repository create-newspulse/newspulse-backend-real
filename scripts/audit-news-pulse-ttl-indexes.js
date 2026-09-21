const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { auditNewsPulseTtlIndexes } = require('../lib/newsPulseTtlIndexes');

async function main() {
  const mongoUri = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  if (!mongoUri) throw new Error('MONGODB_URI is required');

  await mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 10_000,
  });

  const report = await auditNewsPulseTtlIndexes(mongoose.connection.db);
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error('[news-pulse-ttl-audit] failed', { message: error?.message || String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await mongoose.disconnect(); } catch (_) {}
  });