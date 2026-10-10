const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');

process.env.NODE_ENV = 'test';
process.env.NEWSPULSE_ALLOW_REDIS_IN_TESTS = 'false';
process.env.JWT_SECRET = randomBytes(48).toString('hex');

const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const EditorialTopic = require('../models/EditorialTopic');
const News = require('../models/News');
const Article = require('../models/Article');
const User = require('../models/User');
const topics = require('../services/editorialTopics.service');
const publicRouter = require('../routes/publicEditorialTopics.routes');
const adminRouter = require('../routes/adminEditorialTopics.routes');
const { matches: sharedMatches, runPipeline } = require('./helpers/pulseDialogueAggregate');
const onDemandTranslation = require('../services/newsOnDemandTranslation.service');
const asyncTranslation = require('../services/publishAsyncTranslation.service');

const NOW = new Date('2026-10-10T12:00:00.000Z');
const TAG = 'topic:navratri-2026';
const id = number => new mongoose.Types.ObjectId(number.toString(16).padStart(24, '0'));
const actor = { id: String(id(900)) };
const adminBases = ['/api/admin/topics', '/admin-api/admin/topics', '/admin-api/api/admin/topics'];
const publicBase = '/api/public/topics';

function payload(overrides = {}) {
  return { slug: 'navratri-2026', name: { gu: 'GU Navratri', hi: 'HI Navratri', en: 'EN Navratri' },
    startsAt: '2020-01-01T00:00:00.000Z', articleTags: [TAG], ...overrides };
}

function topic(number = 1, overrides = {}) {
  return { _id: id(number), ...payload(), slug: `topic-${number}`, active: true, order: 0,
    startsAt: new Date('2020-01-01'), expiresAt: null, description: { gu: 'GU description', hi: '', en: 'EN description' },
    pinnedArticleId: null, createdBy: 'private-creator', updatedBy: 'private-updater',
    createdAt: new Date('2020-01-01'), updatedAt: new Date('2020-01-01'), __v: 0, ...overrides };
}

function story(number = 100, overrides = {}) {
  return { _id: id(number), title: `EN story ${number}`, description: `Summary ${number}`, content: '<p>Full body</p>',
    slug: `story-${number}`, category: 'national', status: 'published', tags: [TAG],
    lang: 'en', language: 'en', originalLang: 'en', translationKey: `group-${number}`,
    translationGroupId: `group-${number}`, sourceArticleId: null, publishedAt: new Date('2020-01-01'),
    coverImage: { url: 'https://example.test/cover.jpg', alt: 'Cover', publicId: 'private-storage-id' },
    internalComments: [{ message: 'Private CMS comment' }], translations: {}, translationStatus: {},
    createdAt: new Date('2020-01-01'), updatedAt: new Date('2025-01-01'), ...overrides };
}

function matches(doc, filter) {
  return Object.entries(filter).every(([field, value]) => {
    if (field === '$and') return value.every(clause => matches(doc, clause));
    if (field === '$or') return value.some(clause => matches(doc, clause));
    if (field === 'tags' && value.$in) return Array.isArray(doc.tags) && value.$in.some(tag => doc.tags.includes(tag));
    if (value?.$gt instanceof Date) return doc[field] != null && new Date(doc[field]) > value.$gt;
    return sharedMatches(doc, { [field]: value });
  });
}

// Extend the existing in-memory pipeline runner only for array-tag matches and date accumulators.
function aggregateRows(input, pipeline) {
  let rows = input.slice();
  for (const stage of pipeline) {
    if (stage.$match) rows = rows.filter(doc => matches(doc, stage.$match));
    else if (stage.$facet) rows = [Object.fromEntries(Object.entries(stage.$facet)
      .map(([key, stages]) => [key, aggregateRows(rows, stages)]))];
    else if (stage.$group?.originalPublication) {
      const { originalPublication, earliestPublication, ...group } = stage.$group;
      assert.deepEqual(originalPublication, { $min: '$sourcePublication' });
      assert.deepEqual(earliestPublication, { $min: '$publishedAt' });
      const grouped = runPipeline(rows, [{ $group: group }]);
      for (const result of grouped) {
        const members = rows.filter(row => row.storyKey === result._id);
        const dates = field => members.map(row => row[field]).filter(value => value != null).map(value => new Date(value).getTime());
        const sourceDates = dates('sourcePublication');
        const publicationDates = dates('publishedAt');
        result.originalPublication = sourceDates.length ? new Date(Math.min(...sourceDates)) : null;
        result.earliestPublication = publicationDates.length ? new Date(Math.min(...publicationDates)) : null;
      }
      rows = grouped;
    } else rows = runPipeline(rows, [stage]);
  }
  return rows;
}

function query(input, { single = false, hydrate = false, count = false } = {}) {
  let rows = input.slice();
  const result = () => count ? rows.length : single
    ? (rows[0] ? (hydrate ? EditorialTopic.hydrate(rows[0]) : rows[0]) : null) : rows;
  return {
    select(fields) {
      const allowed = new Set(['_id', ...fields.split(' ').map(field => field.split('.')[0])]);
      rows = rows.map(doc => Object.fromEntries(Object.entries(doc).filter(([field]) => allowed.has(field))));
      return this;
    },
    sort(order) { rows = runPipeline(rows, [{ $sort: order }]); return this; },
    skip(value) { rows = rows.slice(value); return this; },
    limit(value) { rows = rows.slice(0, value); return this; },
    maxTimeMS(value) { assert.equal(value, topics.QUERY_MS); return this; },
    collation(value) { assert.deepEqual(value, { locale: 'simple' }); return this; },
    lean: async () => result(),
    then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
  };
}

function setup(context, { topicDocs = [topic()], newsDocs = [], users: userOverrides = {} } = {}) {
  const previousState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = previousState; });
  const writes = { topics: 0, news: 0, article: 0, translation: 0, connection: 0 };
  const store = new Map(topicDocs.map(doc => [String(doc._id), doc]));
  const pipelines = [];
  const newsReads = [];
  const logged = [];
  context.mock.method(console, 'error', (...args) => logged.push(args));
  const forbid = kind => async () => { writes[kind] += 1; throw new Error(`Forbidden ${kind} operation`); };
  context.mock.method(mongoose, 'connect', forbid('connection'));
  context.mock.method(mongoose, 'createConnection', forbid('connection'));
  for (const [Model, kind] of [[News, 'news'], [Article, 'article']]) {
    for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate',
      'deleteOne', 'deleteMany', 'findOneAndDelete', 'bulkWrite']) context.mock.method(Model, method, forbid(kind));
    context.mock.method(Model.prototype, 'save', forbid(kind));
  }
  for (const method of ['create', 'insertMany', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteMany', 'bulkWrite']) {
    context.mock.method(EditorialTopic, method, forbid('topics'));
  }
  context.mock.method(onDemandTranslation, 'ensureOnDemandNewsTranslation', forbid('translation'));
  context.mock.method(asyncTranslation, 'enqueueTranslateAndSave', forbid('translation'));
  context.mock.method(News, 'findOne', filter => {
    newsReads.push(filter);
    return query(newsDocs.filter(doc => matches(doc, filter)), { single: true });
  });
  context.mock.method(News, 'find', filter => {
    newsReads.push(filter);
    return query(newsDocs.filter(doc => matches(doc, filter)));
  });
  context.mock.method(News, 'aggregate', pipeline => {
    pipelines.push(pipeline);
    return {
      option(options) {
        assert.deepEqual(options, { maxTimeMS: 2500, allowDiskUse: false, collation: { locale: 'simple' } });
        return this;
      },
      exec: async () => aggregateRows(newsDocs, pipeline),
    };
  });
  context.mock.method(EditorialTopic, 'find', filter => query([...store.values()].filter(doc => matches(doc, filter))));
  context.mock.method(EditorialTopic, 'findOne', filter => query([...store.values()].filter(doc => matches(doc, filter)), { single: true }));
  context.mock.method(EditorialTopic, 'findById', value => query([...store.values()].filter(doc => String(doc._id) === String(value)),
    { single: true, hydrate: true }));
  context.mock.method(EditorialTopic, 'countDocuments', filter => query([...store.values()].filter(doc => matches(doc, filter)), { count: true }));
  context.mock.method(EditorialTopic.prototype, 'save', async function save() {
    await this.validate();
    if ([...store.values()].some(doc => doc.slug === this.slug && String(doc._id) !== String(this._id))) {
      throw Object.assign(new Error('Internal duplicate database details'), { code: 11000 });
    }
    writes.topics += 1;
    this.createdAt ||= new Date();
    this.updatedAt = new Date();
    this.$isNew = false;
    store.set(String(this._id), this.toObject());
    return this;
  });
  const roles = ['founder', 'admin', 'editor', 'reporter', 'manager'];
  const users = Object.fromEntries(roles.map((role, index) => [role, {
    _id: id(900 + index), email: `${role}@example.test`, name: 'Test User', role, status: 'active',
    accountStatus: 'active', noExpiry: true, loginAllowed: true, tokenVersion: 0, ...userOverrides[role],
  }]));
  context.mock.method(User, 'findById', value => ({
    lean: async () => Object.values(users).find(user => String(user._id) === String(value)) || null,
  }));
  const token = (role = 'founder', overrides = {}) => jwt.sign({
    sub: String(users[role]._id), role, type: 'access', tokenVersion: 0, ...overrides,
  }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const app = express();
  app.use(express.json());
  app.use(publicBase, publicRouter);
  for (const base of adminBases) app.use(base, adminRouter);
  context.after(() => {
    assert.equal(writes.news, 0, 'No News writes, including article publication');
    assert.equal(writes.article, 0, 'No compatibility Article writes');
    assert.equal(writes.translation, 0, 'No translation generation');
    assert.equal(writes.connection, 0, 'No database connections');
  });
  return { app, writes, store, pipelines, newsReads, logged, token, users };
}

function founderRequest(state, method, path, body) {
  const call = request(state.app)[method](path).set('Authorization', `Bearer ${state.token()}`);
  return body === undefined ? call : call.send(body);
}

test('model defaults, multilingual fields, exact tag normalization, reference and indexes', async () => {
  const doc = new EditorialTopic(payload({ articleTags: [` ${TAG} `, TAG, 'Topic:Literal'], name: { gu: ' GU ', hi: ' HI ', en: ' EN ' } }));
  await doc.validate();
  assert.equal(doc.active, false);
  assert.equal(doc.order, 0);
  assert.equal(doc.expiresAt, null);
  assert.equal(doc.name.gu, 'GU');
  assert.deepEqual([...doc.articleTags], [TAG, 'Topic:Literal']);
  assert.equal(EditorialTopic.schema.path('pinnedArticleId').options.ref, 'News');
  assert.ok(EditorialTopic.schema.indexes().some(([key, options]) => key.slug === 1 && options.unique === true));
  assert.ok(EditorialTopic.schema.indexes().every(([, options]) => options.expireAfterSeconds === undefined));
  assert.equal(EditorialTopic.schema.options.optimisticConcurrency, true);
  assert.equal(Article.schema.path('topic'), undefined);
});

for (const lang of ['gu', 'hi', 'en']) {
  test(`model requires the ${lang} topic name`, async () => {
    const input = payload();
    delete input.name[lang];
    await assert.rejects(new EditorialTopic(input).validate(), error => Boolean(error.errors[`name.${lang}`]));
  });
}

test('model canonicalizes case and preserves immutable slug and creator identity', async () => {
  const doc = new EditorialTopic(payload({ slug: 'NAVRATRI-2026' }));
  await doc.validate();
  assert.equal(doc.slug, 'navratri-2026');
  const stored = EditorialTopic.hydrate(topic());
  stored.slug = 'changed';
  stored.createdBy = 'changed';
  assert.equal(stored.slug, 'topic-1');
  assert.equal(stored.createdBy, 'private-creator');
});

test('model rejects unsafe slugs, dates, ordering and invalid tag arrays', async () => {
  const cases = [
    ...['', '../escape', 'with/slash', 'with space', 'double--dash', 'bad%20slug', 'bad?slug', 'x'.repeat(141)].map(slug => ({ slug })),
    { startsAt: null }, { startsAt: 'not-a-date' }, { expiresAt: 'not-a-date' },
    { expiresAt: '2020-01-01T00:00:00Z' }, { expiresAt: '2019-01-01T00:00:00Z' },
    { order: 1.5 }, { order: Number.MAX_SAFE_INTEGER + 1 },
    { articleTags: [] }, { articleTags: [''] }, { articleTags: ['topic:*'] }, { articleTags: ['bad\nvalue'] },
    { articleTags: Array.from({ length: 21 }, (_, index) => `tag-${index}`) }, { articleTags: ['x'.repeat(121)] },
  ];
  for (const value of cases) await assert.rejects(new EditorialTopic(payload(value)).validate(), undefined, JSON.stringify(value));
});

test('strip uses exact start/expiry boundaries and stable ascending order without writes', async context => {
  const state = setup(context, { topicDocs: [
    topic(5, { order: 2 }), topic(3, { order: 1 }), topic(2, { order: 1, startsAt: NOW }),
    topic(6, { startsAt: new Date(NOW.getTime() + 1) }), topic(7, { expiresAt: NOW }),
    topic(8, { active: false }), topic(9, { expiresAt: new Date(NOW.getTime() - 1) }),
    topic(10, { order: -1, expiresAt: new Date(NOW.getTime() + 1) }),
  ] });
  const result = await topics.listPublicTopics({}, NOW);
  assert.equal(result.lang, 'gu');
  assert.deepEqual(result.items.map(item => item.slug), ['topic-10', 'topic-2', 'topic-3', 'topic-5']);
  assert.equal(state.writes.topics, 0);
});

for (const lang of ['gu', 'hi', 'en']) {
  test(`public strip ${lang} matches the frontend contract and hides management fields`, async context => {
    const state = setup(context);
    const response = await request(state.app).get(`${publicBase}?lang=${lang}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.lang, lang);
    const item = response.body.items[0];
    assert.deepEqual(Object.keys(item).sort(), ['id', 'key', 'slug', 'label', 'href', 'colorKey', 'name', 'description',
      'order', 'startsAt', 'expiresAt'].sort());
    assert.equal(item.label, topic().name[lang]);
    assert.equal(item.key, 'topic-1');
    assert.equal(item.href, '/topic/topic-1');
    assert.equal(item.colorKey, 'blue');
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.headers['surrogate-control'], 'no-store');
    assert.equal(state.writes.topics, 0);
  });
}

test('empty public database returns an empty strip with no seeding or writes', async context => {
  const state = setup(context, { topicDocs: [] });
  const response = await request(state.app).get(publicBase);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, lang: 'gu', items: [] });
  assert.deepEqual(state.writes, { topics: 0, news: 0, article: 0, translation: 0, connection: 0 });
});

test('public inputs reject unsupported locales, injection, unknown fields and invalid bounds', async context => {
  const state = setup(context);
  for (const path of [
    '?lang=fr', '?lang=', '?lang=gu&lang=hi', '?lang[$ne]=gu', '?limit=0', '?limit=51', '?limit=1.5',
    '?limit=2&limit=3', '?page=1', '?active=false', '?limit=9999999999999999999',
    '/topic-1?lang=en-US', '/topic-1?limit=1', '/topic-1/articles?page=0', '/topic-1/articles?page=-1',
    '/topic-1/articles?page=10001', '/topic-1/articles?page=1.5', '/topic-1/articles?limit=51',
    '/topic-1/articles?q=navratri', '/topic-1/articles?category=national',
  ]) {
    const response = await request(state.app).get(`${publicBase}${path}`);
    assert.equal(response.status, 400, path);
    assert.equal(response.body.ok, false);
  }
  assert.equal(state.writes.topics, 0);
});

test('detail and stories preserve expired archives but hide future, inactive and missing topics', async context => {
  const state = setup(context, { topicDocs: [topic(), topic(2, { expiresAt: new Date('2020-01-02') }),
    topic(3, { startsAt: new Date('2999-01-01') }), topic(4, { active: false })] });
  for (const slug of ['topic-1', 'topic-2']) {
    const detail = await request(state.app).get(`${publicBase}/${slug}?lang=en`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.topic.label, 'EN Navratri');
    assert.equal(detail.body.pinnedArticle, null);
    const stories = await request(state.app).get(`${publicBase}/${slug}/articles?lang=en`);
    assert.equal(stories.status, 200);
    assert.deepEqual(stories.body.items, []);
    assert.equal(stories.body.totalPages, 0);
  }
  for (const slug of ['topic-3', 'topic-4', 'missing', 'bad%2Fslug']) {
    for (const suffix of ['', '/articles']) {
      assert.equal((await request(state.app).get(`${publicBase}/${slug}${suffix}`)).status, 404, `${slug}${suffix}`);
    }
  }
  assert.equal(state.writes.topics, 0);
});

test('stories match exact case-sensitive tags across categories, never substrings or taxonomy', async context => {
  const state = setup(context, { newsDocs: [
    story(100), story(101, { category: 'sports' }), story(102, { category: 'faith-culture', topic: 'living-heritage' }),
    story(103, { tags: [`${TAG}-extra`] }), story(104, { tags: [TAG.toUpperCase()] }),
    story(105, { tags: [], title: TAG, category: TAG, topic: TAG }),
    story(106, { tags: ['independent-tag'] }),
  ], topicDocs: [topic(1, { articleTags: [TAG, 'independent-tag'] })] });
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.slug), ['story-100', 'story-101', 'story-102', 'story-106']);
  assert.equal(response.body.total, 4);
  assert.equal(state.writes.topics, 0);
  assert.ok(state.pipelines.every(pipeline => !JSON.stringify(pipeline[0]).includes('category')));
});

test('every public article visibility gate applies before grouping and hydration', async context => {
  const future = new Date('2999-01-01');
  const hidden = [
    ...['draft', 'scheduled', 'archived', 'deleted', 'rejected'].map(status => ({ status })),
    { publishedAt: future }, { scheduledAt: future }, { publishAt: future }, { deletedAt: new Date() },
    { locked: true }, { embargoUntil: future }, { workflow: { locked: true } },
    { workflow: { embargoUntil: future } }, { isPrivate: true }, { visibility: 'private' }, { visibility: 'PRIVATE' },
  ];
  const state = setup(context, { newsDocs: [story(100), ...hidden.map((value, index) => story(101 + index, value))] });
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.slug), ['story-100']);
  assert.equal(response.body.total, 1);
  assert.ok(state.newsReads.every(filter => JSON.stringify(filter).includes('"status":"published"')));
});

for (const lang of ['gu', 'hi', 'en']) {
  test(`stories resolve only ${lang} native or ready complete translations without duplicates`, async context => {
    const editions = ['gu', 'hi', 'en'].map((locale, index) => story(100 + index, {
      translationKey: 'one-story', translationGroupId: 'one-story', lang: locale, language: locale, originalLang: locale,
      title: `${locale} native`, sourceArticleId: index ? id(100) : null,
    }));
    const sourceLang = lang === 'en' ? 'gu' : 'en';
    const cached = status => ({ originalLang: sourceLang, language: sourceLang, lang: sourceLang,
      translations: { [lang]: { title: `${lang} cached`, summary: 'Cached summary', content: '<p>Cached body</p>' } },
      translationStatus: { [lang]: status } });
    const state = setup(context, { newsDocs: [...editions, story(110, cached('ready')), story(111, cached('pending')),
      story(112, cached('failed')), story(113, cached(undefined)),
      story(114, { ...cached('ready'), translations: { [lang]: { title: 'Partial', summary: '', content: 'Body' } } }),
      story(115, { originalLang: sourceLang, language: sourceLang, lang: sourceLang }),
    ] });
    const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=${lang}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 2);
    assert.equal(response.body.count, 2);
    assert.ok(response.body.items.some(item => item.title === `${lang} native`));
    assert.ok(response.body.items.some(item => item.title === `${lang} cached`));
    for (const item of response.body.items) {
      assert.equal(item.lang, lang);
      assert.equal(item.resolvedLang, lang);
      assert.equal(item.isFallback, false);
      for (const field of ['content', 'translations', 'translationStatus', 'internalComments', 'sourceArticleId']) {
        assert.equal(item[field], undefined);
      }
    }
    assert.equal(state.writes.topics, 0);
  });
}

test('grouping agrees with existing translation-key, group-id, slug and id identities', async context => {
  const state = setup(context, { newsDocs: [
    story(100, { translationKey: null, translationGroupId: 'shared' }),
    story(101, { translationKey: 'shared', translationGroupId: null }),
    story(102, { translationKey: null, translationGroupId: null, slugs: { en: 'same-slug' } }),
    story(103, { translationKey: null, translationGroupId: null, slug: 'same-slug' }),
    story(104, { translationKey: null, translationGroupId: null, slug: '' }),
    story(105, { translationKey: 'SHARED', translationGroupId: null }),
  ] });
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en`);
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 4);
  assert.equal(response.body.count, 4);
});

test('fixed pages and totals use unique eligible stories ordered by original publication, not translation/edit time', async context => {
  const docs = Array.from({ length: 7 }, (_, index) => story(100 + index, {
    publishedAt: new Date(Date.UTC(2020, 0, index + 1)), updatedAt: new Date(Date.UTC(2030, 0, 7 - index)),
  }));
  docs[0] = { ...docs[0], lang: 'gu', language: 'gu', originalLang: 'gu' };
  docs.push(story(200, { translationKey: 'group-100', translationGroupId: 'group-100', sourceArticleId: id(100),
    publishedAt: new Date('2025-01-01'), title: 'New translation of oldest story' }));
  docs.push(story(201, { originalLang: 'hi', lang: 'hi', language: 'hi', publishedAt: new Date('2025-01-02') }));
  const state = setup(context, { newsDocs: docs });
  const all = [];
  for (let page = 1; page <= 4; page += 1) {
    const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en&page=${page}&limit=2`);
    assert.equal(response.status, 200);
    assert.equal(response.body.limit, 2);
    assert.equal(response.body.total, 7);
    assert.equal(response.body.totalPages, 4);
    assert.equal(response.body.hasNextPage, page < 4);
    all.push(...response.body.items);
  }
  assert.deepEqual(all.map(item => item.translationKey), ['group-106', 'group-105', 'group-104', 'group-103', 'group-102', 'group-101', 'group-100']);
  assert.equal(all.at(-1).publishedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(new Set(all.map(item => item.translationKey)).size, 7);
  for (const pipeline of state.pipelines) {
    const facet = pipeline.at(-1).$facet;
    assert.deepEqual(facet.items.at(-1), { $limit: 2 });
    assert.ok(pipeline.findIndex(stage => stage.$group) < pipeline.findIndex(stage => stage.$facet));
  }
  const beyond = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en&page=5&limit=2`);
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.total, 7);
});

test('locale eligibility uses shared canonical and legacy language normalization before totals', async context => {
  const state = setup(context, { newsDocs: [
    story(100, { originalLang: 'Gujarati', lang: 'en' }),
    story(101, { originalLang: null, lang: 'GU_in' }),
    story(102, { originalLang: null, lang: null, language: 'guj' }),
    story(103, { originalLang: 'hi', lang: 'gu' }),
  ] });
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=gu`);
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 3);
  assert.ok(response.body.items.every(item => item.resolvedLang === 'gu'));
});

test('legacy unlinked editions and missing source records retain earliest original publication ordering', async context => {
  const state = setup(context, { newsDocs: [
    story(100, { originalLang: 'gu', lang: 'gu', language: 'gu', publishedAt: new Date('2020-01-01') }),
    story(101, { translationKey: 'group-100', translationGroupId: 'group-100', publishedAt: new Date('2025-01-01') }),
    story(102, { publishedAt: new Date('2020-02-01') }),
    story(103, { sourceArticleId: id(999), publishedAt: new Date('2020-03-01') }),
    story(104, { sourceArticleId: id(999), translationKey: 'group-103', translationGroupId: 'group-103',
      publishedAt: new Date('2025-02-01') }),
  ] });
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.translationKey), ['group-103', 'group-102', 'group-100']);
  assert.equal(response.body.items[0].publishedAt, '2020-03-01T00:00:00.000Z');
  assert.equal(response.body.items.at(-1).publishedAt, '2020-01-01T00:00:00.000Z');
});

test('all successful public GET surfaces perform zero topic/article/translation writes or connections', async context => {
  const state = setup(context, { topicDocs: [topic(1, { pinnedArticleId: id(100) })], newsDocs: [story(100), story(101)] });
  for (const path of [publicBase, `${publicBase}/topic-1`, `${publicBase}/topic-1/articles`]) {
    assert.equal((await request(state.app).get(`${path}?lang=en`)).status, 200);
  }
  assert.deepEqual(state.writes, { topics: 0, news: 0, article: 0, translation: 0, connection: 0 });
});

test('pin resolves a localized edition on detail and excludes the whole logical story from totals', async context => {
  const state = setup(context, { topicDocs: [topic(1, { pinnedArticleId: id(100) })], newsDocs: [
    story(100, { lang: 'gu', language: 'gu', originalLang: 'gu' }),
    story(101, { translationKey: 'group-100', translationGroupId: 'group-100', sourceArticleId: id(100), title: 'English pinned edition' }),
    story(102),
  ] });
  const detail = await request(state.app).get(`${publicBase}/topic-1?lang=en`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.pinnedArticle.title, 'English pinned edition');
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en&limit=1`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.items.map(item => item.slug), ['story-102']);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.totalPages, 1);
  assert.equal(response.body.pinnedArticle, undefined);
  assert.equal(state.writes.topics, 0);
});

test('read-time pin validation omits missing, ineligible, retagged and unavailable-language pins', async context => {
  const docs = [story(100, { status: 'draft' }), story(101, { tags: ['unrelated'] }), story(102, { locked: true }),
    story(103, { originalLang: 'hi', lang: 'hi', language: 'hi' }), story(104, { publishedAt: new Date('2999-01-01') })];
  const state = setup(context, { newsDocs: docs,
    topicDocs: [100, 101, 102, 103, 104, 999].map((pin, index) => topic(index + 1, { pinnedArticleId: id(pin) })) });
  for (let index = 1; index <= 6; index += 1) {
    const response = await request(state.app).get(`${publicBase}/topic-${index}?lang=en`);
    assert.equal(response.status, 200);
    assert.equal(response.body.pinnedArticle, null);
  }
  assert.equal(state.writes.topics, 0);
});

test('missing or newly ineligible hydration fails safely rather than returning incorrect totals', async context => {
  const state = setup(context, { newsDocs: [story()] });
  context.mock.method(News, 'find', () => query([]));
  const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en`);
  assert.equal(response.status, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.items, undefined);
  assert.equal(state.logged.length, 1);
});

test('translation readiness is checked again during page hydration', async context => {
  const translated = story(100, { translations: { hi: { title: 'HI title', summary: 'HI summary', content: 'HI body' } },
    translationStatus: { hi: 'ready' } });
  const state = setup(context, { newsDocs: [translated] });
  context.mock.method(News, 'find', () => query([{ ...translated, translationStatus: { hi: 'pending' } }]));
  assert.equal((await request(state.app).get(`${publicBase}/topic-1/articles?lang=hi`)).status, 503);
});

test('Founder CRUD supports partial translations, schedules, clearing expiry and stable identity', async context => {
  const state = setup(context, { topicDocs: [] });
  const created = await founderRequest(state, 'post', adminBases[0], payload({ slug: ' NAVRATRI-2026 ', articleTags: [TAG, ` ${TAG} `] }));
  assert.equal(created.status, 201);
  const value = created.body.topic;
  assert.equal(value.active, false);
  assert.equal(value.slug, 'navratri-2026');
  assert.equal(value.createdBy, String(state.users.founder._id));
  assert.equal(value.updatedBy, value.createdBy);
  assert.deepEqual(value.articleTags, [TAG]);
  assert.ok(value.createdAt && value.updatedAt);
  const path = `${adminBases[0]}/${value.id}`;
  const update = await founderRequest(state, 'patch', path, { name: { gu: 'Updated GU' }, description: { hi: 'Description HI' },
    active: true, order: -2, expiresAt: '2020-02-01T00:00:00Z' });
  assert.equal(update.status, 200);
  assert.equal(update.body.topic.id, value.id);
  assert.equal(update.body.topic.name.gu, 'Updated GU');
  assert.equal(update.body.topic.name.en, value.name.en);
  assert.equal(update.body.topic.active, true);
  assert.equal(update.body.topic.order, -2);
  assert.equal((await request(state.app).get(`${publicBase}/${value.slug}`)).status, 200);
  assert.deepEqual((await request(state.app).get(publicBase)).body.items, []);
  const cleared = await founderRequest(state, 'patch', path, { expiresAt: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.topic.expiresAt, null);
  assert.equal((await request(state.app).get(publicBase)).body.items.length, 1);
  assert.equal((await founderRequest(state, 'patch', path, { startsAt: '2999-01-01T00:00:00Z' })).status, 200);
  assert.equal((await request(state.app).get(`${publicBase}/${value.slug}`)).status, 404);
  assert.equal((await founderRequest(state, 'patch', path, { startsAt: '2020-01-01T00:00:00Z', active: false })).status, 200);
  assert.equal((await request(state.app).get(`${publicBase}/${value.slug}`)).status, 404);
  const fetched = await founderRequest(state, 'get', path);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.topic.id, value.id);
  assert.equal(fetched.body.topic.active, false);
});

test('Founder management listing filters active states with bounded fixed pagination', async context => {
  const state = setup(context, { topicDocs: [topic(1, { order: 2 }), topic(2, { active: false }), topic(3, { order: 1 })] });
  const active = await founderRequest(state, 'get', `${adminBases[0]}?active=true&page=2&limit=1`);
  assert.equal(active.status, 200);
  assert.equal(active.body.total, 2);
  assert.equal(active.body.items[0].slug, 'topic-1');
  const inactive = await founderRequest(state, 'get', `${adminBases[0]}?active=false`);
  assert.deepEqual(inactive.body.items.map(item => item.slug), ['topic-2']);
  const all = await founderRequest(state, 'get', `${adminBases[0]}?active=all`);
  assert.equal(all.body.total, 3);
  for (const suffix of ['?active=yes', '?page=0', '?limit=101', '?lang=en', '?page[$gt]=1']) {
    assert.equal((await founderRequest(state, 'get', adminBases[0] + suffix)).status, 400);
  }
});

for (const base of adminBases) {
  test(`Founder-only protection covers all management operations at ${base}`, async context => {
    const state = setup(context);
    const operations = [['get', base], ['post', base], ['get', `${base}/${id(1)}`], ['patch', `${base}/${id(1)}`]];
    for (const [method, path] of operations) {
      assert.equal((await request(state.app)[method](path).send(payload())).status, 401);
      for (const role of ['admin', 'editor', 'reporter', 'manager']) {
        const response = await request(state.app)[method](path).set('Authorization', `Bearer ${state.token(role)}`).send(payload());
        assert.equal(response.status, 403, `${role} ${method} ${path}`);
      }
    }
    assert.equal((await founderRequest(state, 'get', base)).status, 200);
    assert.equal((await founderRequest(state, 'get', `${base}/${id(1)}`)).status, 200);
    assert.equal((await founderRequest(state, 'patch', `${base}/${id(1)}`, { order: 3 })).status, 200);
    assert.equal((await founderRequest(state, 'post', base, payload())).status, 201);
    assert.equal(state.writes.topics, 2);
  });
}

test('Founder authentication checks persisted role, account lifecycle and token version', async context => {
  const state = setup(context);
  for (const overrides of [{ tokenVersion: 1 }, { type: 'reporter' }, { exp: 1 }]) {
    const signOptions = 'exp' in overrides ? {} : { expiresIn: '10m' };
    const token = jwt.sign({ sub: String(id(900)), role: 'founder', type: 'access', tokenVersion: 0, ...overrides },
      process.env.JWT_SECRET, signOptions);
    assert.equal((await request(state.app).post(adminBases[0]).set('Authorization', `Bearer ${token}`).send(payload())).status, 401);
  }
  const promotedClaim = state.token('admin', { role: 'founder' });
  assert.equal((await request(state.app).post(adminBases[0]).set('Authorization', `Bearer ${promotedClaim}`).send(payload())).status, 403);
  state.users.founder.accountStatus = 'suspended';
  assert.equal((await founderRequest(state, 'post', adminBases[0], payload())).status, 403);
  state.users.founder.accountStatus = 'active';
  state.users.founder.loginAllowed = false;
  assert.equal((await founderRequest(state, 'post', adminBases[0], payload())).status, 403);
  assert.equal(state.writes.topics, 0);
});

test('create and patch reject spoofed metadata, unsafe fields, invalid dates and invalid types', async context => {
  const state = setup(context);
  const invalidInputs = [
    { name: { en: 'Only English' } }, { name: { gu: '', hi: 'Hindi', en: 'English' } },
    { slug: '../unsafe' }, { startsAt: 'not-a-date' }, { startsAt: '2026-02-30T12:00:00Z' },
    { startsAt: '2026-10-10' }, { startsAt: null }, { expiresAt: '2020-01-01T00:00:00Z' },
    { expiresAt: '2019-01-01T00:00:00Z' }, { order: 0.5 }, { order: '2' }, { active: 'true' },
    { articleTags: [] }, { articleTags: 'tag' }, { articleTags: ['topic:*'] }, { articleTags: [{ $ne: '' }] },
    { articleTags: Array(21).fill(TAG) }, { pinnedArticleId: 'compatibility-or-invalid-id' },
    { createdBy: 'spoofed' }, { updatedBy: 'spoofed' }, { colorKey: 'private-color' }, { href: '/unsafe' },
    { unknown: true },
  ];
  for (const value of invalidInputs) {
    const response = await founderRequest(state, 'post', adminBases[0], payload(value));
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.equal(response.body.ok, false);
  }
  for (const value of [{}, { slug: 'different' }, { name: { en: '' } }, { name: { fr: 'French' } },
    { description: { gu: 42 } }, { createdBy: 'spoofed' }, { updatedAt: new Date().toISOString() },
    { $set: { active: true } }, { expiresAt: '2019-01-01T00:00:00Z' }]) {
    assert.equal((await founderRequest(state, 'patch', `${adminBases[0]}/${id(1)}`, value)).status, 400, JSON.stringify(value));
  }
  assert.equal(state.writes.topics, 0);
  assert.equal((await founderRequest(state, 'get', `${adminBases[0]}/invalid`)).status, 400);
  assert.equal((await founderRequest(state, 'get', `${adminBases[0]}/${id(999)}`)).status, 404);
  assert.equal((await founderRequest(state, 'patch', `${adminBases[0]}/${id(999)}`, { active: true })).status, 404);
});

test('duplicate slug returns a safe 409 without replacing the existing topic', async context => {
  const state = setup(context, { topicDocs: [topic(1, { slug: 'navratri-2026' })] });
  const response = await founderRequest(state, 'post', adminBases[0], payload());
  assert.equal(response.status, 409);
  assert.deepEqual(response.body, { ok: false, code: 'SLUG_CONFLICT', message: 'Topic slug already exists' });
  assert.equal(state.store.size, 1);
  assert.equal(state.writes.topics, 0);
});

test('concurrent-save conflicts return a safe 409', async context => {
  const state = setup(context);
  context.mock.method(EditorialTopic.prototype, 'save', async () => { throw Object.assign(new Error('Internal version details'), { name: 'VersionError' }); });
  const response = await founderRequest(state, 'patch', `${adminBases[0]}/${id(1)}`, { order: 2 });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'EDIT_CONFLICT');
  assert.equal(JSON.stringify(response.body).includes('Internal'), false);
});

test('pin writes accept only eligible tag-associated CMS News IDs, not compatibility IDs', async context => {
  const state = setup(context, { newsDocs: [
    story(100), story(101, { status: 'draft' }), story(102, { tags: [`${TAG}-extra`] }),
    story(103, { locked: true }), story(104, { publishedAt: new Date('2999-01-01') }),
    story(105, { visibility: 'private' }), story(106, { embargoUntil: new Date('2999-01-01') }),
  ] });
  context.mock.method(Article, 'findById', () => { throw new Error('Compatibility Article lookup must never be used'); });
  context.mock.method(Article, 'findOne', () => { throw new Error('Compatibility Article lookup must never be used'); });
  for (const pin of [101, 102, 103, 104, 105, 106, 999]) {
    assert.equal((await founderRequest(state, 'post', adminBases[0], payload({ pinnedArticleId: String(id(pin)) }))).status, 400);
  }
  const created = await founderRequest(state, 'post', adminBases[0], payload({ pinnedArticleId: String(id(100)) }));
  assert.equal(created.status, 201);
  assert.equal(created.body.topic.pinnedArticleId, String(id(100)));
  const path = `${adminBases[0]}/${created.body.topic.id}`;
  assert.equal((await founderRequest(state, 'patch', path, { articleTags: ['different-tag'] })).status, 400);
  assert.equal((await founderRequest(state, 'patch', path, { pinnedArticleId: String(id(999)) })).status, 400);
  const cleared = await founderRequest(state, 'patch', path, { articleTags: ['different-tag'], pinnedArticleId: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.topic.pinnedArticleId, null);
});

test('a stale pin does not block deactivation but must be valid to reactivate', async context => {
  const state = setup(context, { topicDocs: [topic(1, { pinnedArticleId: id(100) })], newsDocs: [story(100, { status: 'draft' })] });
  const path = `${adminBases[0]}/${id(1)}`;
  assert.equal((await founderRequest(state, 'patch', path, { active: false })).status, 200);
  assert.equal((await founderRequest(state, 'patch', path, { active: true })).status, 400);
  assert.equal((await founderRequest(state, 'patch', path, { pinnedArticleId: null, active: true })).status, 200);
});

test('database unavailability returns 503, never defaults or a success-shaped empty feed', async context => {
  const state = setup(context);
  mongoose.connection.readyState = 0;
  for (const path of [publicBase, `${publicBase}/topic-1`, `${publicBase}/topic-1/articles`]) {
    const response = await request(state.app).get(path);
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'TOPICS_UNAVAILABLE');
    assert.equal(response.body.items, undefined);
  }
  assert.equal((await founderRequest(state, 'post', adminBases[0], payload())).status, 503);
  assert.equal(state.writes.topics, 0);
});

test('query deadlines and unexpected database errors never expose internal messages or stacks', async context => {
  const state = setup(context, { newsDocs: [story()] });
  for (const [error, status] of [[Object.assign(new Error('Private query details'), { code: 50 }), 503],
    [new Error('Private query details'), 500]]) {
    context.mock.method(News, 'aggregate', () => ({ option() { return this; }, exec: async () => { throw error; } }));
    const response = await request(state.app).get(`${publicBase}/topic-1/articles?lang=en`);
    assert.equal(response.status, status);
    assert.equal(response.body.ok, false);
    assert.equal(JSON.stringify(response.body).includes('Private query details'), false);
    assert.equal(response.body.stack, undefined);
  }
  assert.equal(state.logged.length, 2);
});

test('real server mounts new routes and Founder aliases without changing the legacy strip contract', async context => {
  const state = setup(context, { topicDocs: [] });
  mongoose.connection.readyState = 0;
  const app = require('../server');
  mongoose.connection.readyState = 1;
  const strip = await request(app).get(publicBase);
  assert.equal(strip.status, 200);
  assert.deepEqual(strip.body, { ok: true, lang: 'gu', items: [] });
  for (const base of adminBases) {
    assert.equal((await request(app).get(base).set('Authorization', `Bearer ${state.token()}`)).status, 200);
    assert.equal((await request(app).post(base).set('Authorization', `Bearer ${state.token('admin')}`).send(payload())).status, 403);
  }
  mongoose.connection.readyState = 0;
  const legacy = await request(app).get('/api/public/trending-topics');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.success, true);
  assert.equal(legacy.body.data.source, 'default');
  assert.ok(legacy.body.data.items.some(item => item.key === 'sports' && item.href === '/sports'));
  assert.equal(state.writes.topics, 0);
});
