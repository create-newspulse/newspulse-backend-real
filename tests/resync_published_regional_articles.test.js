const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('bufferCommands', false);

const News = require('../models/News');
const PublicArticle = require('../models/Article');
const canonicalSync = require('../services/syncPublicArticleFromNews.service');
const googleTranslate = require('../services/googleTranslate.service');
const {
  parseArgs,
  isEligibleNews,
  resyncPublishedRegionalArticles,
  main,
} = require('../scripts/resyncPublishedRegionalArticles');

const historicalDate = new Date('2023-02-03T04:05:06.000Z');
const id = (number) => number.toString(16).padStart(24, '0');
const clone = (value) => structuredClone(value);

test.beforeEach((t) => {
  const forbidden = () => { assert.fail('Real database/network access or noncanonical writes are forbidden'); };
  t.mock.method(mongoose, 'connect', forbidden);
  t.mock.method(mongoose, 'createConnection', forbidden);
  t.mock.method(mongoose.mongo.MongoClient.prototype, 'connect', forbidden);
  t.mock.method(global, 'fetch', forbidden);
  t.mock.method(googleTranslate, 'translateMany', forbidden);
  t.mock.method(require('dotenv'), 'config', forbidden);
  for (const Model of [News, PublicArticle]) {
    for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'bulkWrite', 'deleteOne', 'deleteMany', 'createCollection', 'createIndexes', 'syncIndexes']) {
      t.mock.method(Model, method, forbidden);
    }
    t.mock.method(Model.prototype, 'save', forbidden);
  }
  t.mock.method(News, 'findOneAndUpdate', forbidden);
});

function source(number = 1, overrides = {}) {
  return {
    _id: id(number),
    title: `Regional headline ${number}`,
    description: `Regional summary ${number}`,
    content: `<p>Regional body ${number}</p>`,
    slug: `regional-story-${number}`,
    slugs: { en: `regional-story-${number}`, hi: null, gu: null },
    category: 'regional',
    status: 'published',
    source: 'editor',
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    translationGroupId: `regional-group-${number}`,
    translationKey: `regional-group-${number}`,
    translations: {
      en: { title: 'Human title', summary: 'Human summary', content: 'Human content', provider: 'manual', generatedAt: historicalDate },
    },
    translationStatus: { en: 'ready', hi: 'pending', gu: 'failed' },
    publishedAt: historicalDate,
    createdAt: new Date('2023-01-01T00:00:00.000Z'),
    updatedAt: new Date('2023-03-01T00:00:00.000Z'),
    deletedAt: null,
    views: 120,
    geo: { state: null, district: null, city: null },
    location: null,
    tags: ['desk:regional'],
    coverImage: { url: `https://images.example.test/${number}.jpg`, publicId: `cover-${number}`, alt: `Cover ${number}` },
    seo: { metaTitle: null, metaDescription: null, canonicalUrl: `https://example.test/news/regional-story-${number}` },
    ...overrides,
  };
}

function publicCopy(news, overrides = {}) {
  return {
    _id: id(100 + parseInt(news._id, 16)),
    sourceNewsId: news._id,
    sourceArticleId: news.sourceArticleId || news._id,
    title: 'Stale public headline',
    content: 'Stale public content',
    slug: news.slug,
    slugs: clone(news.slugs),
    category: news.category,
    status: news.status,
    language: news.language,
    originalLang: news.originalLang,
    sourceLanguage: news.sourceLanguage || news.originalLang,
    translationGroupId: news.translationGroupId,
    translationKey: news.translationKey,
    publishedAt: news.publishedAt,
    createdAt: new Date('2023-02-04T00:00:00.000Z'),
    views: 987,
    analyticsId: 'historical-public-analytics',
    coverImage: clone(news.coverImage),
    seo: clone(news.seo),
    ...overrides,
  };
}

function matches(doc, filter) {
  return Object.entries(filter).every(([field, condition]) => {
    if (field === '$or') return condition.some((clause) => matches(doc, clause));
    if (field === '$and') return condition.every((clause) => matches(doc, clause));
    const value = field.split('.').reduce((item, key) => item?.[key], doc);
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([op, expected]) => {
        if (op === '$ne') return String(value) !== String(expected);
        if (op === '$exists') return (value !== undefined) === expected;
        if (op === '$lte') return value != null && new Date(value).getTime() <= new Date(expected).getTime();
        assert.fail(`Unexpected test filter operator: ${op}`);
      });
    }
    return condition === null ? value == null : String(value) === String(condition);
  });
}

function installStore(t, sources, initialCopies = [], options = {}) {
  const state = {
    sources: clone(sources),
    copies: clone(initialCopies),
    writes: [],
    findFilters: [],
    reads: new Map(),
    closed: false,
    activeSyncs: 0,
    maxActiveSyncs: 0,
  };
  t.mock.method(News, 'find', (filter) => {
    state.findFilters.push(filter);
    return {
      select(fields) { assert.equal(fields, '_id'); return this; },
      sort(order) { assert.deepEqual(order, { _id: 1 }); return this; },
      lean() { return this; },
      cursor(cursorOptions) {
        assert.deepEqual(cursorOptions, { batchSize: 25 });
        const candidates = state.sources.filter((doc) => matches(doc, filter)).map((doc) => ({ _id: doc._id }));
        return {
          async *[Symbol.asyncIterator]() {
            for (const [index, candidate] of candidates.entries()) {
              if (index === options.scanFailureAfter) throw new Error('private scan detail');
              yield candidate;
            }
          },
          async close() {
            state.closed = true;
            if (options.closeFailure) throw new Error('private cursor detail');
          },
        };
      },
    };
  });
  t.mock.method(News, 'findOne', (filter) => ({
    lean: async () => {
      const count = (state.reads.get(filter._id) || 0) + 1;
      state.reads.set(filter._id, count);
      options.beforeSourceRead?.(state, filter._id, count);
      if (filter._id === options.readFailureId) throw new Error('private record read detail');
      return clone(state.sources.find((doc) => matches(doc, filter)) || null);
    },
  }));
  t.mock.method(News, 'exists', async (filter) => {
    const found = state.sources.find((doc) => matches(doc, filter));
    return found ? { _id: found._id } : null;
  });
  t.mock.method(PublicArticle, 'find', (filter) => {
    let limit = Infinity;
    return {
      limit(value) { limit = value; return this; },
      lean: async () => clone(state.copies.filter((doc) => matches(doc, filter)).slice(0, limit)),
    };
  });
  t.mock.method(PublicArticle, 'findOneAndUpdate', (filter, update, updateOptions) => ({
    lean: async () => {
      state.activeSyncs += 1;
      state.maxActiveSyncs = Math.max(state.maxActiveSyncs, state.activeSyncs);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const sourceId = update.$set.sourceNewsId;
        if (sourceId === options.syncFailureId) throw new Error('private driver detail with article content');
        if (sourceId === options.nullSyncId) return null;
        assert.equal(updateOptions.upsert, true);
        assert.equal(updateOptions.runValidators, true);
        const index = state.copies.findIndex((doc) => matches(doc, filter));
        const saved = index < 0
          ? { _id: id(1000 + state.copies.length), createdAt: new Date('2026-01-01T00:00:00.000Z'), views: 0, ...clone(update.$setOnInsert) }
          : clone(state.copies[index]);
        Object.assign(saved, clone(update.$set));
        for (const field of Object.keys(update.$unset || {})) delete saved[field];
        const validationError = new PublicArticle(saved).validateSync();
        assert.equal(validationError, undefined);
        if (index < 0) state.copies.push(saved);
        else state.copies[index] = saved;
        state.writes.push({ filter, update, options: updateOptions });
        return clone(saved);
      } finally {
        state.activeSyncs -= 1;
      }
    },
  }));
  const sync = canonicalSync.syncPublicArticleFromNews;
  state.sync = t.mock.method(canonicalSync, 'syncPublicArticleFromNews', (...args) => sync(...args));
  return state;
}

function captureLogger() {
  const lines = [];
  return {
    lines,
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' ')),
  };
}

const isolatedEnv = {
  NODE_ENV: 'development',
  REGIONAL_RESYNC_MONGODB_URI: 'mongodb://127.0.0.1:27017/newspulse_resync_test',
  REGIONAL_RESYNC_DBNAME: 'newspulse_resync_test',
};

function mockConnection(t) {
  const connect = t.mock.method(mongoose, 'connect', async (uri, options) => {
    assert.equal(uri, isolatedEnv.REGIONAL_RESYNC_MONGODB_URI);
    assert.deepEqual(options, {
      dbName: isolatedEnv.REGIONAL_RESYNC_DBNAME,
      autoIndex: false,
      autoCreate: false,
      maxPoolSize: 1,
    });
    assert.equal(mongoose.get('autoIndex'), false);
    assert.equal(mongoose.get('autoCreate'), false);
    assert.equal(mongoose.get('bufferCommands'), false);
  });
  const disconnect = t.mock.method(mongoose, 'disconnect', async () => {});
  return { connect, disconnect };
}

test('CLI defaults to dry run; writes require the exact --apply flag and valid optional ID', () => {
  assert.deepEqual(parseArgs([]), { apply: false, newsId: null, help: false });
  assert.equal(parseArgs(['--dry-run']).apply, false);
  assert.deepEqual(parseArgs(['--apply', `--news-id=${id(1)}`]), { apply: true, newsId: id(1), help: false });
  for (const args of [
    ['--apply=false'], ['--apply=1'], ['--unknown'], ['--news-id='],
    ['--news-id=not-an-id'], ['--apply', '--dry-run'], ['--dry-run', '--apply'],
    [`--news-id=${id(1)}`, `--news-id=${id(2)}`],
  ]) {
    assert.throws(() => parseArgs(args));
  }
});

test('only exact published Regional CMS records without protected provenance qualify', () => {
  assert.equal(isEligibleNews(source()), true);
  assert.equal(isEligibleNews(null), false);
  for (const category of [
    'national', 'international', 'business', 'sports', 'tech', 'science-technology',
    'tech-gadgets', 'editorial', 'pulse-dialogue', 'breaking', 'sponsored',
    'community-reporter', 'youth-pulse', 'Regional', ' regional',
  ]) assert.equal(isEligibleNews(source(1, { category })), false, category);
  for (const status of ['draft', 'scheduled', 'archived', 'deleted', 'rejected', 'PUBLISHED']) {
    assert.equal(isEligibleNews(source(1, { status })), false, status);
  }
  for (const fields of [
    { deletedAt: historicalDate }, { isSponsored: true }, { isSponsoredArticle: true }, { isBreaking: true },
    { source: 'community' }, { sourceType: 'community_reporter' }, { sourceType: 'journalist' },
    { originType: 'Community Reporter' }, { submissionSource: 'community-reporter' },
    { communityReportId: id(90) }, { youthPulseSubmissionId: id(90) },
    { youthPulseContributorId: id(90) }, { sourceType: 'youth_pulse' },
  ]) assert.equal(isEligibleNews(source(1, fields)), false, JSON.stringify(fields));
});

test('dry run counts present/missing copies and skips exclusions with ZERO writes or sync calls', async (t) => {
  const sources = [
    source(1), source(2), source(3, { status: 'draft' }), source(4, { status: 'scheduled' }),
    source(5, { status: 'deleted' }), source(6, { category: 'national' }),
    source(7, { isSponsored: true }), source(8, { source: 'community' }),
    source(9, { deletedAt: historicalDate }),
  ];
  const existing = publicCopy(sources[0]);
  const store = installStore(t, sources, [existing]);
  const result = await resyncPublishedRegionalArticles();
  assert.equal(result.mode, 'DRY RUN');
  assert.equal(result.scanned, 5);
  assert.equal(result.eligible, 2);
  assert.equal(result.publicCopiesPresent, 1);
  assert.equal(result.missingPublicCopies, 1);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.wouldUpdate, 1);
  assert.equal(result.skipped, 3);
  assert.equal(result.failed, 0);
  assert.equal(result.created + result.updated, 0);
  assert.equal(store.sync.mock.callCount(), 0);
  assert.equal(store.writes.length, 0);
  assert.deepEqual(store.sources, sources);
  assert.deepEqual(store.copies, [existing]);
  assert.deepEqual(store.findFilters, [{ category: 'regional', status: 'published' }]);
  assert.equal(store.closed, true);
});

test('shared visibility rules also skip private, locked, embargoed and future-dated News', async (t) => {
  const future = new Date(Date.now() + 86400000);
  const restrictions = [
    { visibility: 'private' }, { isPrivate: true }, { locked: true }, { embargoUntil: future },
    { publishedAt: future }, { publishAt: future }, { scheduledAt: future },
    { workflow: { locked: true } }, { workflow: { embargoUntil: future } },
  ];
  const store = installStore(t, restrictions.map((fields, index) => source(index + 1, fields)));
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.scanned, restrictions.length);
  assert.equal(result.skipped, restrictions.length);
  assert.equal(result.eligible, 0);
  assert.equal(store.sync.mock.callCount(), 0);
  assert.equal(store.writes.length, 0);
});

for (const [label, provenance] of [
  ['Sponsored', { isSponsored: true }],
  ['Sponsored Article', { isSponsoredArticle: true }],
  ['Community Reporter', { source: 'community' }],
  ['community submission linkage', { communityReportId: id(90) }],
  ['Youth Pulse', { sourceType: 'youth_pulse' }],
  ['deleted source', { deletedAt: historicalDate }],
]) {
  test(`a translated child without its own ${label} markers remains excluded`, async (t) => {
    const parent = source(1, provenance);
    const child = source(2, {
      sourceArticleId: parent._id,
      translationGroupId: parent.translationGroupId,
      translationKey: parent.translationKey,
    });
    const store = installStore(t, [parent, child]);
    for (const apply of [false, true]) {
      const result = await resyncPublishedRegionalArticles({ apply, newsId: child._id });
      assert.equal(result.scanned, 1);
      assert.equal(result.skipped, 1);
      assert.equal(result.eligible, 0);
      assert.equal(result.failed, 0);
    }
    assert.equal(store.sync.mock.callCount(), 0);
    assert.deepEqual(store.sources, [parent, child]);
  });
}

for (const [label, sourceId, code] of [
  ['missing parent', id(99), 'MISSING_TRANSLATION_SOURCE'],
  ['malformed parent', 'invalid-parent', 'INVALID_TRANSLATION_SOURCE_ID'],
]) {
  test(`unverifiable source lineage fails closed: ${label}`, async (t) => {
    const child = source(2, { sourceArticleId: sourceId });
    const store = installStore(t, [child]);
    const result = await resyncPublishedRegionalArticles({ apply: true });
    assert.deepEqual(result.failures, [{ newsId: child._id, code }]);
    assert.equal(store.sync.mock.callCount(), 0);
  });
}

test('source-link cycles fail closed while a self-linked source remains valid', async (t) => {
  const store = installStore(t, [
    source(1, { sourceArticleId: id(2) }),
    source(2, { sourceArticleId: id(1) }),
    source(3, { sourceArticleId: id(3) }),
  ]);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.failed, 2);
  assert.ok(result.failures.every((failure) => failure.code === 'TRANSLATION_SOURCE_CYCLE'));
  assert.equal(result.created, 1);
  assert.equal(store.copies[0].sourceNewsId, id(3));
});

test('ancestry checks do not copy parent geography or media into a published child', async (t) => {
  const parent = source(1, { geo: { state: 'gujarat' }, sourceArticleId: id(1) });
  const child = source(2, { sourceArticleId: parent._id, geo: { state: 'maharashtra' } });
  const store = installStore(t, [parent, child]);
  const result = await resyncPublishedRegionalArticles({ apply: true, newsId: child._id });
  assert.equal(result.created, 1);
  assert.equal(result.failed, 0);
  assert.equal(store.copies[0].geo.state, 'maharashtra');
  assert.deepEqual(store.copies[0].coverImage, child.coverImage);
  assert.deepEqual(store.sources, [parent, child]);
});

test('apply creates a missing Public Article only through canonical sync with its original publication date', async (t) => {
  const news = source();
  const store = installStore(t, [news]);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.failed, 0);
  assert.equal(store.sync.mock.callCount(), 1);
  assert.equal(store.copies.length, 1);
  const saved = store.copies[0];
  assert.equal(saved.sourceNewsId, news._id);
  assert.equal(saved.sourceArticleId, news._id);
  assert.equal(saved.slug, news.slug);
  assert.equal(saved.status, 'published');
  assert.deepEqual(saved.publishedAt, historicalDate);
  assert.deepEqual(saved.coverImage, news.coverImage);
  assert.deepEqual(store.sources, [news]);
  assert.deepEqual(store.writes[0].filter, { $or: [{ sourceNewsId: news._id }, { slug: news.slug }] });
});

test('apply refreshes canonical-owned fields in place without changing IDs, URLs, dates, views or analytics', async (t) => {
  const news = source(1, { location: { state: 'Gujarat' } });
  const existing = publicCopy(news);
  const store = installStore(t, [news], [existing]);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(result.failed, 0);
  assert.equal(store.copies.length, 1);
  const saved = store.copies[0];
  for (const field of [
    '_id', 'sourceNewsId', 'sourceArticleId', 'slug', 'slugs', 'createdAt', 'publishedAt',
    'views', 'analyticsId', 'status', 'translationGroupId', 'translationKey', 'seo', 'coverImage',
  ]) assert.deepEqual(saved[field], existing[field], field);
  assert.equal(saved.title, news.title);
  assert.equal(saved.content, news.content);
  assert.equal(saved.geo.state, 'gujarat');
  assert.deepEqual(store.sources, [news]);
  for (const field of ['_id', 'createdAt', 'views', 'analyticsId']) {
    assert.equal(Object.hasOwn(store.writes[0].update.$set, field), false, field);
  }
});

test('running apply twice reuses the same copy without duplicates or republication', async (t) => {
  const store = installStore(t, [source()]);
  const first = await resyncPublishedRegionalArticles({ apply: true });
  const snapshot = clone(store.copies);
  const second = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(first.created, 1);
  assert.equal(second.created, 0);
  assert.equal(second.updated, 1);
  assert.equal(first.failed + second.failed, 0);
  assert.deepEqual(store.copies, snapshot);
});

test('a unique legacy slug-only public copy is linked and updated instead of duplicated', async (t) => {
  const news = source();
  const existing = publicCopy(news, { sourceNewsId: null });
  const store = installStore(t, [news], [existing]);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.updated, 1);
  assert.equal(result.created, 0);
  assert.equal(store.copies.length, 1);
  assert.equal(store.copies[0]._id, existing._id);
  assert.equal(store.copies[0].sourceNewsId, news._id);
  assert.equal(store.copies[0].views, existing.views);
});

for (const [label, metadata, expectedState] of [
  ['explicit geo', { geo: { state: 'gujarat', district: 'ahmedabad', city: 'gandhinagar' } }, 'gujarat'],
  ['display location', { location: { state: 'Gujarat', district: 'Ahmedabad', city: 'Gandhinagar' } }, 'gujarat'],
  ['location slugs', { location: { stateSlug: 'gujarat', districtSlug: 'ahmedabad', citySlug: 'gandhinagar' } }, 'gujarat'],
  ['legacy state', { state: 'Gujarat', district: 'Ahmedabad', city: 'Gandhinagar' }, 'gujarat'],
  ['existing geographic tags', { tags: ['desk:regional', 'state:GJ', 'district:Ahmedabad', 'city:Gandhinagar'] }, 'gujarat'],
  ['Maharashtra', { geo: { state: 'maharashtra', district: 'pune', city: 'pune' }, title: 'Gujarat comparison' }, 'maharashtra'],
  ['city alone', { location: { city: 'Ahmedabad' }, title: 'Gujarat headline' }, null],
  ['body and national stateTags only', { title: 'Gujarat headline', description: 'Gujarat summary', content: 'Gujarat Ahmedabad body', stateTags: ['gujarat'], stateNames: ['Gujarat'] }, null],
]) {
  test(`geography uses only canonical source metadata: ${label}`, async (t) => {
    const news = source(1, metadata);
    const store = installStore(t, [news], [publicCopy(news, { geo: { state: 'stale' } })]);
    const result = await resyncPublishedRegionalArticles({ apply: true });
    assert.equal(result.updated, 1);
    assert.equal(result.failed, 0);
    const saved = store.copies[0];
    assert.equal(saved.geo.state, expectedState);
    assert.equal(saved.tags.includes('state:gujarat'), expectedState === 'gujarat');
    assert.ok(news.tags.every((tag) => saved.tags.includes(tag)));
    if (expectedState === 'gujarat') {
      assert.equal(saved.geo.district, 'ahmedabad');
      assert.equal(saved.geo.city, 'gandhinagar');
    }
    assert.deepEqual(store.sources, [news]);
  });
}

test('EN HI GU source links, human translations, readiness and child-specific media remain intact', async (t) => {
  const sources = ['en', 'hi', 'gu'].map((language, index) => source(index + 1, {
    language,
    lang: language,
    originalLang: language,
    sourceLanguage: 'en',
    sourceArticleId: id(1),
    translationGroupId: 'one-language-group',
    translationKey: 'one-language-group',
    humanEdited: true,
    translationReviewStatus: 'approved',
    slug: `regional-${language}`,
    slugs: { [language]: `regional-${language}` },
    gallery: [`https://images.example.test/${language}-gallery.jpg`],
    externalUrls: [`https://example.test/${language}`],
    embeds: [`<iframe title="${language}"></iframe>`],
    coverImage: { url: `https://images.example.test/${language}-custom.jpg`, publicId: language, alt: language },
    translations: {
      [language]: { title: `${language} manual title`, summary: `${language} manual summary`, content: `${language} human-edited content`, provider: 'manual', generatedAt: historicalDate },
    },
  }));
  const existing = sources.map((news) => publicCopy(news));
  const store = installStore(t, sources, existing);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.updated, 3);
  assert.equal(result.failed, 0);
  assert.equal(new Set(store.copies.map((copy) => copy._id)).size, 3);
  for (const news of sources) {
    const copy = store.copies.find((item) => item.sourceNewsId === news._id);
    for (const field of [
      'language', 'originalLang', 'sourceLanguage', 'sourceArticleId', 'translationGroupId', 'translationKey',
      'slug', 'slugs', 'coverImage', 'gallery', 'embeds', 'externalUrls', 'translationStatus',
    ]) assert.deepEqual(copy[field], news[field], field);
    assert.deepEqual(copy.translations[news.language], news.translations[news.language]);
    assert.equal(copy.status, 'published');
    assert.deepEqual(copy.publishedAt, historicalDate);
  }
  assert.deepEqual(store.sources, sources);
  assert.equal(global.fetch.mock.callCount(), 0);
  assert.equal(googleTranslate.translateMany.mock.callCount(), 0);
});

for (const [label, fields, code] of [
  ['missing historical timestamp', { publishedAt: null }, 'MISSING_OR_INVALID_PUBLISHED_AT'],
  ['missing slug', { slug: '' }, 'MISSING_SOURCE_SLUG'],
  ['slug requiring regeneration', { slug: 'UPPERCASE-SLUG' }, 'NON_CANONICAL_SOURCE_SLUG'],
  ['missing title', { title: '' }, 'MISSING_SOURCE_TITLE'],
  ['unsupported language', { language: 'fr', lang: 'fr' }, 'SOURCE_LANGUAGE_CONFLICT'],
  ['inconsistent language', { language: 'en', lang: 'gu' }, 'SOURCE_LANGUAGE_CONFLICT'],
]) {
  test(`unsafe source is reported without writes in either mode: ${label}`, async (t) => {
    const store = installStore(t, [source(1, fields)]);
    for (const apply of [false, true]) {
      const result = await resyncPublishedRegionalArticles({ apply });
      assert.equal(result.failed, 1);
      assert.deepEqual(result.failures, [{ newsId: id(1), code }]);
      assert.equal(result.created + result.updated + result.wouldCreate + result.wouldUpdate, 0);
    }
    assert.equal(store.writes.length, 0);
    assert.equal(store.sync.mock.callCount(), 0);
  });
}

for (const [label, fields, code] of [
  ['other category', { category: 'national' }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['draft status', { status: 'draft' }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['scheduled status', { status: 'scheduled' }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['archived status', { status: 'archived' }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['deleted status', { status: 'deleted' }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['deleted marker', { deletedAt: historicalDate }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['sponsored flag', { isSponsored: true }, 'PUBLIC_COPY_OUT_OF_SCOPE'],
  ['other source link', { sourceNewsId: id(90) }, 'PUBLIC_IDENTITY_CONFLICT'],
  ['other translation parent', { sourceArticleId: id(90) }, 'PUBLIC_IDENTITY_CONFLICT'],
  ['other translation group', { translationGroupId: 'different-group' }, 'PUBLIC_IDENTITY_CONFLICT'],
  ['other translation key', { translationKey: 'different-key' }, 'PUBLIC_IDENTITY_CONFLICT'],
  ['other language', { language: 'gu' }, 'PUBLIC_IDENTITY_CONFLICT'],
  ['other source language', { sourceLanguage: 'gu' }, 'PUBLIC_IDENTITY_CONFLICT'],
  ['changed slug', { slug: 'old-historical-slug' }, 'PUBLIC_SLUG_CONFLICT'],
  ['changed localized slug', { slugs: { hi: 'historical-hindi-slug' } }, 'PUBLIC_SLUG_CONFLICT'],
  ['changed canonical URL', { seo: { canonicalUrl: 'https://example.test/original-url' } }, 'CANONICAL_URL_CONFLICT'],
  ['changed historical date', { publishedAt: new Date('2020-01-01T00:00:00.000Z') }, 'PUBLICATION_DATE_CONFLICT'],
]) {
  test(`conflicting existing identity is preserved for Founder review: ${label}`, async (t) => {
    const news = source();
    const existing = publicCopy(news, fields);
    const store = installStore(t, [news], [existing]);
    for (const apply of [false, true]) {
      const result = await resyncPublishedRegionalArticles({ apply });
      assert.equal(result.failed, 1);
      assert.deepEqual(result.failures, [{ newsId: news._id, code }]);
      assert.equal(result.created + result.updated + result.wouldCreate + result.wouldUpdate, 0);
    }
    assert.deepEqual(store.copies, [existing]);
    assert.equal(store.sync.mock.callCount(), 0);
  });
}

test('ambiguous source/slug matches are not merged, duplicated or overwritten', async (t) => {
  const news = source();
  const existing = [publicCopy(news), publicCopy(news, { _id: id(901), sourceNewsId: null })];
  const store = installStore(t, [news], existing);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.deepEqual(result.failures, [{ newsId: news._id, code: 'AMBIGUOUS_PUBLIC_COPIES' }]);
  assert.deepEqual(store.copies, existing);
  assert.equal(store.writes.length, 0);
});

test('duplicate source slugs, even in another category, cannot claim a legacy copy', async (t) => {
  const news = source();
  const other = source(2, { slug: news.slug, category: 'national' });
  const existing = publicCopy(news, { sourceNewsId: null });
  const store = installStore(t, [news, other], [existing]);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.equal(result.scanned, 1);
  assert.deepEqual(result.failures, [{ newsId: news._id, code: 'SOURCE_SLUG_COLLISION' }]);
  assert.deepEqual(store.copies, [existing]);
  assert.equal(store.sync.mock.callCount(), 0);
});

test('single-article mode restricts the query without admitting a draft or another category', async (t) => {
  const store = installStore(t, [source(1), source(2), source(3, { status: 'draft' }), source(4, { category: 'national' })]);
  const result = await resyncPublishedRegionalArticles({ apply: true, newsId: id(2) });
  assert.equal(result.scanned, 1);
  assert.equal(result.created, 1);
  assert.equal(store.copies[0].sourceNewsId, id(2));
  for (const newsId of [id(3), id(4), id(99)]) {
    const excluded = await resyncPublishedRegionalArticles({ apply: true, newsId });
    assert.equal(excluded.scanned, 0);
    assert.equal(excluded.created + excluded.updated, 0);
  }
  assert.deepEqual(store.findFilters[0], { category: 'regional', status: 'published', _id: id(2) });
  assert.equal(store.copies.length, 1);
});

for (const failure of ['syncFailureId', 'nullSyncId', 'readFailureId']) {
  test(`one ${failure} does not stop or corrupt other records; execution stays sequential`, async (t) => {
    const sources = [source(1), source(2), source(3)];
    const store = installStore(t, sources, [], { [failure]: id(2) });
    const result = await resyncPublishedRegionalArticles({ apply: true });
    assert.equal(result.scanned, 3);
    assert.equal(result.created, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.complete, true);
    assert.deepEqual(result.failures, [{
      newsId: id(2),
      code: failure === 'readFailureId' ? 'RECORD_RESYNC_FAILED' : 'PUBLIC_ARTICLE_SYNC_FAILED',
    }]);
    assert.deepEqual(store.copies.map((copy) => copy.sourceNewsId), [id(1), id(3)]);
    assert.deepEqual(store.sources, sources);
    assert.equal(store.maxActiveSyncs, 1);
    assert.equal(JSON.stringify(result).includes('private'), false);
    assert.equal(store.closed, true);
  });
}

test('a source unpublished or edited during preflight is not synchronized from the stale snapshot', async (t) => {
  const store = installStore(t, [source(1), source(2)], [], {
    beforeSourceRead(state, newsId, count) {
      if (newsId === id(1) && count === 2) state.sources[0].status = 'draft';
    },
  });
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.deepEqual(result.failures, [{ newsId: id(1), code: 'SOURCE_CHANGED_DURING_RESYNC' }]);
  assert.equal(result.created, 1);
  assert.equal(store.copies[0].sourceNewsId, id(2));
});

test('scan failure preserves partial counts, closes the cursor and reports incomplete safely', async (t) => {
  const store = installStore(t, [source(1), source(2)], [], { scanFailureAfter: 1 });
  const result = await resyncPublishedRegionalArticles();
  assert.equal(result.scanned, 1);
  assert.equal(result.wouldCreate, 1);
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors, ['NEWS_SCAN_FAILED']);
  assert.equal(store.closed, true);
  assert.equal(store.writes.length, 0);
});

test('cursor cleanup failures are explicit rather than success-shaped', async (t) => {
  installStore(t, [], [], { closeFailure: true });
  const result = await resyncPublishedRegionalArticles();
  assert.equal(result.complete, false);
  assert.deepEqual(result.errors, ['NEWS_CURSOR_CLOSE_FAILED']);
});

test('CLI dry run disables implicit DDL and reports counts without content or provider calls', async (t) => {
  const news = source();
  const store = installStore(t, [news]);
  const connection = mockConnection(t);
  const logger = captureLogger();
  const exitCode = await main({ args: [], env: isolatedEnv, logger });
  assert.equal(exitCode, 0);
  assert.deepEqual(logger.lines, [
    'MODE: DRY RUN', 'Scanned: 1', 'Eligible: 1', 'Public copies present: 0', 'Missing public copies: 1',
    'Would create: 1', 'Would update: 0', 'Skipped: 0', 'Failed: 0', 'Complete: yes',
  ]);
  assert.equal(connection.connect.mock.callCount(), 1);
  assert.equal(connection.disconnect.mock.callCount(), 1);
  assert.equal(store.writes.length, 0);
  assert.equal(store.sync.mock.callCount(), 0);
  assert.equal(require('dotenv').config.mock.callCount(), 0);
  assert.equal(global.fetch.mock.callCount(), 0);
  assert.equal(googleTranslate.translateMany.mock.callCount(), 0);
  for (const value of [news.title, news.description, news.content, isolatedEnv.REGIONAL_RESYNC_MONGODB_URI]) {
    assert.equal(logger.lines.join('\n').includes(value), false);
  }
});

test('CLI apply summary reports created/updated counts using only the mocked database', async (t) => {
  const news = source();
  const store = installStore(t, [news, source(2)], [publicCopy(news)]);
  const connection = mockConnection(t);
  const logger = captureLogger();
  assert.equal(await main({ args: ['--apply'], env: isolatedEnv, logger }), 0);
  assert.deepEqual(logger.lines, [
    'MODE: APPLY', 'Scanned: 2', 'Eligible: 2', 'Public copies present: 1', 'Missing public copies: 1',
    'Created: 1', 'Updated: 1', 'Skipped: 0', 'Failed: 0', 'Complete: yes',
  ]);
  assert.equal(store.sync.mock.callCount(), 2);
  assert.equal(connection.disconnect.mock.callCount(), 1);
});

test('missing source publishedAt cannot overwrite or republish an existing historical copy', async (t) => {
  const news = source(1, { publishedAt: null });
  const existing = publicCopy(news, { publishedAt: historicalDate });
  const store = installStore(t, [news], [existing]);
  const result = await resyncPublishedRegionalArticles({ apply: true });
  assert.deepEqual(result.failures, [{ newsId: news._id, code: 'MISSING_OR_INVALID_PUBLISHED_AT' }]);
  assert.deepEqual(store.copies, [existing]);
  assert.equal(store.sync.mock.callCount(), 0);
});

test('CLI refuses an already-open application connection without disconnecting it', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, value: 1 });
  t.after(() => {
    if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
    else delete mongoose.connection.readyState;
  });
  const disconnect = t.mock.method(mongoose, 'disconnect', async () => {});
  const logger = captureLogger();
  assert.equal(await main({ args: [], env: isolatedEnv, logger }), 1);
  assert.ok(logger.lines.includes('Run error: EXISTING_CONNECTION_REFUSED'));
  assert.equal(mongoose.connect.mock.callCount(), 0);
  assert.equal(disconnect.mock.callCount(), 0);
});

test('CLI does not fall back to application database settings or load dotenv', async () => {
  const logger = captureLogger();
  const exitCode = await main({ args: [], env: { NODE_ENV: 'test', MONGODB_URI: 'private application setting', MONGO_URI: 'private legacy setting' }, logger });
  assert.equal(exitCode, 1);
  assert.ok(logger.lines.includes('Run error: EXPLICIT_RESYNC_CONNECTION_REQUIRED'));
  assert.equal(mongoose.connect.mock.callCount(), 0);
  assert.equal(require('dotenv').config.mock.callCount(), 0);
  assert.equal(logger.lines.join('\n').includes('private'), false);
});

test('local isolation refuses production-looking database names and the live test database before connection', async () => {
  for (const dbName of ['test', 'newspulse', 'newspulse-production']) {
    const logger = captureLogger();
    const exitCode = await main({ args: [], env: { ...isolatedEnv, REGIONAL_RESYNC_DBNAME: dbName }, logger });
    assert.equal(exitCode, 1);
    assert.ok(logger.lines.includes('Run error: ENV_SAFETY_LOCAL_DB_REFUSED'));
  }
  assert.equal(mongoose.connect.mock.callCount(), 0);
});

test('CLI unknown/unsafe arguments fail before any connection and never echo argument values', async () => {
  for (const args of [['--apply=false'], ['--news-id=private-input'], ['--apply', '--dry-run']]) {
    const logger = captureLogger();
    assert.equal(await main({ args, env: isolatedEnv, logger }), 1);
    assert.equal(logger.lines.join('\n').includes('private-input'), false);
    assert.ok(logger.lines.includes('Complete: no'));
  }
  assert.equal(mongoose.connect.mock.callCount(), 0);
});

test('CLI help does not need configuration or open a connection', async () => {
  const logger = captureLogger();
  assert.equal(await main({ args: ['--help'], env: {}, logger }), 0);
  assert.equal(mongoose.connect.mock.callCount(), 0);
  assert.ok(logger.lines[0].startsWith('Usage:'));
});

test('CLI connection failure prints a safe summary and disconnects without exposing driver details', async (t) => {
  t.mock.method(mongoose, 'connect', async () => { throw new Error('private database connection detail'); });
  const disconnect = t.mock.method(mongoose, 'disconnect', async () => {});
  const logger = captureLogger();
  assert.equal(await main({ args: [], env: isolatedEnv, logger }), 1);
  assert.ok(logger.lines.includes('MODE: DRY RUN'));
  assert.ok(logger.lines.includes('Run error: DATABASE_CONNECTION_FAILED'));
  assert.ok(logger.lines.includes('Complete: no'));
  assert.equal(logger.lines.join('\n').includes('private'), false);
  assert.equal(disconnect.mock.callCount(), 1);
});

test('CLI record failures print only a safe News ID/code, keep final counts, and exit nonzero', async (t) => {
  installStore(t, [source(1, { publishedAt: null }), source(2)]);
  mockConnection(t);
  const logger = captureLogger();
  assert.equal(await main({ args: [], env: isolatedEnv, logger }), 1);
  assert.ok(logger.lines.includes('Scanned: 2'));
  assert.ok(logger.lines.includes('Would create: 1'));
  assert.ok(logger.lines.includes('Failed: 1'));
  assert.ok(logger.lines.includes(`News ${id(1)}: MISSING_OR_INVALID_PUBLISHED_AT`));
  assert.equal(logger.lines.some((line) => /headline|summary|body|mongodb:/.test(line)), false);
});

test('CLI disconnect errors are safely reported as incomplete', async (t) => {
  installStore(t, []);
  mockConnection(t);
  t.mock.method(mongoose, 'disconnect', async () => { throw new Error('private disconnect detail'); });
  const logger = captureLogger();
  assert.equal(await main({ args: [], env: isolatedEnv, logger }), 1);
  assert.ok(logger.lines.includes('Run error: DATABASE_DISCONNECT_FAILED'));
  assert.ok(logger.lines.includes('Complete: no'));
  assert.equal(logger.lines.join('\n').includes('private'), false);
});

test('programmatic entry points reject truthy nonboolean apply values and malformed IDs', async () => {
  await assert.rejects(() => resyncPublishedRegionalArticles({ apply: 'false' }), { code: 'INVALID_APPLY_OPTION' });
  await assert.rejects(() => resyncPublishedRegionalArticles({ newsId: { $ne: null } }), { code: 'INVALID_NEWS_ID' });
  assert.equal(mongoose.connect.mock.callCount(), 0);
});
