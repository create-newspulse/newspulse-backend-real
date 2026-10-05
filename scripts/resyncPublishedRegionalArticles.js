const { isDeepStrictEqual } = require('node:util');
const { canonicalizeSlug } = require('../lib/slug');
const { requireLocalDatabaseIsolation } = require('../lib/environmentSafety');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');

const NEWS_ID_PATTERN = /^[a-f0-9]{24}$/i;
const LANGUAGES = ['en', 'hi', 'gu'];
const EXCLUDED_ORIGINS = new Set([
  'community', 'community_reporter', 'communityreporter', 'journalist',
  'youth', 'youth_pulse', 'youthpulse',
]);

class ResyncError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function refuse(code) {
  throw new ResyncError(code);
}

function parseArgs(args) {
  const options = { apply: false, newsId: null, help: false };
  let dryRun = false;
  for (const arg of args) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--help') options.help = true;
    else if (arg.startsWith('--news-id=')) {
      if (options.newsId !== null) refuse('DUPLICATE_NEWS_ID_ARGUMENT');
      options.newsId = arg.slice('--news-id='.length);
      if (!NEWS_ID_PATTERN.test(options.newsId)) refuse('INVALID_NEWS_ID');
    } else refuse('UNKNOWN_ARGUMENT');
  }
  if (options.apply && dryRun) refuse('CONFLICTING_MODE_ARGUMENTS');
  return options;
}

function isProtectedContent(doc) {
  if (doc.deletedAt != null || doc.isSponsored || doc.isSponsoredArticle || doc.isBreaking) return true;
  if (doc.communityReportId || doc.youthPulseSubmissionId || doc.youthPulseContributorId) return true;
  return ['source', 'sourceType', 'submissionSource', 'originType'].some((field) =>
    EXCLUDED_ORIGINS.has(String(doc[field] || '').trim().toLowerCase().replace(/[\s-]+/g, '_'))
  );
}

function isEligibleNews(doc) {
  return !!doc && doc.category === 'regional' && doc.status === 'published' && !isProtectedContent(doc);
}

function safeNewsId(value) {
  const id = String(value || '');
  return NEWS_ID_PATTERN.test(id) ? id.toLowerCase() : null;
}

async function hasAllowedSourceLineage(source, News) {
  let current = source;
  const seen = new Set([safeNewsId(source._id)]);
  // Historical translated siblings do not always carry their parent's provenance flags.
  while (current.sourceArticleId && String(current.sourceArticleId) !== String(current._id)) {
    const parentId = safeNewsId(current.sourceArticleId);
    if (!parentId) refuse('INVALID_TRANSLATION_SOURCE_ID');
    if (seen.has(parentId)) refuse('TRANSLATION_SOURCE_CYCLE');
    seen.add(parentId);
    current = await News.findOne({ _id: parentId }).lean();
    if (!current) refuse('MISSING_TRANSLATION_SOURCE');
    if (isProtectedContent(current)) return false;
  }
  return true;
}

function validDate(value) {
  return value != null && value !== '' && Number.isFinite(new Date(value).getTime());
}

function checkSource(source) {
  if (!safeNewsId(source._id)) refuse('INVALID_NEWS_ID');
  if (typeof source.slug !== 'string' || !source.slug.trim()) refuse('MISSING_SOURCE_SLUG');
  if (canonicalizeSlug(source.slug) !== source.slug) refuse('NON_CANONICAL_SOURCE_SLUG');
  if (typeof source.title !== 'string' || !source.title.trim()) refuse('MISSING_SOURCE_TITLE');
  // Without a historical source timestamp, an upsert could manufacture a new publication date.
  if (!validDate(source.publishedAt)) refuse('MISSING_OR_INVALID_PUBLISHED_AT');
  const language = source.language || source.lang;
  if (!LANGUAGES.includes(language)
    || (source.lang && source.lang !== language)
    || (source.originalLang && !LANGUAGES.includes(source.originalLang))
    || (source.sourceLanguage && !LANGUAGES.includes(source.sourceLanguage))) {
    refuse('SOURCE_LANGUAGE_CONFLICT');
  }
}

function checkExistingIdentity(source, existing) {
  if (!existing) return;
  if (!isEligibleNews(existing)) refuse('PUBLIC_COPY_OUT_OF_SCOPE');
  if (existing.slug !== source.slug) refuse('PUBLIC_SLUG_CONFLICT');
  if (existing.publishedAt != null && (!validDate(existing.publishedAt)
    || new Date(existing.publishedAt).getTime() !== new Date(source.publishedAt).getTime())) {
    refuse('PUBLICATION_DATE_CONFLICT');
  }

  // These are preflight invariants, not a second Public Article mapper.
  const language = source.language || source.lang;
  const identity = {
    sourceNewsId: source._id,
    sourceArticleId: source.sourceArticleId || source._id,
    translationKey: source.translationKey || null,
    translationGroupId: source.translationGroupId || source.translationKey || null,
    language,
    originalLang: source.originalLang || language,
    sourceLanguage: source.sourceLanguage || source.originalLang || language,
  };
  for (const [field, value] of Object.entries(identity)) {
    if (existing[field] != null && existing[field] !== '' && String(existing[field]) !== String(value)) {
      refuse('PUBLIC_IDENTITY_CONFLICT');
    }
  }
  for (const lang of LANGUAGES) {
    if (existing.slugs?.[lang] && existing.slugs[lang] !== source.slugs?.[lang]) {
      refuse('PUBLIC_SLUG_CONFLICT');
    }
  }
  if (existing.seo?.canonicalUrl && existing.seo.canonicalUrl !== source.seo?.canonicalUrl) {
    refuse('CANONICAL_URL_CONFLICT');
  }
}

function newSummary(apply) {
  return {
    mode: apply ? 'APPLY' : 'DRY RUN',
    scanned: 0,
    eligible: 0,
    publicCopiesPresent: 0,
    missingPublicCopies: 0,
    wouldCreate: 0,
    wouldUpdate: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    complete: true,
    failures: [],
    errors: [],
  };
}

async function resyncPublishedRegionalArticles({ apply = false, newsId = null } = {}) {
  if (typeof apply !== 'boolean') refuse('INVALID_APPLY_OPTION');
  if (newsId !== null && (typeof newsId !== 'string' || !NEWS_ID_PATTERN.test(newsId))) refuse('INVALID_NEWS_ID');

  const News = require('../models/News');
  const PublicArticle = require('../models/Article');
  const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
  const summary = newSummary(apply);
  const filter = { category: 'regional', status: 'published', ...(newsId ? { _id: newsId } : {}) };
  const readCurrentSource = (id) => News.findOne({
    ...filter,
    _id: id,
    ...buildPubliclyVisibleNewsArticleFilter(),
  }).lean();
  let cursor;

  try {
    // Keep only IDs in cursor batches; reread each source instead of syncing a buffered snapshot.
    cursor = News.find(filter).select('_id').sort({ _id: 1 }).lean().cursor({ batchSize: 25 });
    for await (const candidate of cursor) {
      summary.scanned += 1;
      try {
        const source = await readCurrentSource(candidate._id);
        if (!isEligibleNews(source) || !await hasAllowedSourceLineage(source, News)) {
          summary.skipped += 1;
          continue;
        }
        summary.eligible += 1;
        checkSource(source);

        const copies = await PublicArticle.find({
          $or: [{ sourceNewsId: source._id }, { slug: canonicalizeSlug(source.slug) }],
        }).limit(2).lean();
        if (copies.length) summary.publicCopiesPresent += 1;
        else summary.missingPublicCopies += 1;
        if (copies.length > 1) refuse('AMBIGUOUS_PUBLIC_COPIES');
        const existing = copies[0];
        checkExistingIdentity(source, existing);

        // A legacy slug-only copy must not be claimed when another News record owns that slug.
        if (await News.exists({ _id: { $ne: source._id }, slug: source.slug })) {
          refuse('SOURCE_SLUG_COLLISION');
        }

        if (!apply) {
          if (existing) summary.wouldUpdate += 1;
          else summary.wouldCreate += 1;
          continue;
        }

        const current = await readCurrentSource(source._id);
        if (!isEligibleNews(current) || !isDeepStrictEqual(source, current)
          || !await hasAllowedSourceLineage(current, News)) refuse('SOURCE_CHANGED_DURING_RESYNC');

        let syncReportedFailure = false;
        const saved = await syncPublicArticleFromNews(current, {
          logger: { warn() { syncReportedFailure = true; } },
        });
        if (syncReportedFailure || !saved?._id) refuse('PUBLIC_ARTICLE_SYNC_FAILED');
        if (existing) summary.updated += 1;
        else summary.created += 1;
      } catch (error) {
        summary.failed += 1;
        summary.failures.push({
          newsId: safeNewsId(candidate._id),
          code: error instanceof ResyncError ? error.code : 'RECORD_RESYNC_FAILED',
        });
      }
    }
  } catch (_) {
    summary.complete = false;
    summary.errors.push('NEWS_SCAN_FAILED');
  } finally {
    if (cursor) {
      try {
        await cursor.close();
      } catch (_) {
        summary.complete = false;
        summary.errors.push('NEWS_CURSOR_CLOSE_FAILED');
      }
    }
  }
  return summary;
}

function printSummary(summary, logger) {
  logger.log(`MODE: ${summary.mode}`);
  logger.log(`Scanned: ${summary.scanned}`);
  logger.log(`Eligible: ${summary.eligible}`);
  logger.log(`Public copies present: ${summary.publicCopiesPresent}`);
  logger.log(`Missing public copies: ${summary.missingPublicCopies}`);
  logger.log(summary.mode === 'APPLY' ? `Created: ${summary.created}` : `Would create: ${summary.wouldCreate}`);
  logger.log(summary.mode === 'APPLY' ? `Updated: ${summary.updated}` : `Would update: ${summary.wouldUpdate}`);
  logger.log(`Skipped: ${summary.skipped}`);
  logger.log(`Failed: ${summary.failed}`);
  logger.log(`Complete: ${summary.complete ? 'yes' : 'no'}`);
  for (const failure of summary.failures) {
    logger.error(`News ${failure.newsId || 'unknown'}: ${failure.code}`);
  }
  for (const code of summary.errors) logger.error(`Run error: ${code}`);
}

async function main({ args = process.argv.slice(2), env = process.env, logger = console } = {}) {
  let summary = newSummary(false);
  let connection;
  let failureCode = 'REGIONAL_RESYNC_FAILED';
  try {
    const options = parseArgs(args);
    if (options.help) {
      logger.log('Usage: node scripts\\resyncPublishedRegionalArticles.js [--dry-run | --apply] [--news-id=<24-hex-id>]');
      logger.log('Default: DRY RUN. Requires explicit REGIONAL_RESYNC_MONGODB_URI and REGIONAL_RESYNC_DBNAME.');
      return 0;
    }
    summary = newSummary(options.apply);
    // Never load .env or fall back to the application's live connection configuration.
    const uri = String(env.REGIONAL_RESYNC_MONGODB_URI || '').trim();
    const dbName = String(env.REGIONAL_RESYNC_DBNAME || '').trim();
    if (!uri || !dbName) refuse('EXPLICIT_RESYNC_CONNECTION_REQUIRED');
    try {
      requireLocalDatabaseIsolation({ ...env, MONGODB_URI: uri, MONGODB_DBNAME: dbName });
    } catch (_) {
      refuse('ENV_SAFETY_LOCAL_DB_REFUSED');
    }

    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 0) refuse('EXISTING_CONNECTION_REFUSED');
    // Disable implicit DDL before loading either model, including in dry-run mode.
    mongoose.set('autoIndex', false);
    mongoose.set('autoCreate', false);
    mongoose.set('bufferCommands', false);
    connection = mongoose;
    failureCode = 'DATABASE_CONNECTION_FAILED';
    await mongoose.connect(uri, {
      dbName,
      autoIndex: false,
      autoCreate: false,
      maxPoolSize: 1, // This one-shot utility performs only one database operation at a time.
    });
    failureCode = 'REGIONAL_RESYNC_FAILED';
    summary = await resyncPublishedRegionalArticles(options);
  } catch (error) {
    summary.complete = false;
    summary.errors.push(error instanceof ResyncError ? error.code : failureCode);
  } finally {
    if (connection) {
      try {
        await connection.disconnect();
      } catch (_) {
        summary.complete = false;
        summary.errors.push('DATABASE_DISCONNECT_FAILED');
      }
    }
  }
  printSummary(summary, logger);
  return summary.complete && summary.failed === 0 ? 0 : 1;
}

if (require.main === module) {
  main().then((exitCode) => { process.exitCode = exitCode; }).catch(() => {
    console.error('REGIONAL_RESYNC_FAILED');
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, isEligibleNews, resyncPublishedRegionalArticles, main };
