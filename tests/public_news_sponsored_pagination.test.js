require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const News = require('../models/News');
const SponsoredFeature = require('../models/SponsoredFeature');
const { langMiddleware } = require('../middleware/lang');
const publicNewsRouter = require('../routes/publicNews.routes');
const { getPublicContentGroupKey } = require('../services/publicCategoryListing.service');
const { matches, runPipeline } = require('./helpers/pulseDialogueAggregate');

const languages = ['gu', 'hi', 'en'];
const objectId = number => new mongoose.Types.ObjectId(number.toString(16).padStart(24, '0'));
const bucket = lang => ({ title: `${lang} translated title`, summary: `${lang} translated summary`, content: `${lang} translated body` });
const publicFields = [
  '_id', 'id', 'articleId', 'slug', 'canonicalSlug', 'localizedSlug', 'canonicalDetailUrl', 'detailApiUrl',
  'language', 'lang', 'requestedLanguage', 'resolvedLanguage', 'isFallback', 'isTranslated',
  'title', 'summary', 'imageUrl', 'coverImageUrl', 'coverImage', 'category', 'publishedAt',
  'isSponsored', 'isSponsoredArticle', 'sponsorName', 'sponsorLabel', 'sponsorDisclosure', 'sponsorCtaText', 'sponsorCtaUrl',
].sort();

function story(number, lang = 'en', overrides = {}) {
  const publishedAt = new Date(Date.UTC(2020, 0, 1) - number * 1000);
  return {
    _id: objectId(number), translationKey: `group-${number}`, slug: `persisted-story-${number}`,
    category: 'national', status: 'published', lang, language: lang, originalLang: lang,
    title: `${lang} title ${number}`, description: `${lang} summary ${number}`, content: `<p>${lang} body ${number}</p>`,
    publishedAt, createdAt: publishedAt, updatedAt: publishedAt,
    isSponsored: false, isSponsoredArticle: true,
    sponsorName: 'Fixture sponsor', sponsorDisclosure: 'Paid partnership disclosure',
    coverImage: { url: 'https://example.invalid/public-cover.jpg', alt: 'Public cover', publicId: 'storage-only' },
    ...overrides,
  };
}

function setup(context, initial = [], { ordinary = false, router = publicNewsRouter } = {}) {
  const state = { docs: initial, aggregates: [], finds: [], counts: [], beforeHydrate: null };
  const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, writable: true, value: 1 });
  context.after(() => {
    if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
    else delete mongoose.connection.readyState;
  });
  context.mock.method(News, 'aggregate', pipeline => {
    state.aggregates.push(pipeline);
    return {
      option(options) {
        assert.deepEqual(options, { maxTimeMS: 2500, allowDiskUse: true, collation: { locale: 'simple' } });
        return this;
      },
      exec: async () => runPipeline(state.docs, pipeline),
    };
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
  context.mock.method(News, 'countDocuments', async filter => {
    assert.equal(ordinary, true, 'sponsored pagination must count eligible logical groups, not raw documents');
    state.counts.push(filter);
    return state.docs.filter(doc => matches(doc, filter)).length;
  });
  for (const method of ['create', 'updateOne', 'updateMany', 'deleteMany']) {
    context.mock.method(News, method, () => assert.fail('a public listing must never write News'));
  }
  for (const method of ['find', 'findOne', 'findById', 'create', 'updateOne', 'updateMany', 'deleteMany']) {
    context.mock.method(SponsoredFeature, method, () => assert.fail('article membership must not query or mutate campaigns'));
  }
  const app = express();
  app.use(langMiddleware);
  for (const base of ['/api/public/news', '/admin-api/public/news', '/admin-api/api/public/news']) app.use(base, router);
  state.get = (params = {}, endpoint = '/api/public/news') => request(app).get(endpoint).query({
    sponsoredOnly: 'true', lang: 'en', page: '1', limit: '12', ...params,
  });
  return state;
}

function success(response) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.body).sort(), ['items', 'page', 'limit', 'total', 'totalPages'].sort());
  return response.body;
}

test('sponsored membership uses either persistent flag across original categories, never text or campaign metadata', async context => {
  const categories = ['national', 'regional', 'business', 'sports', 'tech', 'faith-culture', 'pulse-dialogue'];
  const paid = categories.map((category, index) => story(index + 1, 'en', {
    category, isSponsored: index % 2 === 0, isSponsoredArticle: index % 2 !== 0,
  }));
  const ordinary = [
    story(100, 'en', { isSponsoredArticle: false, title: 'Sponsored paid partnership report', tags: ['sponsored'] }),
    story(101, 'en', { isSponsoredArticle: false, category: 'sponsored', sponsorLabel: 'Sponsored' }),
    story(102, 'en', { isSponsoredArticle: false, sponsorFeatureEligible: true, sponsorFeatureLinkedId: objectId(900) }),
    story(103, 'en', { isSponsoredArticle: false, isSponsored: 'true' }),
  ];
  const state = setup(context, [...ordinary, ...paid]);
  const result = success(await state.get());
  assert.equal(result.total, paid.length);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.items.map(item => item.id), paid.map(doc => String(doc._id)));
  assert.deepEqual(result.items.map(item => item.category), categories);
  assert.ok(result.items.every(item => item.isSponsored === true && item.isSponsoredArticle === true));
  assert.deepEqual(state.aggregates[0][0].$match.$and.find(clause => clause.$or?.[0]?.isSponsoredArticle), {
    $or: [{ isSponsoredArticle: true }, { isSponsored: true }],
  });
});

test('campaign pause, expiry, missing links and unlinking do not change sponsored article membership', async context => {
  const campaigns = [
    { _id: objectId(900), isActive: false, endAt: new Date('2099-01-01') },
    { _id: objectId(901), isActive: true, endAt: new Date('2001-01-01') },
  ];
  const state = setup(context, [
    ...campaigns.map((campaign, index) => story(index + 1, 'en', { sponsorFeatureLinkedId: campaign._id })),
    story(3, 'en', { sponsorFeatureLinkedId: objectId(902) }),
    story(4, 'en', { sponsorFeatureLinkedId: null, sponsorFeatureEligible: false }),
  ]);
  assert.equal(success(await state.get()).total, 4);
  state.docs.forEach(doc => { doc.sponsorFeatureLinkedId = null; });
  assert.equal(success(await state.get()).total, 4);
});

test('visibility excludes every non-public lifecycle state and permits only eligible restored states', async context => {
  const future = new Date('2999-01-01');
  const exclusions = [
    ...['draft', 'scheduled', 'archived', 'deleted', 'withdrawn', 'retracted', 'rejected'].map(status => ({ status })),
    { deletedAt: new Date() }, { locked: true }, { visibility: 'private' }, { visibility: 'PRIVATE' }, { isPrivate: true },
    { embargoUntil: future }, { publishedAt: future }, { publishAt: future }, { scheduledAt: future },
    { workflow: { locked: true } }, { workflow: { embargoUntil: future } },
    { status: 'scheduled', scheduledAt: new Date('2000-01-01') },
  ];
  const state = setup(context, [
    story(1), story(2, 'en', { status: 'published', deletedAt: null, deletedFromStatus: null }),
    ...exclusions.map((patch, index) => story(100 + index, 'en', patch)),
    story(200, 'en', { status: 'draft', deletedAt: null, deletedFromStatus: null }),
  ]);
  assert.deepEqual(success(await state.get()).items.map(item => item.id), [1, 2].map(number => String(objectId(number))));
  state.docs = state.docs.filter(doc => String(doc._id) !== String(objectId(1)));
  const removed = success(await state.get());
  assert.equal(removed.total, 1);
  assert.deepEqual(removed.items.map(item => item.id), [String(objectId(2))]);
});

for (const lang of languages) {
  test(`sponsored ${lang}: filtered totals paginate 12/12/7 with no ordinary records or overlap`, async context => {
    const paid = Array.from({ length: 31 }, (_, index) => story(index + 1, lang, { category: index % 2 ? 'business' : 'sports' }));
    const state = setup(context, [
      ...Array.from({ length: 50 }, (_, index) => story(index + 100, lang, { isSponsoredArticle: false })),
      ...paid,
    ]);
    const ids = [];
    for (const page of [1, 2, 3, 4]) {
      const result = success(await state.get({ lang, page: String(page) }));
      assert.equal(result.page, page); assert.equal(result.limit, 12);
      assert.equal(result.total, 31); assert.equal(result.totalPages, 3);
      assert.equal(result.items.length, Math.max(0, Math.min(12, 31 - (page - 1) * 12)));
      assert.ok(result.items.every(item => item.language === lang && item.requestedLanguage === lang && item.resolvedLanguage === lang && !item.isFallback));
      ids.push(...result.items.map(item => item.id));
    }
    assert.deepEqual(ids, paid.map(doc => String(doc._id)));
    assert.equal(new Set(ids).size, 31);
    assert.equal(state.counts.length, 0);
  });

  test(`sponsored ${lang}: strict native/ready eligibility precedes deduplication and ignores fallback flags`, async context => {
    const source = lang === 'gu' ? 'en' : 'gu';
    const docs = [story(1, lang, { translationStatus: { [lang]: 'pending' } })];
    const allowed = [String(objectId(1))];
    let number = 2;
    for (const status of ['ready', 'READY', ' ready ', 'pending', 'failed', 'approved', 'rejected', null, undefined]) {
      const doc = story(number++, source, { translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: status } });
      docs.push(doc);
      if (String(status).trim().toLowerCase() === 'ready') allowed.push(String(doc._id));
    }
    for (const field of ['title', 'summary', 'content']) {
      for (const missing of [undefined, null, '', ' \n\t ', 42, ['not', 'text']]) {
        docs.push(story(number++, source, {
          translations: { [lang]: { ...bucket(lang), [field]: missing } }, translationStatus: { [lang]: 'ready' },
        }));
      }
    }
    for (const field of ['title', 'description', 'content']) docs.push(story(number++, lang, { [field]: '' }));
    docs.push(story(number++, source));
    const state = setup(context, docs);
    for (const flags of [{}, { strictLocale: 'false', fallback: 'true', fallbackToBase: 'true', allowFallback: 'true' }]) {
      const result = success(await state.get({ lang, limit: '100', ...flags }));
      assert.equal(result.total, allowed.length);
      assert.deepEqual(result.items.map(item => item.id), allowed);
      assert.ok(result.items.every(item => item.resolvedLanguage === lang && !item.isFallback && !item.detailApiUrl.includes('fallback=')));
    }
    state.docs = [story(900, source)];
    assert.deepEqual(success(await state.get({ lang, fallback: 'true' })), { items: [], page: 1, limit: 12, total: 0, totalPages: 1 });
  });

  test(`sponsored ${lang}: tied publication timestamps use descending persisted IDs on every page`, async context => {
    const docs = Array.from({ length: 31 }, (_, index) => story(index + 1, lang, {
      publishedAt: new Date('2020-01-01'), createdAt: new Date('2020-01-01'),
    }));
    docs[0].updatedAt = new Date('2999-01-01');
    const state = setup(context, docs);
    const ids = [];
    for (const page of [1, 2, 3]) {
      state.docs = page % 2 ? [...docs.slice(7), ...docs.slice(0, 7)] : docs.slice().reverse();
      ids.push(...success(await state.get({ lang, page: String(page) })).items.map(item => item.id));
    }
    assert.deepEqual(ids, Array.from({ length: 31 }, (_, index) => String(objectId(31 - index))));
    assert.equal(new Set(ids).size, 31);
  });
}

test('sponsored group selection prefers an eligible native edition without admitting an ordinary or hidden sibling', async context => {
  const state = setup(context, [
    story(1, 'gu', { translationKey: 'shared' }),
    story(2, 'gu', { translationKey: 'shared', translations: { en: bucket('en') }, translationStatus: { en: 'ready' } }),
    story(3, 'en', { translationKey: 'shared' }),
    story(4, 'en', { translationKey: 'shared', status: 'draft' }),
    story(5, 'en', { translationKey: 'shared', isSponsoredArticle: false }),
    story(6),
  ]);
  const first = success(await state.get({ limit: '1' }));
  const second = success(await state.get({ limit: '1', page: '2' }));
  assert.equal(first.total, 2); assert.equal(first.totalPages, 2);
  assert.equal(first.items[0].id, String(objectId(3)));
  assert.equal(first.items[0].isTranslated, false);
  assert.equal(second.items[0].id, String(objectId(6)));
});

test('sponsored logical identity reuses translation keys/groups and persisted canonical slugs', async context => {
  const docs = [
    story(1, 'en', { translationKey: 'same' }),
    story(2, 'en', { translationKey: null, translationGroupId: 'same' }),
    story(3, 'en', { translationKey: 'Case' }),
    story(4, 'en', { translationKey: 'case' }),
    story(5, 'en', { translationKey: '', slugs: { en: 'canonical' } }),
    story(6, 'en', { translationKey: null, slug: 'canonical' }),
  ];
  const result = success(await setup(context, docs).get({ limit: '2' }));
  assert.equal(result.total, new Set(docs.map(getPublicContentGroupKey)).size);
  assert.equal(result.total, 4); assert.equal(result.totalPages, 2);
});

test('sponsored DTO keeps persisted slug/ID and language-compatible canonical URLs without title slugification', async context => {
  const slug = '\u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0';
  const doc = story(1, 'gu', {
    slug: 'stable-original-slug', title: 'A newly edited headline',
    slugs: { gu: slug, hi: 'persisted-hindi-slug', en: 'persisted-english-slug' },
    translations: { hi: bucket('hi'), en: bucket('en') }, translationStatus: { hi: 'ready', en: 'ready' },
  });
  const state = setup(context, [doc]);
  for (const lang of languages) {
    const item = success(await state.get({ lang })).items[0];
    assert.equal(item.id, String(doc._id)); assert.equal(item._id, item.id); assert.equal(item.articleId, item.id);
    assert.equal(item.slug, doc.slug);
    assert.equal(item.canonicalSlug, doc.slugs[lang]); assert.equal(item.localizedSlug, doc.slugs[lang]);
    assert.equal(item.canonicalDetailUrl, `${lang === 'en' ? '' : `/${lang}`}/news/${encodeURIComponent(doc.slugs[lang])}`);
    assert.equal(item.detailApiUrl, `/api/public/news/${encodeURIComponent(doc.slugs[lang])}?lang=${lang}`);
  }
  state.docs = [story(2, 'en', { slug: null, slugs: { en: 'persisted-legacy-slug' } })];
  assert.equal(success(await state.get()).items[0].slug, 'persisted-legacy-slug');
  state.docs = [story(3, 'en', { slug: null }), story(4, 'en', { slug: '   ' })];
  assert.equal(success(await state.get()).total, 0, 'missing stored URLs are excluded before counting, not invented from titles');
});

test('sponsored DTO is an exact public allowlist, including a public-only image object', async context => {
  const doc = story(1, 'en', {
    category: 'business', sponsorCtaText: 'Learn more', sponsorCtaUrl: 'https://example.invalid/sponsor',
    advertiserEmail: 'private-fixture@example.invalid', advertiserPhone: 'private-fixture-phone',
    paymentDetails: { fixture: true }, revenue: 99, account: { fixture: true },
    internalTitle: 'Private fixture title', internalComments: ['Private fixture note'],
    sponsorFeatureEligible: true, sponsorFeatureLinkedId: objectId(900),
    spotlightEnabled: true, spotlightPinned: true, spotlightPriority: 'high', spotlightExpiresAt: new Date('2099-01-01'),
    pulseDialogue: { contributorId: objectId(901), privateContact: 'private-fixture-contact' },
    coverImage: { url: 'https://example.invalid/public-cover.jpg', alt: 'Public cover', publicId: 'private-storage-id', internal: 'private-fixture-image-note' },
  });
  const item = success(await setup(context, [doc]).get()).items[0];
  assert.deepEqual(Object.keys(item).sort(), publicFields);
  assert.deepEqual(item.coverImage, { url: doc.coverImage.url, alt: doc.coverImage.alt });
  assert.equal(item.title, doc.title); assert.equal(item.summary, doc.description);
  assert.equal(item.category, doc.category); assert.equal(item.publishedAt, doc.publishedAt.toISOString());
  assert.equal(item.sponsorName, doc.sponsorName); assert.equal(item.sponsorDisclosure, doc.sponsorDisclosure);
  assert.equal(item.sponsorLabel, 'Sponsored'); assert.equal(item.sponsorCtaUrl, doc.sponsorCtaUrl);
  assert.doesNotMatch(JSON.stringify(item), /private-fixture|private-storage|storage-only/);
});

test('sponsored publication ordering uses stored publication fallbacks, never updatedAt', async context => {
  const state = setup(context, [
    story(1, 'en', { publishedAt: new Date('2020-05-01') }),
    story(2, 'en', { publishedAt: null, publishAt: new Date('2020-04-01'), createdAt: new Date('2020-06-01') }),
    story(3, 'en', { publishedAt: null, createdAt: new Date('2020-03-01') }),
    story(4, 'en', { publishedAt: new Date('2020-02-01'), updatedAt: new Date('2999-01-01') }),
  ]);
  const result = success(await state.get());
  assert.deepEqual(result.items.map(item => item.id), [1, 2, 3, 4].map(number => String(objectId(number))));
  assert.deepEqual(result.items.map(item => item.publishedAt), ['2020-05-01', '2020-04-01', '2020-03-01', '2020-02-01'].map(date => new Date(date).toISOString()));
});

test('sponsored pagination and flag validation fail with 400 before database work', async context => {
  const state = setup(context);
  for (const field of ['page', 'limit']) {
    for (const value of ['abc', '0', '-1', '1.5', '1e2', 'Infinity', '', '9007199254740992', ['1', '2'], { invalid: '1' }]) {
      const res = await state.get({ [field]: value });
      assert.equal(res.status, 400, JSON.stringify({ field, value, body: res.body }));
      assert.deepEqual(res.body, { message: `Invalid ${field}` });
    }
  }
  for (const value of ['', '1', 'yes', 'TRUE', 'invalid', ['true', 'false'], { invalid: 'true' }]) {
    const res = await state.get({ sponsoredOnly: value });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: 'Invalid sponsoredOnly' });
  }
  for (const value of ['fr', '', ['en', 'gu'], { invalid: 'en' }]) {
    const res = await state.get({ lang: value });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { message: 'Invalid lang' });
  }
  assert.equal((await state.get({ page: '9007199254740991', limit: '30' })).status, 400);
  assert.equal(state.aggregates.length, 0); assert.equal(state.finds.length, 0);
});

test('sponsored defaults, language aliases, limit cap and existing API aliases are supported', async context => {
  const state = setup(context, languages.map((lang, index) => story(index + 1, lang)));
  const defaults = success(await state.get({ page: undefined, limit: undefined, lang: undefined }));
  assert.equal(defaults.page, 1); assert.equal(defaults.limit, 30);
  assert.equal(defaults.items[0].language, 'gu');
  assert.equal(success(await state.get({ lang: undefined, language: 'Hindi' })).items[0].language, 'hi');
  assert.equal(success(await state.get({ lang: undefined }).set('x-lang', 'EN')).items[0].language, 'en');
  assert.equal(success(await state.get({ limit: '101' })).limit, 100);
  for (const endpoint of ['/admin-api/public/news', '/admin-api/api/public/news']) {
    assert.equal(success(await state.get({}, endpoint)).items[0].language, 'en');
  }
});

test('explicit sponsored category/topic filters precede counting without changing original category values', async context => {
  const state = setup(context, [
    story(1, 'en', { category: 'Business', topic: 'finance' }),
    story(2, 'en', { category: 'business', topic: 'other' }),
    story(3, 'en', { category: 'sports', topic: 'finance' }),
    story(4, 'en', { category: 'Business', topic: 'finance', isSponsoredArticle: false }),
  ]);
  const result = success(await state.get({ category: 'business', topic: 'FINANCE' }));
  assert.equal(result.total, 1); assert.equal(result.items[0].category, 'Business');
});

test('empty sponsored pages are successful; unavailable, timed-out and failed reads are explicit errors', async context => {
  const state = setup(context);
  const logged = context.mock.method(console, 'error', () => {});
  assert.deepEqual(success(await state.get()), { items: [], page: 1, limit: 12, total: 0, totalPages: 1 });
  mongoose.connection.readyState = 0;
  const disconnected = await state.get();
  assert.equal(disconnected.status, 503); assert.equal(disconnected.body.code, 'NEWS_UNAVAILABLE');
  mongoose.connection.readyState = 1;
  for (const error of [
    Object.assign(new Error('private-fixture-timeout'), { code: 50 }),
    Object.assign(new Error('private-fixture-network'), { name: 'MongoNetworkError' }),
    Object.assign(new Error('private-fixture-query'), { statusCode: 400 }),
  ]) {
    context.mock.method(News, 'aggregate', () => ({ option() { return this; }, exec: async () => { throw error; } }));
    const res = await state.get();
    assert.equal(res.status, error.statusCode === 400 ? 500 : 503);
    assert.equal(res.body.code, res.status === 500 ? 'NEWS_QUERY_FAILED' : 'NEWS_UNAVAILABLE');
    assert.equal(Object.hasOwn(res.body, 'items'), false);
    assert.equal(Object.hasOwn(res.body, 'total'), false);
    assert.doesNotMatch(JSON.stringify(res.body), /private-fixture/);
  }
  assert.ok(logged.mock.callCount() >= 3);
});

test('sponsored pages fail instead of silently dropping records changed during hydration', async context => {
  const state = setup(context);
  const logged = context.mock.method(console, 'error', () => {});
  const mutations = [
    () => { state.docs = []; },
    () => { state.docs[0].status = 'archived'; },
    () => { state.docs[0].isSponsoredArticle = false; },
    () => { state.docs[0].visibility = 'private'; },
    () => { state.docs[0].translationKey = 'changed'; },
    () => { state.docs[0].publishedAt = new Date('2021-01-01'); },
    () => { state.docs[0].translationStatus.hi = 'pending'; },
    () => { state.docs[0].translations.hi.summary = ''; },
    () => { state.docs[0].slug = null; },
  ];
  for (const mutate of mutations) {
    state.docs = [story(1, 'gu', { translations: { hi: bucket('hi') }, translationStatus: { hi: 'ready' } })];
    state.beforeHydrate = mutate;
    const res = await state.get({ lang: 'hi' });
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.code, 'NEWS_QUERY_FAILED');
    assert.equal(Object.hasOwn(res.body, 'items'), false);
  }
  state.beforeHydrate = null;
  for (const invalid of [[], [{}], [{ items: [], metadata: [{ total: 1 }] }], [{ items: [], metadata: [{ total: -1 }] }]]) {
    context.mock.method(News, 'aggregate', () => ({ option() { return this; }, exec: async () => invalid }));
    assert.equal((await state.get()).status, 500);
  }
  assert.ok(logged.mock.callCount() >= mutations.length);
});

test('sponsored large totals hydrate only page IDs with bounded queries and no full-record collection load', async context => {
  const state = setup(context);
  let currentPage = 1;
  context.mock.method(News, 'aggregate', pipeline => {
    assert.equal(pipeline[0].$match.$and.some(clause => clause.$or?.some(item => item.isSponsored === true)), true);
    assert.ok(pipeline.findIndex(stage => stage.$match?.$expr) < pipeline.findIndex(stage => stage.$group));
    assert.ok(pipeline.findIndex(stage => stage.$group) < pipeline.findIndex(stage => stage.$facet));
    assert.deepEqual(Object.keys(pipeline.find(stage => stage.$project).$project).sort(), ['_id', 'native', 'nativeComplete', 'publication', 'ready', 'storyKey'].sort());
    assert.deepEqual(pipeline.at(-1).$facet.items, [{ $skip: (currentPage - 1) * 30 }, { $limit: 30 }]);
    return {
      option(options) { assert.equal(options.maxTimeMS, 2500); assert.equal(options.allowDiskUse, true); return this; },
      exec: async () => [{
        metadata: [{ total: 100000 }],
        items: state.docs.map(doc => ({ _id: getPublicContentGroupKey(doc), articleId: doc._id, publication: doc.publishedAt })),
      }],
    };
  });
  for (const page of [1, 100]) {
    currentPage = page;
    state.docs = Array.from({ length: 30 }, (_, index) => story((page - 1) * 30 + index + 1));
    const result = success(await state.get({ page: String(page), limit: '30' }));
    assert.equal(result.total, 100000); assert.equal(result.totalPages, 3334); assert.equal(result.items.length, 30);
    const query = state.finds.at(-1);
    assert.equal(query.filter.$and[1]._id.$in.length, 30);
    assert.equal(query.limit, 30);
    assert.deepEqual(result.items.map(item => item.id), state.docs.map(doc => String(doc._id)));
  }
  assert.equal(state.finds.length, 2); assert.equal(state.counts.length, 0);
});

test('absent/false sponsoredOnly keeps ordinary News grouping, fallback and mixed totals unchanged', async context => {
  const state = setup(context, [story(1), story(2, 'en', { isSponsoredArticle: false })], { ordinary: true });
  const baseline = success(await state.get({ sponsoredOnly: undefined }));
  const explicitFalse = success(await state.get({ sponsoredOnly: 'false' }));
  assert.deepEqual(explicitFalse, baseline);
  assert.equal(baseline.total, 2); assert.equal(state.aggregates.length, 0);
  assert.ok(baseline.items.some(item => item.isSponsoredArticle === false));
  const fallback = success(await state.get({ sponsoredOnly: undefined, category: 'national', lang: 'hi' }));
  assert.equal(fallback.total, 2);
  assert.ok(fallback.items.every(item => item.resolvedLanguage === 'en' && item.isFallback));
  const paid = success(await state.get());
  assert.equal(paid.total, 1);
  assert.equal(state.aggregates.length, 1);
});

test('ordinary Faith response, strict policy and hasMore remain unchanged alongside opt-in sponsored mode', async context => {
  const state = setup(context, [story(1, 'en', { category: 'faith-culture' }), story(2, 'en', { category: 'faith-culture', isSponsoredArticle: false })]);
  const ordinary = await state.get({ sponsoredOnly: undefined, category: 'faith-culture', limit: '1' });
  assert.equal(ordinary.status, 200); assert.equal(ordinary.body.total, 2); assert.equal(ordinary.body.hasMore, true);
  assert.deepEqual((await state.get({ sponsoredOnly: 'false', category: 'faith-culture', limit: '1' })).body, ordinary.body);
  const paid = success(await state.get({ category: 'faith-culture', limit: '1' }));
  assert.equal(paid.total, 1); assert.equal(paid.totalPages, 1);
  const noFallback = await state.get({ sponsoredOnly: undefined, category: 'faith-culture', lang: 'hi', fallback: 'true' });
  assert.equal(noFallback.status, 200); assert.equal(noFallback.body.total, 0); assert.equal(noFallback.body.hasMore, false);
});

test('breaking endpoint ignores sponsoredOnly and retains its existing mixed listing', async context => {
  const state = setup(context, [story(1, 'en', { category: 'breaking' }), story(2, 'en', { category: 'breaking', isSponsoredArticle: false })]);
  const result = success(await state.get({}, '/api/public/news/breaking'));
  assert.equal(result.total, 2); assert.equal(state.aggregates.length, 0);
});

function routerWithFixtureCache() {
  const reads = [];
  const cachedBody = { items: [{ id: 'ordinary-cached-fixture', isSponsored: false }], page: 1, limit: 40, total: 999, totalPages: 25 };
  const cacheFile = require.resolve('../lib/cache');
  const cacheRequire = createRequire(cacheFile);
  const cacheModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(cacheFile, 'utf8'), {
    module: cacheModule, exports: cacheModule.exports, console, process, setTimeout, clearTimeout, AbortController,
    require(name) {
      if (name === './redis') return {
        isRedisReady: () => true,
        getRedisClient: () => ({ get: async key => { reads.push(key); return JSON.stringify({ status: 200, body: cachedBody }); } }),
      };
      return cacheRequire(name);
    },
  }, { filename: cacheFile });
  const routeFile = require.resolve('../routes/publicNews.routes');
  const routeRequire = createRequire(routeFile);
  const routeModule = { exports: {} };
  let options;
  vm.runInNewContext(fs.readFileSync(routeFile, 'utf8'), {
    module: routeModule, exports: routeModule.exports,
    require(name) {
      if (name !== '../lib/cache') return routeRequire(name);
      return { ...cacheModule.exports, createJsonCacheMiddleware(value) {
        options = value;
        return cacheModule.exports.createJsonCacheMiddleware(value);
      } };
    },
  }, { filename: routeFile });
  return { router: routeModule.exports, options, reads, cachedBody };
}

test('sponsored requests bypass real cache middleware, including ordinary and last-known-good keys', async context => {
  const cache = routerWithFixtureCache();
  const state = setup(context, [story(1), story(2, 'en', { isSponsoredArticle: false })], { router: cache.router });
  const req = query => ({ query: { lang: 'en', page: '1', limit: '40', ...query }, headers: {} });
  const ordinaryKey = cache.options.buildKey(req({}));
  assert.ok(ordinaryKey.startsWith('np:v1:latest:en:v2:'));
  assert.equal(cache.options.buildKey(req({ sponsoredOnly: 'false' })), ordinaryKey);
  assert.equal(cache.options.buildKey(req({ sponsoredOnly: 'true' })), null);
  assert.equal(cache.options.buildKey(req({ sponsoredOnly: 'true', category: 'faith-culture' })), null);
  assert.equal(cache.options.buildKey(req({ sponsoredOnly: 'true', category: 'business', page: '2' })), null);
  assert.ok(cache.options.buildLastKnownGoodKey(req({}), ordinaryKey));
  assert.equal(cache.options.buildLastKnownGoodKey(req({ sponsoredOnly: 'true' }), ordinaryKey), null);
  const paid = success(await state.get({ limit: '40' }));
  assert.equal(paid.total, 1); assert.equal(cache.reads.length, 0);
  const ordinary = await state.get({ sponsoredOnly: undefined, limit: '40' });
  assert.equal(ordinary.status, 200); assert.deepEqual(ordinary.body, cache.cachedBody);
  assert.equal(cache.reads.length, 1);
  assert.equal(success(await state.get({ limit: '40' })).total, 1);
  assert.equal(cache.reads.length, 1);
  const invalid = await state.get({ sponsoredOnly: 'invalid', limit: '40' });
  assert.equal(invalid.status, 400); assert.equal(cache.reads.length, 1);
  assert.ok(cache.options.buildKey(req({ category: 'faith-culture' })).includes(':faith-v1:'));
});
