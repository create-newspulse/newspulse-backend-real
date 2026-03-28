require('dotenv').config();

const mongoose = require('mongoose');

const News = require('../models/News');
const Article = require('../models/Article');
const { notifyArticleContentInvalidation } = require('../services/publicContentInvalidation.service');

function parseArgs(argv) {
  const out = {
    newsId: '',
    articleId: '',
    groupId: '',
  };

  for (const arg of argv) {
    const raw = String(arg || '').trim();
    if (!raw.startsWith('--')) continue;
    const eqIndex = raw.indexOf('=');
    const key = eqIndex >= 0 ? raw.slice(2, eqIndex) : raw.slice(2);
    const value = eqIndex >= 0 ? raw.slice(eqIndex + 1).trim() : '';
    if (!value) continue;
    if (key === 'news-id') out.newsId = value;
    if (key === 'article-id') out.articleId = value;
    if (key === 'group-id') out.groupId = value;
  }

  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.newsId || !args.articleId || !args.groupId) {
    throw new Error('Usage: node scripts/repair-stale-translation-group.js --news-id=<id> --article-id=<id> --group-id=<id>');
  }

  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!mongoUri) throw new Error('Missing MONGODB_URI (or legacy MONGO_URI)');

  await mongoose.connect(mongoUri, {
    dbName: process.env.MONGODB_DBNAME || undefined,
  });

  const newsResult = await News.updateOne(
    { _id: args.newsId, translationGroupId: args.groupId },
    {
      $unset: {
        'translations.hi': 1,
        'translations.gu': 1,
      },
      $set: {
        'translationStatus.hi': 'pending',
        'translationStatus.gu': 'pending',
        'translationError.hi': null,
        'translationError.gu': null,
        'translationNextRetryAt.hi': null,
        'translationNextRetryAt.gu': null,
      },
    }
  );

  const articleResult = await Article.updateOne(
    { _id: args.articleId, translationGroupId: args.groupId },
    {
      $unset: {
        'translations.hi': 1,
        'translations.gu': 1,
        'i18n.title.hi': 1,
        'i18n.title.gu': 1,
        'i18n.summary.hi': 1,
        'i18n.summary.gu': 1,
        'i18n.content.hi': 1,
        'i18n.content.gu': 1,
      },
      $set: {
        'translationStatus.hi': 'pending',
        'translationStatus.gu': 'pending',
        'translationError.hi': null,
        'translationError.gu': null,
        'translationNextRetryAt.hi': null,
        'translationNextRetryAt.gu': null,
      },
    }
  );

  const newsDoc = await News.findById(args.newsId)
    .select('_id slug slugs category translationGroupId')
    .lean();

  const invalidation = await notifyArticleContentInvalidation(
    newsDoc || {
      _id: args.newsId,
      slug: '',
      slugs: {},
      category: '',
      translationGroupId: args.groupId,
    },
    { logger: console }
  );

  const verification = await Promise.all([
    News.findById(args.newsId)
      .select('translations.hi translations.gu translationStatus.hi translationStatus.gu')
      .lean(),
    Article.findById(args.articleId)
      .select('translations.hi translations.gu i18n.title.hi i18n.title.gu i18n.summary.hi i18n.summary.gu i18n.content.hi i18n.content.gu translationStatus.hi translationStatus.gu')
      .lean(),
  ]);

  console.log(JSON.stringify({
    newsUpdate: {
      matchedCount: newsResult.matchedCount || 0,
      modifiedCount: newsResult.modifiedCount || 0,
    },
    articleUpdate: {
      matchedCount: articleResult.matchedCount || 0,
      modifiedCount: articleResult.modifiedCount || 0,
    },
    invalidation,
    verification: {
      news: verification[0],
      article: verification[1],
    },
  }, null, 2));

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});