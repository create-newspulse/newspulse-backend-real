const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const PublicArticle = require('../models/Article');
const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { publishedNews, bucket, makeQuery, matchesFilter } = require('./helpers/publicFeedModels');

const now = new Date('2026-10-05T10:00:00.000Z');
function scheduled(overrides = {}) {
  const doc = publishedNews(1, {
    status: 'scheduled', scheduledAt: new Date('2026-10-05T09:00:00.000Z'), publishedAt: null,
    authorByline: { enabled: false }, ...overrides,
  });
  doc.save = async () => doc;
  return doc;
}

function options(doc, overrides = {}) {
  return {
    allowDisconnected: true, now,
    News: {
      find: () => ({ limit: async () => [doc] }),
      findById: async () => null,
      countDocuments: async (filter) => matchesFilter(doc, filter) ? 1 : 0,
    },
    PushHistory: { create: async () => ({}) },
    invalidateArticleCaches: async () => {},
    logger: { warn() {} },
    ...overrides,
  };
}

test('scheduled ordinary publication commits before calling the canonical mapper and invalidation', async (t) => {
  const doc = scheduled();
  const calls = [];
  doc.save = async () => { calls.push('save'); return doc; };
  t.mock.method(PublicArticle, 'find', () => makeQuery([]));
  t.mock.method(PublicArticle, 'findOneAndUpdate', (_filter, update, flags) => {
    calls.push('canonical-sync');
    assert.deepEqual(Object.keys(_filter), ['_id']);
    assert.equal(typeof _filter._id.toHexString, 'function');
    assert.equal(doc.status, 'published');
    assert.equal(update.$set.sourceNewsId, doc._id);
    assert.equal(update.$set.geo.state, 'gujarat');
    assert.equal(update.$set.publishedAt, now);
    assert.equal(flags.upsert, true);
    return makeQuery([{ _id: 'public-id', ...update.$set }], {}, true);
  });
  const stats = await publishDueScheduledArticles(options(doc, {
    invalidateArticleCaches: async () => { calls.push('invalidate'); },
    publishCanonicalArticle: async () => { assert.fail('ordinary scheduling must not invoke the full multilingual publisher'); },
  }));
  assert.deepEqual(calls, ['save', 'canonical-sync', 'invalidate']);
  assert.equal(stats.published, 1);
  assert.equal(stats.failed, 0);
  assert.deepEqual(stats.publicSync, { ok: true, synced: 1, failedArticleIds: [] });
});

for (const failure of ['null', 'throw']) {
  test(`sync ${failure} failure is recorded without rolling back committed publication`, async () => {
    const doc = scheduled();
    const warnings = [];
    let invalidated = false;
    const stats = await publishDueScheduledArticles(options(doc, {
      syncPublicArticleFromNews: async () => {
        if (failure === 'throw') throw new Error('test-only projection failure');
        return null;
      },
      invalidateArticleCaches: async () => { invalidated = true; },
      logger: { warn: (...args) => warnings.push(args) },
    }));
    assert.equal(doc.status, 'published');
    assert.equal(doc.publishedAt, now);
    assert.equal(stats.published, 1);
    assert.equal(stats.failed, 0);
    assert.deepEqual(stats.publicSync.failedArticleIds, [doc._id]);
    assert.equal(stats.publicSync.ok, false);
    assert.equal(invalidated, true);
    assert.equal(warnings[0][1].code, 'PUBLIC_ARTICLE_SYNC_FAILED');
  });
}

test('cache invalidation failures are logged without corrupting publication', async () => {
  const doc = scheduled();
  const warnings = [];
  const stats = await publishDueScheduledArticles(options(doc, {
    syncPublicArticleFromNews: async () => ({ _id: 'public-id' }),
    invalidateArticleCaches: async () => { throw new Error('test-only cache failure'); },
    logger: { warn: (...args) => warnings.push(args) },
  }));
  assert.equal(stats.published, 1);
  assert.equal(doc.status, 'published');
  assert.equal(warnings[0][1].code, 'PUBLIC_CACHE_INVALIDATION_FAILED');
});

test('protected categories, provenance and sponsorship do not acquire ordinary sync side effects', async () => {
  for (const metadata of [
    { category: 'youth-pulse' }, { category: 'inspiration-hub' }, { category: 'editorial' },
    { category: 'breaking' }, { category: 'web-stories' },
    { communityReportId: 'community-id' }, { sourceType: 'community-reporter' },
    { youthPulseSubmissionId: 'youth-id' }, { isSponsored: true }, { isSponsoredArticle: true },
    { sourceTrack: 'campus-buzz' },
    { source: 'inspiration-hub' }, { originType: 'pulse-dialogue' },
  ]) {
    const doc = scheduled(metadata);
    const effects = [];
    const stats = await publishDueScheduledArticles(options(doc, {
      syncPublicArticleFromNews: async () => { effects.push('sync'); return { _id: 'public-id' }; },
      invalidateArticleCaches: async () => { effects.push('invalidate'); },
    }));
    assert.equal(stats.published, 1);
    assert.equal(stats.publicSync, undefined);
    assert.deepEqual(effects, []);
  }
});

test('ordinary-looking descendants of protected sources do not acquire ordinary sync', async () => {
  const doc = scheduled({ sourceArticleId: publishedNews(2)._id });
  const parent = publishedNews(2, { communityReportId: 'protected-origin' });
  const effects = [];
  const stats = await publishDueScheduledArticles(options(doc, {
    News: { find: () => ({ limit: async () => [doc] }), findById: async () => parent },
    syncPublicArticleFromNews: async () => { effects.push('sync'); return { _id: 'public-id' }; },
    invalidateArticleCaches: async () => { effects.push('invalidate'); },
  }));
  assert.equal(stats.published, 1);
  assert.equal(stats.publicSync, undefined);
  assert.deepEqual(effects, []);
});

test('unverifiable source lineage records failure after publication, never guesses ownership', async () => {
  const doc = scheduled({ sourceArticleId: publishedNews(2)._id });
  let syncCalls = 0;
  const stats = await publishDueScheduledArticles(options(doc, {
    syncPublicArticleFromNews: async () => { syncCalls += 1; return { _id: 'public-id' }; },
  }));
  assert.equal(stats.published, 1);
  assert.deepEqual(stats.publicSync.failedArticleIds, [doc._id]);
  assert.equal(syncCalls, 0);
});

test('ordinary guarded sync preserves public-owned text, translations, media, URLs, dates and IDs', async (t) => {
  let copies;
  t.mock.method(PublicArticle, 'find', () => makeQuery(copies));
  let writes = 0;
  t.mock.method(PublicArticle, 'findOneAndUpdate', () => {
    writes += 1;
    return makeQuery(copies, {}, true);
  });
  for (const fields of [
    { title: 'Public-only edited title' },
    { translations: { en: bucket('en', { provider: 'manual' }) }, translationStatus: { en: 'ready' } },
    { translations: { en: bucket('en', { provider: 'google' }) }, translationStatus: { en: 'ready' } },
    { translations: { en: { title: 'Public-only partial edit' } } },
    { i18n: { title: { en: 'Public-only legacy title' } } },
    { coverImage: { url: 'https://example.test/language-image.jpg' } },
    { slugs: { en: 'existing-language-url' } },
    { publishedAt: new Date('2026-01-01') },
    { sourceNewsId: 'another-news-id' },
    { category: 'pulse-dialogue' },
    { category: 'youth-pulse' },
    { category: 'inspiration-hub' },
    { category: 'community-reporter' },
  ]) {
    const doc = scheduled({ coverImage: { url: 'https://example.test/source-image.jpg' } });
    copies = [{
      _id: 'existing-public-id', sourceNewsId: doc._id, slug: doc.slug, status: 'published',
      createdAt: new Date('2026-01-01'), views: 12, ...fields,
    }];
    const snapshot = JSON.stringify(copies);
    const stats = await publishDueScheduledArticles(options(doc));
    assert.equal(stats.published, 1);
    assert.equal(stats.publicSync.ok, false);
    assert.equal(writes, 0);
    assert.equal(JSON.stringify(copies), snapshot);
  }
});

test('scheduled preservation retains public-only cover, gallery, embeds and external URLs', async (t) => {
  for (const sourceMedia of [
    {},
    { coverImage: { url: null }, gallery: [], embeds: [], externalUrls: [] },
  ]) {
    const doc = scheduled(sourceMedia);
    const existing = {
      _id: 'public-id', sourceNewsId: doc._id, slug: doc.slug,
      coverImage: {
        url: 'https://example.test/en-cover.jpg', alt: 'English cover', publicId: 'owned-cover',
        width: 1280, caption: 'Public-only caption',
      },
      gallery: ['https://example.test/en-gallery.jpg'],
      embeds: ['https://example.test/en-video'],
      externalUrls: ['https://example.test/en-source'],
      updatedAt: new Date('2026-10-01'), createdAt: new Date('2026-01-01'), views: 19,
    };
    t.mock.method(PublicArticle, 'find', () => makeQuery([existing]));
    let saved;
    t.mock.method(PublicArticle, 'findOneAndUpdate', (filter, update, flags) => {
      assert.deepEqual(filter, { _id: existing._id, updatedAt: existing.updatedAt });
      assert.equal(flags.upsert, false);
      for (const field of ['coverImage', 'gallery', 'embeds', 'externalUrls']) {
        assert.equal(Object.hasOwn(update.$set, field), false, field);
      }
      saved = { ...existing, ...update.$set };
      return makeQuery([saved], {}, true);
    });
    const stats = await publishDueScheduledArticles(options(doc));
    assert.equal(stats.publicSync.ok, true);
    for (const field of ['coverImage', 'gallery', 'embeds', 'externalUrls', 'createdAt', 'views']) {
      assert.deepEqual(saved[field], existing[field], field);
    }
  }
});

test('scheduled preservation never re-casts or clears legacy cover representations', async (t) => {
  for (const media of [
    { coverImage: 'https://example.test/legacy-cover.jpg' },
    { imageURL: 'https://example.test/legacy-language-cover.jpg' },
  ]) {
    const doc = scheduled();
    const existing = { _id: 'public-id', sourceNewsId: doc._id, slug: doc.slug, ...media };
    t.mock.method(PublicArticle, 'find', () => makeQuery([existing]));
    let saved;
    t.mock.method(PublicArticle, 'findOneAndUpdate', (_filter, update) => {
      assert.equal(Object.hasOwn(update.$set, 'coverImage'), false);
      saved = { ...existing, ...update.$set };
      return makeQuery([saved], {}, true);
    });
    const stats = await publishDueScheduledArticles(options(doc));
    assert.equal(stats.publicSync.ok, true);
    for (const field of Object.keys(media)) assert.deepEqual(saved[field], existing[field]);
  }
});

test('guarded media conflicts fail without writes; non-opt-in mapping retains its existing defaults', async (t) => {
  const doc = publishedNews(1, { gallery: ['https://example.test/source.jpg'] });
  const existing = { _id: 'public-id', sourceNewsId: doc._id, slug: doc.slug, gallery: ['https://example.test/owned.jpg'] };
  t.mock.method(PublicArticle, 'find', () => makeQuery([existing]));
  const writes = t.mock.method(PublicArticle, 'findOneAndUpdate', (_filter, update) =>
    makeQuery([{ _id: existing._id, ...update.$set }], {}, true));
  const guarded = await syncPublicArticleFromNews(doc, { preserveExistingProjection: true, logger: { warn() {} } });
  assert.equal(guarded, null);
  assert.equal(writes.mock.callCount(), 0);
  const ordinaryDefault = await syncPublicArticleFromNews(publishedNews(1), { logger: { warn() {} } });
  assert.equal(writes.mock.callCount(), 1);
  assert.deepEqual(ordinaryDefault.gallery, []);
  assert.deepEqual(ordinaryDefault.embeds, []);
  assert.deepEqual(ordinaryDefault.externalUrls, []);
});

test('guarded updates preserve IDs/dates and use a concurrent-edit fence without upsert', async (t) => {
  const doc = publishedNews(1);
  const existing = {
    _id: 'existing-public-id', sourceNewsId: doc._id, slug: doc.slug, publishedAt: doc.publishedAt,
    createdAt: new Date('2025-12-01'), updatedAt: new Date('2026-01-02'), views: 99,
  };
  t.mock.method(PublicArticle, 'find', () => makeQuery([existing]));
  t.mock.method(PublicArticle, 'findOneAndUpdate', (filter, update, flags) => {
    assert.deepEqual(filter, { _id: existing._id, updatedAt: existing.updatedAt });
    assert.equal(flags.upsert, false);
    assert.equal(update.$set._id, undefined);
    assert.equal(update.$set.createdAt, undefined);
    assert.equal(update.$set.views, undefined);
    assert.equal(update.$set.publishedAt, existing.publishedAt);
    return makeQuery([{ ...existing, ...update.$set }], {}, true);
  });
  const result = await syncPublicArticleFromNews(doc, { preserveExistingProjection: true, logger: { warn() {} } });
  assert.equal(result._id, existing._id);
  assert.equal(result.createdAt, existing.createdAt);
  assert.equal(result.views, 99);
});

test('scheduled sync does not create public copies for private, locked or embargoed News', async () => {
  for (const denial of [
    { isPrivate: true }, { visibility: 'private' }, { locked: true },
    { workflow: { locked: true } }, { workflow: { embargoUntil: new Date('2999-01-01') } },
    { embargoUntil: new Date('2999-01-01') },
  ]) {
    const doc = scheduled(denial);
    let syncCalls = 0;
    const stats = await publishDueScheduledArticles(options(doc, {
      syncPublicArticleFromNews: async () => { syncCalls += 1; return { _id: 'public-id' }; },
    }));
    assert.equal(doc.status, 'published');
    assert.equal(stats.published, 1);
    assert.equal(stats.publicSync.ok, false);
    assert.equal(syncCalls, 0);
  }
});

test('scheduled sync cannot expose a public variant whose source is private', async () => {
  const parent = publishedNews(2, { isPrivate: true });
  const doc = scheduled({ sourceArticleId: parent._id });
  let syncCalls = 0;
  const stats = await publishDueScheduledArticles(options(doc, {
    News: {
      find: () => ({ limit: async () => [doc] }),
      findById: async () => parent,
      countDocuments: async (filter) => [doc, parent].filter((item) => matchesFilter(item, filter)).length,
    },
    syncPublicArticleFromNews: async () => { syncCalls += 1; return { _id: 'public-id' }; },
  }));
  assert.equal(stats.published, 1);
  assert.equal(stats.publicSync.ok, false);
  assert.equal(syncCalls, 0);
});
