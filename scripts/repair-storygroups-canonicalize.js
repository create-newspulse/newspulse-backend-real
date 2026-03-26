/*
Repair/backfill canonical story-group linkage for Public Articles.

Why:
- Some recent publishes can accidentally create multiple Article docs per story group (often one per locale),
  leading to inconsistent feeds across /latest, /national, /hi/*, /gu/*.
- Public surfaces must select ONE canonical story group and then resolve the requested locale variant.

What it does (best-effort, idempotent; writes only when --apply=1):
- Groups published Article docs by storyGroupId = translationGroupId || translationKey || _id.
- Chooses a canonical doc per group (prefers _id === storyGroupId, else newest publishedAt).
- Merges localized text into the canonical doc's i18n buckets (title/summary/content) when missing.
- Backfills slugs.<lang> for merged locales.
- If a locale has complete text, marks translationStatus.<lang> as ready when it was pending/failed.
- Archives stale duplicate docs (status=draft, publishedAt=null) when --archive-stale=1.

Usage:
  MONGODB_URI="..." node scripts/repair-storygroups-canonicalize.js --days=7 --dry-run=1
  MONGODB_URI="..." node scripts/repair-storygroups-canonicalize.js --days=30 --apply=1 --archive-stale=1

Flags:
  --dry-run=1           : default; no writes
  --apply=1             : perform writes
  --days=7              : only consider docs published/created within last N days (0 = all)
  --limit-groups=200    : max groups to process (0 = all)
  --archive-stale=1     : mark non-canonical duplicates as draft (recommended)
  --delete-stale=1      : delete non-canonical duplicates (dangerous; implies archive-stale=0)

Notes:
- This script only targets the public Article collection (models/Article.js).
- It does NOT modify News docs directly.
*/

require('dotenv').config();
const mongoose = require('mongoose');

const Article = require('../models/Article');
const { getStoryGroupId } = require('../services/publicStoryLocale.service');
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

function pickNonEmpty(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      const s = v.trim();
      if (s) return s;
      continue;
    }
    return v;
  }
  return null;
}

function hasFullTextBucket(b) {
  const title = typeof b?.title === 'string' ? b.title.trim() : '';
  const summary = typeof b?.summary === 'string' ? b.summary.trim() : '';
  const content = typeof b?.content === 'string' ? b.content.trim() : '';
  return Boolean(title && summary && content);
}

function hasFullI18nBucket(doc, lang) {
  const title = typeof doc?.i18n?.title?.[lang] === 'string' ? doc.i18n.title[lang].trim() : '';
  const summary = typeof doc?.i18n?.summary?.[lang] === 'string' ? doc.i18n.summary[lang].trim() : '';
  const content = typeof doc?.i18n?.content?.[lang] === 'string' ? doc.i18n.content[lang].trim() : '';
  return Boolean(title && summary && content);
}

function extractVariant(doc, lang) {
  // Prefer i18n buckets.
  if (hasFullI18nBucket(doc, lang)) {
    return {
      title: String(doc.i18n.title[lang]),
      summary: String(doc.i18n.summary[lang]),
      content: String(doc.i18n.content[lang]),
      source: 'i18n',
    };
  }

  // If this doc is authored in lang, use base fields.
  const base = String(doc?.originalLang || doc?.language || doc?.lang || '').trim().toLowerCase();
  if (base === lang) {
    const title = typeof doc?.title === 'string' ? doc.title.trim() : '';
    const summary = typeof doc?.summary === 'string' ? doc.summary.trim() : '';
    const content = typeof doc?.content === 'string' ? doc.content.trim() : '';
    if (title && summary && content) {
      return { title: String(doc.title), summary: String(doc.summary), content: String(doc.content), source: 'original' };
    }
  }

  // Fallback to translation buckets.
  const bucket = doc?.translations?.[lang];
  if (hasFullTextBucket(bucket)) {
    const status = String(doc?.translationStatus?.[lang] || '').trim().toLowerCase();
    // Allow missing/null status when bucket is complete.
    if (!status || status === 'ready' || status === 'pending' || status === 'failed') {
      return {
        title: String(bucket.title),
        summary: String(bucket.summary),
        content: String(bucket.content),
        source: status === 'ready' ? 'translation_ready' : 'translation_bucket',
      };
    }
  }

  return null;
}

function chooseCanonicalDoc(groupId, docs) {
  const gid = String(groupId || '').trim();
  if (!gid) return docs[0] || null;

  const byId = docs.find((d) => String(d?._id || '') === gid);
  if (byId) return byId;

  // Prefer newest publishedAt; fallback to createdAt.
  return (docs || []).slice().sort((a, b) => {
    const at = a?.publishedAt ? new Date(a.publishedAt).getTime() : (a?.createdAt ? new Date(a.createdAt).getTime() : 0);
    const bt = b?.publishedAt ? new Date(b.publishedAt).getTime() : (b?.createdAt ? new Date(b.createdAt).getTime() : 0);
    return bt - at;
  })[0] || null;
}

async function main() {
  const args = parseArgs(process.argv);

  const uri = String(process.env.MONGODB_URI || '').trim();
  const dbName = String(process.env.MONGODB_DBNAME || '').trim() || undefined;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  const apply = isTruthy(args.apply);
  const dryRun = !apply || isTruthy(args['dry-run']);
  const days = Math.max(parseInt(args.days || '7', 10) || 0, 0);
  const limitGroups = Math.max(parseInt(args['limit-groups'] || '0', 10) || 0, 0);
  const archiveStale = isTruthy(args['archive-stale']);
  const deleteStale = isTruthy(args['delete-stale']);

  if (deleteStale && archiveStale) {
    console.warn('Both --delete-stale and --archive-stale set; delete will win.');
  }

  const now = new Date();
  const since = days > 0 ? new Date(now.getTime() - days * 24 * 60 * 60 * 1000) : null;

  await mongoose.connect(uri, { dbName });

  const baseFilter = { status: 'published' };
  if (since) {
    baseFilter.$or = [
      { publishedAt: { $gte: since } },
      { createdAt: { $gte: since } },
      { updatedAt: { $gte: since } },
    ];
  }

  const select = [
    'title',
    'summary',
    'content',
    'slug',
    'slugs',
    'i18n',
    'translations',
    'translationStatus',
    'translationKey',
    'translationGroupId',
    'language',
    'originalLang',
    'category',
    'tags',
    'publishedAt',
    'createdAt',
    'updatedAt',
    'status',
    'coverImage',
    'sourceNewsId',
  ].join(' ');

  const docs = await Article.find(baseFilter).select(select).sort({ publishedAt: -1, createdAt: -1 }).lean();

  const groups = new Map();
  for (const d of docs) {
    const gid = getStoryGroupId(d);
    if (!gid) continue;
    const arr = groups.get(gid) || [];
    arr.push(d);
    groups.set(gid, arr);
  }

  const multi = Array.from(groups.entries()).filter(([, arr]) => (arr || []).length > 1);
  const limited = limitGroups > 0 ? multi.slice(0, limitGroups) : multi;

  console.log('[repair-storygroups] scannedDocs=', docs.length, 'multiGroups=', multi.length, 'processing=', limited.length);
  console.log('[repair-storygroups] mode=', dryRun ? 'DRY_RUN' : 'APPLY', 'days=', days || 0, 'archiveStale=', archiveStale, 'deleteStale=', deleteStale);

  let updatedCanon = 0;
  let archived = 0;
  let deleted = 0;
  let groupsChanged = 0;

  for (const [groupId, arr] of limited) {
    const docsInGroup = (arr || []).slice();
    const canonicalLean = chooseCanonicalDoc(groupId, docsInGroup);
    if (!canonicalLean) continue;

    const canonicalId = String(canonicalLean._id);
    const stale = docsInGroup.filter((d) => String(d._id) !== canonicalId);

    const variants = {};
    for (const lang of ['en', 'hi', 'gu']) {
      for (const d of docsInGroup) {
        const v = extractVariant(d, lang);
        if (!v) continue;
        // Prefer i18n/original over translation buckets.
        const score = v.source === 'i18n' ? 3 : (v.source === 'original' ? 2 : 1);
        const prev = variants[lang];
        const prevScore = prev ? prev.score : 0;
        if (!prev || score > prevScore) variants[lang] = { ...v, score };
      }
    }

    const canonDoc = await Article.findById(canonicalId);
    if (!canonDoc) continue;

    let changed = false;

    // Ensure grouping keys exist and are consistent.
    const g = String(groupId);
    if (!canonDoc.translationKey) {
      canonDoc.translationKey = g;
      changed = true;
    }
    if (!canonDoc.translationGroupId) {
      canonDoc.translationGroupId = g;
      changed = true;
    }

    canonDoc.i18n = canonDoc.i18n && typeof canonDoc.i18n === 'object' ? canonDoc.i18n : {};
    canonDoc.i18n.title = canonDoc.i18n.title && typeof canonDoc.i18n.title === 'object' ? canonDoc.i18n.title : {};
    canonDoc.i18n.summary = canonDoc.i18n.summary && typeof canonDoc.i18n.summary === 'object' ? canonDoc.i18n.summary : {};
    canonDoc.i18n.content = canonDoc.i18n.content && typeof canonDoc.i18n.content === 'object' ? canonDoc.i18n.content : {};

    canonDoc.translationStatus = canonDoc.translationStatus && typeof canonDoc.translationStatus === 'object' ? canonDoc.translationStatus : {};

    canonDoc.slugs = canonDoc.slugs && typeof canonDoc.slugs === 'object' ? canonDoc.slugs : {};

    for (const lang of ['en', 'hi', 'gu']) {
      const v = variants[lang];
      if (!v) continue;

      const hasI18n = hasFullI18nBucket(canonDoc, lang);
      if (!hasI18n) {
        canonDoc.i18n.title[lang] = String(v.title);
        canonDoc.i18n.summary[lang] = String(v.summary);
        canonDoc.i18n.content[lang] = String(v.content);
        changed = true;
      }

      // Backfill per-locale slug.
      const titleForSlug = String(canonDoc.i18n.title[lang] || '').trim();
      if (titleForSlug && (!canonDoc.slugs[lang] || !String(canonDoc.slugs[lang]).trim())) {
        canonDoc.slugs[lang] = slugifyUnicode(titleForSlug);
        changed = true;
      }

      // If full text exists, make status ready.
      const nowStatus = String(canonDoc.translationStatus?.[lang] || '').trim().toLowerCase();
      if (titleForSlug && hasFullI18nBucket(canonDoc, lang) && nowStatus !== 'ready') {
        canonDoc.translationStatus[lang] = 'ready';
        changed = true;
      }
    }

    // Prefer to keep shared fields from canonical, but fill obvious gaps.
    const bestPublishedAt = docsInGroup.reduce((acc, d) => {
      const t = d?.publishedAt ? new Date(d.publishedAt).getTime() : 0;
      return t > acc ? t : acc;
    }, 0);

    if (!canonDoc.publishedAt && bestPublishedAt) {
      canonDoc.publishedAt = new Date(bestPublishedAt);
      changed = true;
    }

    canonDoc.category = pickNonEmpty(canonDoc.category, canonicalLean.category, docsInGroup[0]?.category) || canonDoc.category;
    canonDoc.tags = Array.isArray(canonDoc.tags) ? canonDoc.tags : [];

    if (changed) {
      groupsChanged += 1;
      console.log('\n[group]', g, 'canon=', canonicalId, 'stale=', stale.length, 'variants=', Object.keys(variants));
    }

    if (changed && !dryRun) {
      await canonDoc.save();
      updatedCanon += 1;
    }

    // Archive or delete stale duplicates.
    if (!dryRun && stale.length) {
      if (deleteStale) {
        for (const d of stale) {
          await Article.deleteOne({ _id: d._id });
          deleted += 1;
        }
      } else if (archiveStale) {
        for (const d of stale) {
          await Article.updateOne(
            { _id: d._id },
            { $set: { status: 'draft', publishedAt: null } }
          );
          archived += 1;
        }
      }
    }
  }

  console.log('\n[repair-storygroups] done', {
    groupsChanged,
    updatedCanon,
    archived,
    deleted,
    dryRun,
  });

  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
