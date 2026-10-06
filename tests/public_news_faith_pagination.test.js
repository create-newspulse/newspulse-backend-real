require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const News = require('../models/News');
const { langMiddleware } = require('../middleware/lang');
const router = require('../routes/publicNews.routes');
const controller = require('../controllers/publicNewsController');
const { getPublicContentGroupKey, buildPublicContentGroupExpression } = require('../services/publicCategoryListing.service');
const { matches, runPipeline } = require('./helpers/pulseDialogueAggregate');

const objectId = number => new mongoose.Types.ObjectId(number.toString(16).padStart(24, '0'));
const languages = ['en', 'hi', 'gu'];
const ordinaryCategories = [
  'regional', 'national', 'international', 'business', 'tech', 'tech-gadgets', 'sports', 'lifestyle', 'glamour',
  'editorial', 'web-stories', 'viral-videos', 'pulse-dialogue', 'youth-pulse', 'community-reporter', 'inspiration-hub',
];
const bucket = lang => ({ title: `${lang} translated title`, summary: `${lang} translated summary`, content: `${lang} translated content` });

function story(number, lang = 'en', overrides = {}) {
  const publishedAt = new Date(Date.UTC(2020, 0, 1) - number * 1000);
  return {
    _id: objectId(number), translationKey: `group-${number}`, slug: `story-${number}`,
    category: 'faith-culture', status: 'published', lang, language: lang, originalLang: lang,
    title: `${lang} title ${number}`, description: `${lang} summary ${number}`, content: `${lang} body ${number}`,
    publishedAt, createdAt: publishedAt, updatedAt: publishedAt, ...overrides,
  };
}

function setup(context, initial = [], { legacy = false } = {}) {
  const state = { docs: initial, aggregates: [], finds: [], beforeHydrate: null };
  const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, writable: true, value: 1 });
  context.after(() => {
    if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
    else delete mongoose.connection.readyState;
  });
  context.mock.method(News, 'aggregate', pipeline => {
    assert.equal(legacy, false, 'ordinary categories must not use the Faith aggregation');
    state.aggregates.push(pipeline);
    return { option(options) {
      assert.deepEqual(options, { maxTimeMS: 2500, allowDiskUse: true, collation: { locale: 'simple' } });
      return this;
    }, exec: async () => runPipeline(state.docs, pipeline) };
  });
  context.mock.method(News, 'find', filter => {
    if (state.beforeHydrate) state.beforeHydrate();
    const capture = { filter };
    state.finds.push(capture);
    let docs = state.docs.filter(doc => matches(doc, filter)).slice().reverse();
    return {
      select(fields) {
        capture.select = fields;
        docs = runPipeline(docs, [{ $project: Object.fromEntries(fields.split(' ').map(field => [field, 1])) }]);
        return this;
      },
      collation(value) { capture.collation = value; return this; },
      sort(value) { capture.sort = value; docs = runPipeline(docs, [{ $sort: value }]); return this; },
      skip(value) { capture.skip = value; docs = docs.slice(value); return this; },
      limit(value) { capture.limit = value; docs = docs.slice(0, value); return this; },
      maxTimeMS(value) { assert.equal(value, 2500); return this; },
      lean: async () => docs,
    };
  });
  context.mock.method(News, 'countDocuments', () => { assert.fail('the category total must count logical groups'); });
  for (const method of ['create', 'updateOne', 'updateMany', 'deleteMany']) {
    context.mock.method(News, method, () => { assert.fail('public pagination must not write data'); });
  }
  const app = express();
  app.use(langMiddleware);
  app.use('/api/public/news', router);
  state.get = (params = {}) => request(app).get('/api/public/news').query({
    category: 'faith-culture', lang: 'en', page: '1', limit: '30', ...params,
  });
  return state;
}

function success(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'], 'no-store');
  return response.body;
}

for (const lang of languages) {
  test(`Faith ${lang}: 100 stories paginate 30/30/30/10 without overlap or updatedAt promotion`, async context => {
    const docs = Array.from({ length: 100 }, (_, i) => story(i + 1, lang));
    docs[99].updatedAt = new Date('2999-01-01');
    const state = setup(context, docs);
    const seen = [];
    for (const page of [1, 2, 3, 4]) {
      const result = success(await state.get({ lang, page: String(page) }));
      const length = page === 4 ? 10 : 30;
      assert.equal(result.page, page); assert.equal(result.limit, 30);
      assert.equal(result.total, 100); assert.equal(result.totalPages, 4);
      assert.equal(result.hasMore, page < 4);
      assert.equal(result.items.length, length);
      assert.deepEqual(result.items.map(item => item._id), Array.from({ length }, (_, i) => String(objectId((page - 1) * 30 + i + 1))));
      assert.ok(result.items.every(item => item.resolvedLanguage === lang && item.language === lang && item.isFallback === false));
      seen.push(...result.items.map(item => item._id));
    }
    assert.equal(new Set(seen).size, 100);
  });

  test(`Faith ${lang}: 61 tied timestamps remain deterministic despite changing database input order`, async context => {
    const docs = Array.from({ length: 61 }, (_, i) => story(i + 1, lang, {
      publishedAt: new Date('2020-01-01'), createdAt: new Date('2020-01-01'),
    }));
    const state = setup(context, docs);
    const ids = [];
    for (const page of [1, 2, 3]) {
      state.docs = page === 2 ? docs.slice().reverse() : [...docs.slice(17), ...docs.slice(0, 17)];
      const result = success(await state.get({ lang, page: String(page) }));
      ids.push(...result.items.map(item => item._id));
    }
    assert.deepEqual(ids, Array.from({ length: 61 }, (_, i) => String(objectId(61 - i))));
    assert.equal(new Set(ids).size, 61);
  });

  test(`Faith ${lang}: eligibility precedes grouping, pagination and totals`, async context => {
    const base = lang === 'en' ? 'gu' : 'en';
    const docs = Array.from({ length: 100 }, (_, i) => story(i + 1, base, i >= 90 ? {
      translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: 'ready' },
    } : {}));
    docs.push(story(201, lang, { translationKey: 'group-91' }));
    const state = setup(context, docs);
    for (const flags of [{ strictLocale: 'true' }, { strictLocale: 'false', fallback: 'true', allowFallback: 'true' }]) {
      const result = success(await state.get({ lang, ...flags }));
      assert.equal(result.total, 10); assert.equal(result.totalPages, 1);
      assert.equal(result.items.length, 10); assert.equal(result.hasMore, false);
      assert.ok(result.items.every(item => item.resolvedLanguage === lang && !item.isFallback));
      assert.ok(result.items.some(item => item._id === String(objectId(201))), 'native representation wins its group');
      assert.equal(new Set(result.items.map(item => item.translationKey)).size, 10);
    }
    const next = success(await state.get({ lang, page: '2' }));
    assert.equal(next.total, 10); assert.deepEqual(next.items, []); assert.equal(next.hasMore, false);
  });

  test(`Faith ${lang}: native, READY, approval, legacy and incomplete translation policies`, async context => {
    const base = lang === 'en' ? 'gu' : 'en';
    const docs = [story(1, lang, { translationReviewStatus: 'approved', translationStatus: { [lang]: 'pending' } })];
    const allowed = [String(objectId(1))];
    let number = 2;
    for (const status of ['ready', 'READY', ' ready ', 'pending', 'failed', 'rejected', 'APPROVED', 'approved', null, undefined]) {
      const doc = story(number++, base, { translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: status } });
      docs.push(doc);
      if (String(status).trim().toLowerCase() === 'ready') allowed.push(String(doc._id));
    }
    for (const field of ['title', 'summary', 'content']) {
      for (const missing of [undefined, null, '', ' \n\t ', 42, ['not', 'text']]) {
        docs.push(story(number++, base, {
          translations: { [lang]: { ...bucket(lang), [field]: missing } }, translationStatus: { [lang]: 'ready' },
        }));
      }
    }
    docs.push(story(number++, base, {
      translationReviewStatus: 'approved', translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: 'pending' },
    }));
    docs.push(story(number++, base, {
      status: 'draft', translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: 'ready' },
    }));
    for (const field of ['title', 'description', 'content']) docs.push(story(number++, lang, { [field]: '' }));
    const legacy = story(number++, base, {
      originalLang: null, lang: '', translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: 'ready' },
    });
    docs.push(legacy); allowed.push(String(legacy._id));
    const legacySummary = story(number++, lang, { description: undefined, summary: 'Legacy summary' });
    docs.push(legacySummary); allowed.push(String(legacySummary._id));
    const result = success(await setup(context, docs).get({ lang, limit: '100' }));
    assert.equal(result.total, allowed.length);
    assert.deepEqual(result.items.map(item => item._id).sort(), allowed.sort());
    assert.ok(result.items.every(item => item.resolvedLanguage === lang && !item.isFallback));
  });
}

test('Faith publication date fallback uses publishAt/createdAt, never updatedAt', async context => {
  const state = setup(context, [
    story(1, 'en', { publishedAt: new Date('2020-05-01'), publishAt: new Date('2019-01-01') }),
    story(2, 'en', { publishedAt: null, publishAt: new Date('2020-04-01'), createdAt: new Date('2020-06-01') }),
    story(3, 'en', { publishedAt: undefined, createdAt: new Date('2020-03-01') }),
    story(4, 'en', { publishedAt: new Date('2020-02-01'), updatedAt: new Date('2999-01-01') }),
    story(5, 'en', { publishedAt: null, createdAt: undefined }),
  ]);
  assert.deepEqual(success(await state.get()).items.map(item => item._id), [1, 2, 3, 4, 5].map(number => String(objectId(number))));
});

test('Faith enforces exact category and every shared publication visibility gate', async context => {
  const exclusions = [
    { category: 'faith_culture' }, { category: 'faith-culture-extra' }, { category: 'national' }, { category: '' },
    { status: 'draft' }, { status: 'scheduled' }, { status: 'archived' }, { status: 'deleted' }, { status: 'rejected' },
    { deletedAt: new Date() }, { locked: true }, { visibility: 'private' }, { visibility: 'PRIVATE' }, { isPrivate: true },
    { embargoUntil: new Date('2999-01-01') }, { publishedAt: new Date('2999-01-01') },
    { publishAt: new Date('2999-01-01') }, { scheduledAt: new Date('2999-01-01') },
    { workflow: { locked: true } }, { workflow: { embargoUntil: new Date('2999-01-01') } },
  ];
  const state = setup(context, [story(1), story(2, 'en', { category: 'Faith-Culture' }),
    ...exclusions.map((change, i) => story(i + 100, 'en', { translationKey: 'group-1', ...change }))]);
  for (const category of ['faith-culture', 'Faith_Culture']) {
    const result = success(await state.get({ category }));
    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map(item => item._id), [1, 2].map(number => String(objectId(number))));
  }
});

test('Faith Mongo group identity agrees with existing logical-story identity including case-sensitive keys', async context => {
  const docs = [
    story(1, 'en', { translationKey: 'same' }),
    story(2, 'en', { translationKey: null, translationGroupId: 'same' }),
    story(3, 'en', { translationKey: 'Case' }), story(4, 'en', { translationKey: 'case' }),
    story(5, 'en', { translationKey: '', slugs: { en: 'canonical' } }),
    story(6, 'en', { translationKey: null, slug: 'canonical' }),
    story(7, 'en', { translationKey: null, slug: null, slugs: { hi: 'legacy-hi' } }),
    story(8, 'en', { translationKey: null, slug: null }),
  ];
  const identities = runPipeline(docs, [{ $project: { key: buildPublicContentGroupExpression() } }]);
  assert.deepEqual(identities.map(doc => doc.key), docs.map(getPublicContentGroupKey));
  const result = success(await setup(context, docs).get());
  assert.equal(result.total, new Set(docs.map(getPublicContentGroupKey)).size);
});

test('Faith legacy language inference stays aligned with the public serializer before pagination', async context => {
  const gu = '\u0a95'.repeat(12);
  const hi = '\u0915'.repeat(12);
  const cases = [
    { originalLang: null, lang: 'en', content: `<p>${gu}</p>`, expected: 'gu' },
    { originalLang: null, lang: 'en', content: `<p>${hi}</p>`, expected: 'hi' },
    { originalLang: 'en', lang: 'en', content: gu, expected: 'en' },
    { originalLang: null, lang: 'en', content: `<p title="${gu}">English</p>`, expected: 'en' },
    { originalLang: null, lang: null, language: null, content: `<p title="${gu}">English</p>`, expected: 'gu' },
    { originalLang: null, lang: 'en', content: `<broken ${gu}`, expected: 'gu' },
    { originalLang: null, lang: 'en', content: gu + hi, expected: 'en' },
    { originalLang: null, lang: '', language: 'HI', expected: 'hi' },
    { originalLang: 'Gujarati', expected: 'gu' },
    { originalLang: 'HI-in', expected: 'hi' },
    { originalLang: 'E.n.g.l.i.s.h', expected: 'en' },
  ];
  const state = setup(context);
  for (const fixture of cases) {
    const { expected, ...overrides } = fixture;
    state.docs = [story(1, 'en', overrides)];
    for (const lang of languages) {
      const result = success(await state.get({ lang }));
      assert.equal(result.total, lang === expected ? 1 : 0, JSON.stringify({ fixture, lang }));
      assert.ok(result.items.every(item => item.resolvedLanguage === lang));
    }
  }
});

for (const total of [0, 10, 30, 31, 45, 100, 1000]) {
  test(`Faith metadata and query bounds for ${total} eligible logical stories`, async context => {
    const state = setup(context, Array.from({ length: total }, (_, i) => story(i + 1)));
    const totalPages = Math.max(1, Math.ceil(total / 30));
    for (const page of new Set([1, 2, 3, 100, totalPages, totalPages + 1])) {
      const result = success(await state.get({ page: String(page) }));
      assert.equal(result.total, total); assert.equal(result.totalPages, totalPages);
      assert.equal(result.page, page); assert.equal(result.limit, 30);
      assert.equal(result.hasMore, page < totalPages);
      assert.equal(result.items.length, Math.max(0, Math.min(30, total - (page - 1) * 30)));
      assert.deepEqual(state.aggregates.at(-1).at(-1).$facet.items, [{ $skip: (page - 1) * 30 }, { $limit: 30 }]);
    }
    for (const query of state.finds) {
      assert.ok(query.filter.$and[1]._id.$in.length <= 30);
      assert.equal(query.limit, 30);
    }
  });
}

test('Faith 100000-story virtual totals hydrate only 30 IDs on page 1 and page 100', async context => {
  const state = setup(context);
  let currentPage = 1;
  context.mock.method(News, 'aggregate', pipeline => {
    assert.deepEqual(pipeline.at(-1).$facet.items, [{ $skip: (currentPage - 1) * 30 }, { $limit: 30 }]);
    const projection = pipeline.find(stage => stage.$project).$project;
    assert.deepEqual(Object.keys(projection).sort(), ['_id', 'native', 'nativeComplete', 'publication', 'ready', 'storyKey'].sort());
    assert.ok(pipeline.findIndex(stage => stage.$match?.$expr) < pipeline.findIndex(stage => stage.$group));
    assert.ok(pipeline.findIndex(stage => stage.$group) < pipeline.findIndex(stage => stage.$facet));
    return { option() { return this; }, exec: async () => [{
      metadata: [{ total: 100000 }],
      items: state.docs.map(doc => ({ _id: getPublicContentGroupKey(doc), articleId: doc._id, publication: doc.publishedAt })),
    }] };
  });
  for (const page of [1, 100]) {
    currentPage = page;
    state.docs = Array.from({ length: 30 }, (_, i) => story((page - 1) * 30 + i + 1));
    const result = success(await state.get({ page: String(page) }));
    assert.equal(result.total, 100000); assert.equal(result.totalPages, 3334);
    assert.equal(result.items.length, 30); assert.equal(result.hasMore, true);
    const hydration = state.finds.at(-1);
    assert.equal(hydration.filter.$and[1]._id.$in.length, 30);
    assert.equal(hydration.limit, 30);
    assert.deepEqual(result.items.map(item => item._id), state.docs.map(doc => String(doc._id)));
  }
  assert.equal(state.finds.length, 2);
});

test('Faith rejects malformed/nonpositive/unsafe pagination and caps valid large limits', async context => {
  const state = setup(context, Array.from({ length: 110 }, (_, i) => story(i + 1)));
  for (const field of ['page', 'limit']) {
    for (const value of ['abc', '0', '-1', '1.5', '1e2', 'Infinity', 'NaN', '', '9007199254740992', ['1', '2'], { bad: '1' }]) {
      const response = await state.get({ [field]: value });
      assert.equal(response.status, 400, JSON.stringify({ field, value, body: response.body }));
      assert.deepEqual(response.body, { message: `Invalid ${field}` });
    }
  }
  assert.equal((await state.get({ page: '9007199254740991', limit: '30' })).status, 400);
  assert.equal(state.aggregates.length, 0); assert.equal(state.finds.length, 0);
  for (const [input, expected] of [['1', 1], ['30', 30], ['100', 100], ['101', 100]]) {
    const result = success(await state.get({ limit: input }));
    assert.equal(result.limit, expected); assert.equal(result.items.length, expected);
  }
});

test('Faith defaults and header language negotiation remain compatible', async context => {
  const state = setup(context, languages.map((lang, i) => story(i + 1, lang)));
  const gu = success(await state.get({ lang: undefined, page: undefined, limit: undefined }));
  assert.equal(gu.page, 1); assert.equal(gu.limit, 30); assert.equal(gu.items[0].resolvedLanguage, 'gu');
  assert.equal(success(await state.get({ lang: undefined, language: 'HI' })).items[0].resolvedLanguage, 'hi');
  assert.equal(success(await state.get({ lang: undefined }).set('x-lang', 'en')).items[0].resolvedLanguage, 'en');
});

test('Faith unavailable, timed-out, inconsistent and concurrently changed pages fail safely', async context => {
  const state = setup(context, [story(1)]);
  const logged = context.mock.method(console, 'error', () => {});
  mongoose.connection.readyState = 0;
  const disconnected = await state.get();
  assert.equal(disconnected.status, 503);
  assert.deepEqual(Object.keys(disconnected.body), ['message']);
  assert.equal(state.aggregates.length, 0);
  mongoose.connection.readyState = 1;
  state.beforeHydrate = () => { state.docs = []; };
  assert.equal((await state.get()).status, 503);
  state.docs = [story(1)]; state.beforeHydrate = () => { state.docs[0].translationKey = 'changed'; };
  assert.equal((await state.get()).status, 503);
  state.docs = [story(1)]; state.beforeHydrate = () => { state.docs[0].publishedAt = new Date('2021-01-01'); };
  assert.equal((await state.get()).status, 503);
  state.docs = [story(1, 'gu', { translations: { hi: bucket('hi') }, translationStatus: { hi: 'ready' } })];
  state.beforeHydrate = () => { state.docs[0].translationStatus.hi = 'pending'; };
  assert.equal((await state.get({ lang: 'hi' })).status, 503);
  context.mock.method(News, 'aggregate', () => ({ option() { return this; }, exec: async () => [] }));
  assert.equal((await state.get()).status, 503);
  context.mock.method(News, 'aggregate', () => { throw new Error('fixture-private-database-detail'); });
  const failed = await state.get();
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, disconnected.body);
  assert.ok(!JSON.stringify(failed.body).includes('fixture-private-database-detail'));
  context.mock.method(News, 'aggregate', () => { throw Object.assign(new Error('fixture-private-database-detail'), { statusCode: 400 }); });
  const internalBadRequest = await state.get();
  assert.equal(internalBadRequest.status, 503);
  assert.deepEqual(internalBadRequest.body, disconnected.body);
  assert.ok(logged.mock.callCount() >= 6);
});

for (const category of ordinaryCategories) {
  test(`Faith scope leaves ${category} grouping, fallback and response shape unchanged`, async context => {
    const state = setup(context, [story(1, 'en', { category })], { legacy: true });
    const result = success(await state.get({ category, lang: 'hi', strictLocale: 'true' }));
    assert.equal(result.total, 1);
    assert.equal(result.items[0].resolvedLanguage, 'en');
    assert.equal(result.items[0].isFallback, true);
    assert.deepEqual(Object.keys(result).sort(), ['items', 'page', 'limit', 'total', 'totalPages'].sort());
    assert.equal(state.aggregates.length, 0);
    assert.ok(state.finds.every(query => JSON.stringify(query.sort) === JSON.stringify({ publishedAt: -1, createdAt: -1 })));
    assert.ok(Number.isNaN(controller.resolvePublicNewsListRequest({ query: { category, page: 'abc' }, headers: {} }).page));
    mongoose.connection.readyState = 0;
    assert.deepEqual(success(await state.get({ category })), { items: [], page: 1, limit: 30, total: 0, totalPages: 1 });
  });
}

test('Faith cache is versioned and page/limit/language-specific without changing ordinary category keys', context => {
  setup(context);
  const file = path.resolve(__dirname, '..', 'routes', 'publicNews.routes.js');
  const realRequire = createRequire(file);
  let options;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, require(name) {
      if (name !== '../lib/cache') return realRequire(name);
      return { ...realRequire(name), createJsonCacheMiddleware(value) {
        options = value;
        const middleware = (_req, _res, next) => next();
        middleware.refresh = () => {};
        return middleware;
      } };
    },
  }, { filename: file });
  const req = query => ({ query: { category: 'faith-culture', lang: 'en', page: '1', limit: '30', ...query }, headers: {} });
  const keys = languages.flatMap(lang => [1, 2, 3].map(page => options.buildKey(req({ lang, page: String(page) }))));
  assert.equal(new Set(keys).size, 9);
  assert.ok(keys.every(key => key.includes(':faith-v1:')));
  assert.notEqual(keys[0], options.buildKey(req({ limit: '31' })));
  assert.equal(keys[0], options.buildKey(req({ strictLocale: 'false', fallback: 'true' })));
  for (const category of ordinaryCategories) assert.ok(options.buildKey(req({ category })).includes(':v2:'));
  assert.throws(() => options.buildKey(req({ page: 'abc' })), /Invalid page/);
  let body;
  const res = { status(code) { assert.equal(code, 503); return this; }, json(value) { body = value; } };
  options.onRebuildUnavailable(req({}), res);
  assert.deepEqual(Object.keys(body), ['message']);
  options.onRebuildUnavailable(req({ category: 'national' }), res);
  assert.equal(body.total, 0); assert.equal(body.page, 1); assert.equal(body.limit, 30);
});
