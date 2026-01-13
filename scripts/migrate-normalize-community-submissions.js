/**
 * Migration: Normalize legacy CommunitySubmission documents
 * - Ensures required fields exist: reporterName, reporterEmail, category, headline, body
 * - Fills from fallbacks when possible (contact/name/email etc.)
 * - Does NOT modify story content except to set minimal placeholders if absolutely missing
 *
 * Usage:
 *   MONGODB_URI="mongodb+srv://..." node scripts/migrate-normalize-community-submissions.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const CommunitySubmission = require('../models/CommunitySubmission');

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri || uri === 'YOUR_MONGO_URI_HERE') {
    console.error('MONGODB_URI (or legacy MONGO_URI) not set. Aborting migration.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');

  const cursor = CommunitySubmission.find({}).cursor();
  let scanned = 0;
  let updated = 0;
  for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
    scanned += 1;
    let changed = false;

    const fallbackName = (doc.contact && doc.contact.name) || doc.userName || doc.name || doc.reporterName || null;
    const fallbackEmail = (doc.contact && doc.contact.email) || doc.email || doc.reporterEmail || null;

    if (!doc.reporterName) {
      if (fallbackName) {
        doc.reporterName = String(fallbackName).trim();
        changed = true;
      } else {
        doc.reporterName = 'Unknown reporter';
        changed = true;
      }
    }

    if (!doc.reporterEmail) {
      if (fallbackEmail) {
        doc.reporterEmail = String(fallbackEmail).trim().toLowerCase();
        changed = true;
      } else {
        // Use a safe invalid email placeholder to satisfy required constraint
        doc.reporterEmail = 'unknown@invalid.local';
        changed = true;
      }
    }

    if (!doc.category) {
      doc.category = 'general';
      changed = true;
    }
    if (!doc.headline) {
      doc.headline = 'Untitled submission';
      changed = true;
    }
    if (!doc.body) {
      // Preserve any alternate story field if present
      const bodyFallback = doc.story || null;
      doc.body = bodyFallback ? String(bodyFallback) : 'No content provided.';
      changed = true;
    }

    // Normalize status values to known set if present
    if (doc.status && typeof doc.status === 'string') {
      const s = doc.status.trim();
      const map = new Map([
        ['pending', 'under_review'],
        ['PENDING', 'under_review'],
        ['PENDING_FOUNDER', 'under_review'],
        ['under_review', 'under_review'],
        ['approved', 'APPROVED'],
        ['APPROVED', 'APPROVED'],
        ['rejected', 'REJECTED'],
        ['REJECTED', 'REJECTED'],
      ]);
      if (map.has(s) && map.get(s) !== s) {
        doc.status = map.get(s);
        changed = true;
      }
    }

    if (changed) {
      try {
        await doc.save();
        updated += 1;
        if (updated % 50 === 0) {
          console.log(`Updated ${updated} / Scanned ${scanned}`);
        }
      } catch (e) {
        console.warn('Save failed, applying minimal $set update:', e.message || e);
        const setObj = {
          reporterName: doc.reporterName,
          reporterEmail: doc.reporterEmail,
          category: doc.category,
          headline: doc.headline,
          body: doc.body,
          status: doc.status,
        };
        await CommunitySubmission.updateOne({ _id: doc._id }, { $set: setObj });
        updated += 1;
      }
    }
  }

  console.log(`Migration complete. Scanned=${scanned}, Updated=${updated}`);
  await mongoose.disconnect();
}

run().catch(async (e) => {
  console.error('Migration failed:', e?.message || e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
