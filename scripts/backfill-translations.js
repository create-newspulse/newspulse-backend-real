/*
Backfill cached translations for published News and/or Article documents.

Usage:
  MONGODB_URI="..." GOOGLE_TRANSLATE_API_KEY="..." node scripts/backfill-translations.js --model=both --lang=all --limit=50

Options:
  --model=news|article|both   (default: both)
  --lang=en|hi|gu|all         (default: all)
  --limit=NUMBER              (default: 50)
  --dry-run                   (default: false)

Notes:
  - This uses the existing on-demand translation services and persists results via $set.
  - It is safe to re-run; ready translations are skipped by the query.
*/

require('dotenv').config();

const mongoose = require('mongoose');

const News = require('../models/News');
const Article = require('../models/Article');

const { ensureOnDemandNewsTranslation } = require('../services/newsOnDemandTranslation.service');
const { ensureOnDemandArticleTranslation } = require('../services/articleTranslation.service');
const { isGoogleTranslateConfigured } = require('../services/translationEnabled');

function parseArgs(argv) {
  const out = { model: 'both', lang: 'all', limit: 50, dryRun: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run' || a === '--dryrun') out.dryRun = true;
    else if (a.startsWith('--model=')) out.model = String(a.split('=')[1] || '').trim();
    else if (a.startsWith('--lang=')) out.lang = String(a.split('=')[1] || '').trim();
    else if (a.startsWith('--limit=')) out.limit = Number(a.split('=')[1]);
  }
  if (!Number.isFinite(out.limit) || out.limit <= 0) out.limit = 50;
  out.model = String(out.model || 'both').trim().toLowerCase();
  out.lang = String(out.lang || 'all').trim();
  return out;
}

function normalizeLang(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  if (/[\u0A80-\u0AFF]/.test(raw)) return 'gu';
  if (/[\u0900-\u097F]/.test(raw)) return 'hi';

  const lower = raw.toLowerCase();
  const primary = lower.split(/[-_]/)[0];
  if (primary === 'en' || primary === 'hi' || primary === 'gu') return primary;

  const lettersOnly = lower.replace(/[^a-z]/g, '');
  if (lettersOnly === 'english' || lettersOnly === 'eng') return 'en';
  if (lettersOnly === 'hindi' || lettersOnly === 'hin') return 'hi';
  if (lettersOnly === 'gujarati' || lettersOnly === 'gujrati' || lettersOnly === 'guj') return 'gu';

  return null;
}

function normalizeLangList(v) {
  const raw = String(v ?? '').trim().toLowerCase();
  if (!raw || raw === 'all') return ['en', 'hi', 'gu'];
  const one = normalizeLang(raw);
  return one ? [one] : [];
}

function buildMissingTranslationFilter(lang) {
  const l = normalizeLang(lang);
  if (!l) return null;

  return {
    status: 'published',
    $or: [
      { [`translationStatus.${l}`]: { $ne: 'ready' } },
      { [`translations.${l}.title`]: { $in: [null, ''] } },
      { [`translations.${l}.summary`]: { $in: [null, ''] } },
      { [`translations.${l}.content`]: { $in: [null, ''] } },
    ],
  };
}

async function backfillNews({ lang, limit, dryRun }) {
  const filter = buildMissingTranslationFilter(lang);
  if (!filter) return { attempted: 0, updated: 0, translated: 0 };

  const docs = await News.find(filter).sort({ updatedAt: -1, publishedAt: -1, createdAt: -1 }).limit(limit).lean();

  let attempted = 0;
  let updated = 0;
  let translated = 0;

  for (const doc of docs) {
    attempted += 1;
    const now = new Date();

    const localized = await ensureOnDemandNewsTranslation({
      doc,
      requestedLang: lang,
      logger: console,
      lockOwner: true,
      now,
    });

    if (localized && localized.dbSet && doc && doc._id) {
      updated += 1;
      if (!dryRun) {
        await News.updateOne({ _id: doc._id }, { $set: localized.dbSet }).catch(() => null);
      }
    }

    if (localized && localized.resolvedLang === normalizeLang(lang) && localized.translationPending === false) {
      translated += 1;
    }
  }

  return { attempted, updated, translated };
}

async function backfillArticles({ lang, limit, dryRun }) {
  const filter = buildMissingTranslationFilter(lang);
  if (!filter) return { attempted: 0, updated: 0, translated: 0 };

  const docs = await Article.find(filter).sort({ updatedAt: -1, publishedAt: -1, createdAt: -1 }).limit(limit).lean();

  let attempted = 0;
  let updated = 0;
  let translated = 0;

  for (const article of docs) {
    attempted += 1;
    const now = new Date();

    const localized = await ensureOnDemandArticleTranslation({
      article,
      requestedLang: lang,
      logger: console,
      lockOwner: true,
      now,
    });

    if (localized && localized.dbSet && article && article._id) {
      updated += 1;
      if (!dryRun) {
        await Article.updateOne({ _id: article._id }, { $set: localized.dbSet }).catch(() => null);
      }
    }

    if (localized && localized.resolvedLang === normalizeLang(lang) && localized.translationPending === false) {
      translated += 1;
    }
  }

  return { attempted, updated, translated };
}

async function main() {
  const args = parseArgs(process.argv);

  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI (or legacy MONGO_URI) is required');

  const langs = normalizeLangList(args.lang);
  if (!langs.length) {
    throw new Error('Invalid --lang (use en|hi|gu|all)');
  }

  if (!isGoogleTranslateConfigured()) {
    throw new Error('Google Translate is not configured (set GOOGLE_TRANSLATE_API_KEY)');
  }

  if (!['news', 'article', 'both'].includes(args.model)) {
    throw new Error('Invalid --model (use news|article|both)');
  }

  await mongoose.connect(uri);

  const totals = { news: {}, article: {} };

  for (const lang of langs) {
    if (args.model === 'news' || args.model === 'both') {
      totals.news[lang] = await backfillNews({ lang, limit: args.limit, dryRun: args.dryRun });
    }
    if (args.model === 'article' || args.model === 'both') {
      totals.article[lang] = await backfillArticles({ lang, limit: args.limit, dryRun: args.dryRun });
    }
  }

  console.log('[backfill-translations] done', {
    model: args.model,
    langs,
    limit: args.limit,
    dryRun: args.dryRun,
    totals,
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[backfill-translations] failed', err?.message || err);
  process.exitCode = 1;
});
