require('dotenv').config();

const mongoose = require('mongoose');
const News = require('../models/News');
const PublicArticle = require('../models/Article');

function normalizeText(value) {
  return String(value || '').trim();
}

function buildMatchRegexes(args) {
  const terms = args.length ? args : ['bengal', 'modi', 'omar'];
  return terms
    .map((term) => normalizeText(term))
    .filter(Boolean)
    .map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

function summarizeImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return { url: image };
  if (typeof image !== 'object' || Array.isArray(image)) return null;
  return {
    id: image.id || image.publicId || null,
    publicId: image.publicId || null,
    url: image.url || null,
  };
}

function summarizeNews(doc) {
  return {
    _id: String(doc._id),
    title: doc.title || null,
    slug: doc.slug || null,
    status: doc.status || null,
    publishedAt: doc.publishedAt || null,
    language: doc.language || doc.lang || null,
    translationGroupId: doc.translationGroupId || null,
    translationKey: doc.translationKey || null,
    coverImage: summarizeImage(doc.coverImage) || summarizeImage(doc.coverImageUrl) || summarizeImage(doc.imageURL),
    heroImage: summarizeImage(doc.heroImage),
    sourceArticleId: doc.sourceArticleId ? String(doc.sourceArticleId) : null,
  };
}

function summarizePublic(doc) {
  return {
    _id: String(doc._id),
    sourceNewsId: doc.sourceNewsId ? String(doc.sourceNewsId) : null,
    title: doc.title || null,
    slug: doc.slug || null,
    status: doc.status || null,
    publishedAt: doc.publishedAt || null,
    language: doc.language || doc.lang || null,
    translationGroupId: doc.translationGroupId || null,
    translationKey: doc.translationKey || null,
    coverImage: summarizeImage(doc.coverImage) || summarizeImage(doc.coverImageUrl) || summarizeImage(doc.imageURL),
    heroImage: summarizeImage(doc.heroImage),
    sourceArticleId: doc.sourceArticleId ? String(doc.sourceArticleId) : null,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  const dbName = process.env.MONGODB_DBNAME || undefined;
  if (!uri) throw new Error('Missing MONGODB_URI');

  await mongoose.connect(uri, dbName ? { dbName } : undefined);

  const regexes = buildMatchRegexes(process.argv.slice(2));
  const or = [];
  for (const rx of regexes) {
    or.push({ title: rx });
    or.push({ slug: rx });
    or.push({ 'slugs.en': rx });
    or.push({ 'slugs.hi': rx });
    or.push({ 'slugs.gu': rx });
  }

  const newsDocs = await News.find({ $or: or })
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('_id title slug status publishedAt language lang translationGroupId translationKey coverImage coverImageUrl imageURL heroImage sourceArticleId')
    .lean();

  const publicDocs = await PublicArticle.find({ $or: or })
    .sort({ updatedAt: -1, createdAt: -1 })
    .select('_id sourceNewsId title slug status publishedAt language lang translationGroupId translationKey coverImage coverImageUrl imageURL heroImage sourceArticleId')
    .lean();

  const groupIds = Array.from(new Set(newsDocs.map((doc) => normalizeText(doc.translationGroupId || doc.translationKey)).filter(Boolean)));
  const groupedNews = groupIds.length
    ? await News.find({ $or: [{ translationGroupId: { $in: groupIds } }, { translationKey: { $in: groupIds } }] })
      .sort({ translationGroupId: 1, createdAt: 1 })
      .select('_id title slug status publishedAt language lang translationGroupId translationKey coverImage coverImageUrl imageURL heroImage sourceArticleId')
      .lean()
    : [];

  const groupedPublic = groupIds.length
    ? await PublicArticle.find({ $or: [{ translationGroupId: { $in: groupIds } }, { translationKey: { $in: groupIds } }] })
      .sort({ translationGroupId: 1, createdAt: 1 })
      .select('_id sourceNewsId title slug status publishedAt language lang translationGroupId translationKey coverImage coverImageUrl imageURL heroImage sourceArticleId')
      .lean()
    : [];

  const payload = {
    matchedNews: newsDocs.map(summarizeNews),
    matchedPublicArticles: publicDocs.map(summarizePublic),
    groupedNews: groupedNews.map(summarizeNews),
    groupedPublicArticles: groupedPublic.map(summarizePublic),
  };

  console.log(JSON.stringify(payload, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error && error.stack ? error.stack : error);
  try {
    await mongoose.disconnect();
  } catch (_) {}
  process.exit(1);
});