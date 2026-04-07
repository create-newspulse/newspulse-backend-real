const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(process.cwd(), '.env') });

const ReporterContact = require('../models/ReporterContact');

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function hasExplicitRemoval(contact) {
  if (!contact || typeof contact !== 'object') return false;
  if (contact.archivedAt || contact.deletedAt) return true;
  if (contact.archivedBy !== undefined && contact.archivedBy !== null) return true;
  if (contact.deletedBy !== undefined && contact.deletedBy !== null) return true;
  return false;
}

function resolveDirectoryStatus(contact) {
  const explicit = normalizeToken(contact && contact.directoryStatus);
  if (explicit === 'active' || explicit === 'removed') return explicit;
  return hasExplicitRemoval(contact) ? 'removed' : 'active';
}

async function main() {
  const write = process.argv.includes('--write');
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    throw new Error('Missing MONGODB_URI (or legacy MONGO_URI)');
  }

  await mongoose.connect(uri);

  const contacts = await ReporterContact.find({}).select({
    _id: 1,
    email: 1,
    status: 1,
    directoryStatus: 1,
    archivedAt: 1,
    archivedBy: 1,
    deletedAt: 1,
    deletedBy: 1,
    restoredAt: 1,
  }).lean();

  const updates = [];
  const sample = [];
  const summary = {
    total: contacts.length,
    currentActive: 0,
    currentRemoved: 0,
    currentOther: 0,
    targetActive: 0,
    targetRemoved: 0,
    wrongRemovedToActive: 0,
    missingOrInvalidToActive: 0,
    legacyExplicitRemoved: 0,
    totalUpdates: 0,
  };

  for (const contact of contacts) {
    const current = normalizeToken(contact.directoryStatus);
    const target = resolveDirectoryStatus(contact);

    if (current === 'active') summary.currentActive += 1;
    else if (current === 'removed') summary.currentRemoved += 1;
    else summary.currentOther += 1;

    if (target === 'active') summary.targetActive += 1;
    else summary.targetRemoved += 1;

    if (current === target) continue;

    if (current === 'removed' && target === 'active') summary.wrongRemovedToActive += 1;
    if ((!current || (current !== 'active' && current !== 'removed')) && target === 'active') summary.missingOrInvalidToActive += 1;
    if ((!current || (current !== 'active' && current !== 'removed')) && target === 'removed') summary.legacyExplicitRemoved += 1;

    const item = {
      id: String(contact._id),
      email: String(contact.email || '').trim().toLowerCase() || null,
      from: current || null,
      to: target,
      status: normalizeToken(contact.status),
      hasExplicitRemoval: hasExplicitRemoval(contact),
    };
    updates.push(item);
    if (sample.length < 25) sample.push(item);
  }

  summary.totalUpdates = updates.length;

  if (write && updates.length) {
    await ReporterContact.bulkWrite(
      updates.map((item) => ({
        updateOne: {
          filter: { _id: item.id },
          update: { $set: { directoryStatus: item.to } },
        },
      }))
    );
  }

  console.log(JSON.stringify({ write, summary, sample }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});