/*
Backfill/normalize regional geo fields so state pages (e.g. Gujarat) never show an empty feed
just because legacy stories are missing geo/tags or stored state in a non-canonical form.

What it does (best-effort, idempotent):
- Normalizes News.location.state/stateSlug using India state aliases (English/Hindi/Gujarati).
- Ensures News.geo.state is the canonical state slug when possible.
- Ensures state:/district:/city: tags exist for regional stories (additive; never removes tags).
- Ensures location slugs (districtSlug/citySlug) are aligned with location names.
- Re-syncs the public Article copy via syncPublicArticleFromNews.

Usage:
  MONGODB_URI="..." node scripts/backfill-regional-geo.js

Optional flags:
  --dry-run=1        : do not write, just report counts
  --limit=500        : max docs to process (0/omit = no limit)
  --state=gujarat    : only process docs that appear to belong to this state (best-effort)

Notes:
- This script only targets published regional News docs.
- Safe to run multiple times.
*/

require('dotenv').config();
const mongoose = require('mongoose');

const News = require('../models/News');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { INDIA_STATES_UTS, isValidStateSlug } = require('../src/utils/locationTagger');
const { slugifyUnicode } = require('../lib/slug');

function parseArgs(argv) {
  const out = {};
  for (const a0 of argv.slice(2)) {
    const a = String(a0 || '').trim();
    if (!a.startsWith('--')) continue;
    const idx = a.indexOf('=');
    const k = (idx >= 0 ? a.slice(2, idx) : a.slice(2)).trim();
    const v = (idx >= 0 ? a.slice(idx + 1) : '1').trim();
    if (!k) continue;
    out[k] = v;
  }
  return out;
}

function isTruthy(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'on';
}

const STATE_SLUG_TO_DISPLAY = (() => {
  const m = new Map();
  for (const it of Array.isArray(INDIA_STATES_UTS) ? INDIA_STATES_UTS : []) {
    const slug = String(it?.slug || '').trim().toLowerCase();
    const display = String(it?.display || '').trim();
    if (slug && display) m.set(slug, display);
  }
  return m;
})();

const STATE_ALIAS_SLUG_TO_CANON = (() => {
  const m = new Map();
  for (const it of Array.isArray(INDIA_STATES_UTS) ? INDIA_STATES_UTS : []) {
    const canon = String(it?.slug || '').trim().toLowerCase();
    if (!canon) continue;
    m.set(canon, canon);
    const aliases = Array.isArray(it?.aliases) ? it.aliases : [];
    for (const a of aliases) {
      const as = slugifyUnicode(String(a || ''), { maxLength: 80 });
      if (as) m.set(as, canon);
    }
  }
  // Legacy abbreviation.
  m.set('gj', 'gujarat');
  return m;
})();

function canonicalStateSlugFromAny(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const slug = slugifyUnicode(raw, { maxLength: 80 });
  if (!slug) return null;
  if (isValidStateSlug(slug)) return slug;
  const mapped = STATE_ALIAS_SLUG_TO_CANON.get(slug);
  return mapped && isValidStateSlug(mapped) ? mapped : null;
}

function extractTagValue(tags, prefix) {
  const arr = Array.isArray(tags) ? tags : [];
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return null;

  for (const t0 of arr) {
    const t = typeof t0 === 'string' ? t0.trim() : '';
    if (!t) continue;
    const idx = t.indexOf(':');
    if (idx <= 0) continue;
    const k = t.slice(0, idx).trim().toLowerCase();
    if (k !== p) continue;
    const v = t.slice(idx + 1).trim();
    if (v) return v;
  }
  return null;
}

function mergeTags(tagsArr, additions) {
  const tags = Array.isArray(tagsArr) ? tagsArr.filter((t) => typeof t === 'string' && t.trim()) : [];
  const out = [];
  const seen = new Set();

  const add = (t) => {
    const s = String(t || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };

  for (const t of tags) add(t);
  for (const t of additions) add(t);

  return out;
}

function bestEffortStateFromDoc(doc) {
  const loc = doc?.location && typeof doc.location === 'object' ? doc.location : null;
  const fromLoc = loc?.stateSlug || loc?.state || null;
  const fromGeo = doc?.geo && typeof doc.geo === 'object' ? (doc.geo.state || null) : null;
  const fromTag = extractTagValue(doc?.tags, 'state');
  return fromLoc || fromGeo || fromTag || null;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = isTruthy(args['dry-run'] ?? args.dryRun);
  const limit = Math.max(parseInt(String(args.limit || '0'), 10) || 0, 0);
  const stateFilter = String(args.state || '').trim().toLowerCase();

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI (or legacy MONGO_URI) is required');

  await mongoose.connect(uri);

  const q = {
    status: 'published',
    category: 'regional',
  };

  const cursor = News.find(q)
    .sort({ publishedAt: -1, createdAt: -1 })
    .cursor();

  let scanned = 0;
  let updated = 0;
  let synced = 0;
  let skipped = 0;
  let failed = 0;

  for await (const doc of cursor) {
    scanned += 1;
    if (limit && scanned > limit) break;

    try {
      if (!doc.location || typeof doc.location !== 'object') doc.location = {};
      if (!doc.geo || typeof doc.geo !== 'object') doc.geo = {};

      const rawState = bestEffortStateFromDoc(doc);
      const canonStateSlug = canonicalStateSlugFromAny(rawState);

      if (stateFilter) {
        const canonFilter = canonicalStateSlugFromAny(stateFilter) || stateFilter;
        if (canonStateSlug && canonStateSlug !== canonFilter) {
          skipped += 1;
          continue;
        }
        if (!canonStateSlug) {
          skipped += 1;
          continue;
        }
      }

      const before = {
        state: doc.location.state ?? null,
        stateSlug: doc.location.stateSlug ?? null,
        district: doc.location.district ?? null,
        districtSlug: doc.location.districtSlug ?? null,
        city: doc.location.city ?? null,
        citySlug: doc.location.citySlug ?? null,
        geoState: doc.geo.state ?? null,
        geoDistrict: doc.geo.district ?? null,
        geoCity: doc.geo.city ?? null,
      };

      if (canonStateSlug) {
        const display = STATE_SLUG_TO_DISPLAY.get(canonStateSlug) || null;
        if (display && String(doc.location.state || '').trim().toLowerCase() !== display.toLowerCase()) {
          doc.location.state = display;
        }
        doc.location.stateSlug = canonStateSlug;
        doc.geo.state = canonStateSlug;
      }

      // Keep district/city slugs aligned with names (no canonicalization beyond slugify).
      if (doc.location.district && (!doc.location.districtSlug || doc.isModified('location.district'))) {
        doc.location.districtSlug = slugifyUnicode(String(doc.location.district), { maxLength: 80 }) || null;
      }
      if (doc.location.city && (!doc.location.citySlug || doc.isModified('location.city'))) {
        doc.location.citySlug = slugifyUnicode(String(doc.location.city), { maxLength: 80 }) || null;
      }

      if (doc.location.districtSlug) doc.geo.district = doc.location.districtSlug;
      if (doc.location.citySlug) doc.geo.city = doc.location.citySlug;

      // Ensure additive location tags.
      const additions = [];
      if (canonStateSlug) additions.push(`state:${canonStateSlug}`);
      if (doc.location.districtSlug) additions.push(`district:${doc.location.districtSlug}`);
      if (doc.location.citySlug) additions.push(`city:${doc.location.citySlug}`);
      if (additions.length) doc.tags = mergeTags(doc.tags, additions);

      const after = {
        state: doc.location.state ?? null,
        stateSlug: doc.location.stateSlug ?? null,
        district: doc.location.district ?? null,
        districtSlug: doc.location.districtSlug ?? null,
        city: doc.location.city ?? null,
        citySlug: doc.location.citySlug ?? null,
        geoState: doc.geo.state ?? null,
        geoDistrict: doc.geo.district ?? null,
        geoCity: doc.geo.city ?? null,
      };

      const changed = JSON.stringify(before) !== JSON.stringify(after) || doc.isModified();
      if (!changed) {
        skipped += 1;
        continue;
      }

      if (dryRun) {
        updated += 1;
        continue;
      }

      await doc.save();
      updated += 1;

      const pub = await syncPublicArticleFromNews(doc, { logger: console });
      if (pub) synced += 1;

      if (updated % 50 === 0) {
        console.log('[backfill-regional-geo] progress', { scanned, updated, synced, skipped, failed });
      }
    } catch (e) {
      failed += 1;
      console.error('[backfill-regional-geo] doc failed', {
        id: doc?._id ? String(doc._id) : null,
        slug: doc?.slug || null,
        message: e?.message || String(e),
      });
    }
  }

  console.log('[backfill-regional-geo] done', { scanned, updated, synced, skipped, failed, dryRun, limit, state: stateFilter || null });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[backfill-regional-geo] failed', err?.message || err);
  process.exitCode = 1;
});
