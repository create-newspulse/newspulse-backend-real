require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const express = require('express');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');
const { FAITH_TOPIC_CODES, buildFaithTopicPatch } = require('../lib/faithCultureTopics');
const { computeContentFingerprint, buildChildNewsSyncPatch } = require('../services/translationGroupSync.service');
const { sourceHashForDoc } = require('../services/articleTranslationGeneration.service');
const publicSyncService = require('../services/syncPublicArticleFromNews.service');
const invalidation = require('../services/publicContentInvalidation.service');
const routerFile = require.resolve('../routes/articles.routes');
const syncFile = require.resolve('../services/translationGroupSync.service');
require(routerFile);

const locales = ['en', 'hi', 'gu'];
const id = number => number.toString(16).padStart(24, '0');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const text = { en: 'Heritage story', hi: '\u0905\u0915\u094D\u0937\u0930', gu: '\u0A95\u0ABE\u0AB3\u0A9C\u0AC0' };

function article(number, lang = 'en', overrides = {}) {
  return {
    _id: id(number), category: 'faith-culture', topic: 'living-heritage',
    title: text[lang] || 'Other language', description: `${text[lang]} summary`, content: `${text[lang]} body`,
    lang, language: lang, originalLang: lang, sourceLanguage: 'en', sourceArticleId: id(1),
    translationGroupId: 'faith-topic-group', translationKey: 'faith-topic-group',
    slug: `stable-slug-${number}`, slugs: { [lang]: `stable-slug-${number}` },
    tags: [], geo: { state: null, district: null, city: null },
    status: 'published', publishedAt: '2020-01-01T00:00:00.000Z',
    workflowStage: 'PUBLISHED', workflowUpdatedAt: '2020-01-01T00:00:00.000Z',
    workflowHistory: [{ action: 'PUBLISH' }], syncMode: 'auto', syncVersion: 4,
    machineGenerated: number !== 1, humanEdited: true, translationReviewStatus: 'approved',
    sourceHash: 'unchanged-translation-source-hash',
    translationMeta: { humanEdited: true, provider: 'fixture' },
    translations: {
      hi: { title: 'Cached Hindi title', summary: 'Cached summary', content: 'Cached body', status: 'pending' },
      gu: { title: 'Cached Gujarati title', summary: 'Cached summary', content: 'Cached body', status: 'failed' },
    },
    translationStatus: { en: 'ready', hi: 'pending', gu: 'failed' },
    translationError: { gu: 'fixture failure' },
    ...overrides,
  };
}

function loadWithFixtures(filename, overrides) {
  const module = { exports: {} };
  const realRequire = createRequire(filename);
  const fixtureRequire = name => Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : realRequire(name);
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports', '__filename', '__dirname'], { filename })(
    fixtureRequire, module, module.exports, filename, path.dirname(filename),
  );
  return module.exports;
}

function setup(context, records = [article(1), article(2, 'hi'), article(3, 'gu')]) {
  const state = installEditorialFixture(context);
  state.rows.News.push(...clone(records));
  Object.assign(state, {
    creates: [], writes: [], generated: [], outdated: [], publicSync: [],
    errors: [], cacheInvalidations: 0, siblingFailure: false, siblingRace: false,
  });
  context.after(require('../lib/cache').onArticleCachesInvalidated(() => { state.cacheInvalidations++; }));
  Object.defineProperties(state, {
    docs: { get: () => new Map(state.rows.News.map(doc => [String(doc._id), doc])) },
    saves: { get: () => state.calls.filter(call => call.name === 'News' && call.method === 'save') },
  });
  const create = News.create;
  context.mock.method(News, 'create', async (payload, options) => {
    state.creates.push(...clone(Array.isArray(payload) ? payload : [payload]));
    return create(payload, options);
  });
  for (const method of ['findByIdAndUpdate', 'findOneAndUpdate', 'updateOne']) {
    const write = News[method];
    context.mock.method(News, method, (filter, update, options) => {
      state.writes.push({ method, filter: clone(filter), update: clone(update), options });
      if (method === 'updateOne') {
        if (state.siblingFailure) throw new Error('fixture-only internal database failure');
        if (state.siblingRace) return Promise.resolve({ acknowledged: true, matchedCount: 0, modifiedCount: 0 });
      }
      return write(filter, update, options);
    });
  }
  const syncPublicArticleFromNews = async (doc, options) => {
    state.publicSync.push(doc._id);
    return publicSyncService.syncPublicArticleFromNews(doc, options);
  };
  const sync = loadWithFixtures(syncFile, {
    './syncPublicArticleFromNews.service': { ...publicSyncService, syncPublicArticleFromNews },
    './publicContentInvalidation.service': {
      ...invalidation,
      notifyPublicContentInvalidation: async payload => { state.invalidations.push(clone(payload)); },
    },
  });
  const router = loadWithFixtures(routerFile, {
    '../services/translationGroupSync.service': sync,
    '../services/syncPublicArticleFromNews.service': { ...publicSyncService, syncPublicArticleFromNews },
    '../services/articleTranslationGeneration.service': {
      ...require('../services/articleTranslationGeneration.service'),
      enqueueArticleTranslationGeneration: async doc => { state.generated.push(doc._id); },
      markSiblingTranslationsOutdated: async doc => { state.outdated.push(doc._id); },
    },
    '../lib/audit': { logAudit: async () => {} },
  });
  context.mock.method(console, 'error', (...args) => { state.errors.push(args); });
  context.mock.method(console, 'warn', () => {});
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  app.use('/api/admin', router);
  app.use((error, req, res, next) => res.status(error.statusCode || error.status || 500).json({
    ok: false, message: error.message,
  }));
  state.post = (payload, role = 'founder', prefix = '/api') => state.request('post', `${prefix}/articles`, payload, role, app);
  state.put = (payload, rawId = id(1), role = 'founder') => state.request('put', `/api/articles/${rawId}`, payload, role, app);
  state.app = app;
  state.sync = sync;
  return state;
}

function success(response, status = 200) {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.ok, true);
  return response.body.article;
}

function withoutSyncMetadata(doc) {
  const result = clone(doc);
  for (const field of [
    'topic', 'syncVersion', 'lastSyncedAt', 'contentFingerprint', 'updatedAt',
    'translations', 'translationStatus', 'publicVisibilityRefreshAt',
  ]) delete result[field];
  return result;
}

function assertDerivedTranslations(state) {
  for (const doc of state.rows.News) {
    const copy = state.rows.Article.find(item => item.sourceNewsId === doc._id);
    assert.ok(copy, 'the existing public synchronization must persist each edition');
    assert.equal(copy.title, doc.title);
    assert.equal(copy.content, doc.content);
    assert.equal(copy.slug, doc.slug);
    assert.equal(copy.language, doc.lang);
    assert.equal(new Date(copy.publishedAt).getTime(), new Date(doc.publishedAt).getTime());
    for (const member of state.rows.News) {
      for (const cached of [doc, copy]) {
        assert.equal(cached.translationStatus[member.lang], 'ready');
        assert.equal(cached.translations[member.lang].title, member.title);
        assert.equal(cached.translations[member.lang].summary, member.description);
        assert.equal(cached.translations[member.lang].content, member.content);
      }
    }
  }
}

const draftPayload = { title: 'Faith and Culture story', description: 'Story summary', content: 'Story body', category: 'faith-culture', language: 'en' };

test('The Faith authoring allowlist contains exactly the seven approved codes', () => {
  assert.deepEqual(FAITH_TOPIC_CODES, [
    'faith-spiritual-life',
    'living-heritage',
    'food-agricultural-heritage',
    'architecture-art-public-heritage',
    'community-social-traditions',
    'folk-arts-festivals-textiles',
    'language-cultural-identity',
  ]);
});

for (const topic of FAITH_TOPIC_CODES) {
  test(`CMS creates a Faith draft with ${topic}`, async context => {
    const state = setup(context, []);
    const result = success(await state.post({ ...draftPayload, topic }), 201);
    assert.equal(result.topic, topic);
    assert.equal(state.creates[0].topic, topic);
    assert.equal(state.generated.length, 1, 'normal create-time translation generation is preserved');
  });
}

for (const [label, fields] of [['omitted', {}], ['null', { topic: null }], ['empty', { topic: '' }], ['whitespace', { topic: ' \t ' }]]) {
  test(`CMS accepts optional ${label} Faith topic`, async context => {
    const state = setup(context, []);
    const result = success(await state.post({ ...draftPayload, ...fields }), 201);
    assert.equal(result.topic, label === 'omitted' ? undefined : null);
  });
}

test('CMS safely normalizes a Faith code through the authenticated admin alias', async context => {
  const state = setup(context, []);
  assert.equal(success(await state.post({ ...draftPayload, topic: ' LIVING-HERITAGE ' }, 'founder', '/api/admin'), 201).topic, 'living-heritage');
});

for (const fields of [{}, { topic: ' LIVING-HERITAGE ' }]) {
  test(`CMS-created translation children inherit the source topic (${JSON.stringify(fields)})`, async context => {
    const state = setup(context, [article(1)]);
    const result = success(await state.post({
      ...draftPayload, ...fields, sourceArticleId: id(1), translationGroupId: 'faith-topic-group', language: 'hi',
    }), 201);
    assert.equal(result.topic, 'living-heritage');
    assert.equal(result.sourceArticleId, id(1));
  });
}

test('CMS-created translation children keep a source without a topic valid', async context => {
  const state = setup(context, [article(1, 'en', { topic: undefined })]);
  const result = success(await state.post({ ...draftPayload, sourceArticleId: id(1), language: 'gu' }), 201);
  assert.equal(result.topic, null);
});

for (const topic of ['faith-spiritual-life', null]) {
  test(`CMS cannot independently assign or clear a new child's Faith topic (${JSON.stringify(topic)})`, async context => {
    const state = setup(context, [article(1)]);
    const response = await state.post({ ...draftPayload, sourceArticleId: id(1), topic });
    assert.equal(response.status, 409);
    assert.match(response.body.message, /source article/);
    assert.equal(state.creates.length, 0);
  });
}

test('CMS Faith children require a canonical Faith source rather than an unrelated record', async context => {
  const state = setup(context, [article(1, 'en', { category: 'national' }), article(2, 'hi')]);
  for (const sourceArticleId of [id(1), id(2), id(99)]) {
    assert.equal((await state.post({ ...draftPayload, sourceArticleId })).status, 409);
  }
  assert.equal(state.creates.length, 0);
});

for (const topic of ['unsupported', 'living heritage', 'living_heritage', 'null', 'undefined', 42, true, [], ['living-heritage'], {}]) {
  test(`CMS rejects unsupported Faith topic ${JSON.stringify(topic)} on create and update`, async context => {
    const state = setup(context);
    for (const response of [await state.post({ ...draftPayload, topic }), await state.put({ topic })]) {
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { ok: false, success: false, message: 'Invalid Faith & Culture topic' });
    }
    assert.equal(state.creates.length, 0);
    assert.equal(state.writes.length, 0);
  });
}

for (const base of locales) {
  test(`Faith topic-only edit synchronizes all News siblings from a ${base} source without content generation`, async context => {
    const records = [article(1, base, { sourceLanguage: base }), ...locales.filter(lang => lang !== base).map((lang, index) => article(index + 2, lang, { sourceLanguage: base }))];
    const state = setup(context, records);
    const snapshots = records.map(withoutSyncMetadata);
    const previousFingerprint = computeContentFingerprint(state.docs.get(id(1)));
    const result = success(await state.put({ topic: ' FOOD-AGRICULTURAL-HERITAGE ' }));
    assert.equal(result.topic, 'food-agricultural-heritage');
    assert.notEqual(result.contentFingerprint, previousFingerprint);
    for (const [index, doc] of [...state.docs.values()].entries()) {
      assert.equal(doc.topic, result.topic);
      assert.ok(doc.syncVersion >= result.syncVersion);
      assert.ok(doc.syncVersion > records[index].syncVersion);
      assert.equal(doc.contentFingerprint, result.contentFingerprint);
      assert.deepEqual(withoutSyncMetadata(doc), snapshots[index]);
    }
    assert.deepEqual(state.saves, []);
    assert.deepEqual(state.generated, []);
    assert.deepEqual(state.outdated, []);
    assertDerivedTranslations(state);
    assert.equal(state.cacheInvalidations, 1);
    assert.equal(state.invalidations.length, 1);
    assert.ok(state.invalidations[0].tags.includes('category:faith-culture'));
    const topicWrites = state.writes.filter(write => write.method === 'updateOne' && Object.hasOwn(write.update.$set || {}, 'topic'));
    assert.equal(topicWrites.length, 2);
    for (const write of topicWrites) {
      assert.deepEqual(Object.keys(write.update.$set).sort(), ['contentFingerprint', 'lastSyncedAt', 'syncVersion', 'topic']);
      assert.equal(write.options.runValidators, true);
    }
  });
}

test('Faith can set a topic on an existing untagged source', async context => {
  const state = setup(context, [article(1, 'en', { topic: undefined }), article(2, 'hi', { topic: undefined })]);
  success(await state.put({ topic: 'faith-spiritual-life' }));
  assert.ok([...state.docs.values()].every(doc => doc.topic === 'faith-spiritual-life'));
});

for (const topic of [null, '', ' \r\n\t ']) {
  test(`Explicit Faith clear ${JSON.stringify(topic)} propagates without changing sibling content`, async context => {
    const state = setup(context);
    const before = [...state.docs.values()].map(withoutSyncMetadata);
    assert.equal(success(await state.put({ topic })).topic, null);
    assert.ok([...state.docs.values()].every(doc => doc.topic === null));
    assert.deepEqual([...state.docs.values()].map(withoutSyncMetadata), before);
    assertDerivedTranslations(state);
    assert.deepEqual(state.generated, []);
    assert.deepEqual(state.outdated, []);
    assert.deepEqual(state.saves, []);
  });
}

test('Omitting Faith topic preserves it through an ordinary content edit and sibling synchronization', async context => {
  const state = setup(context);
  success(await state.put({ title: 'Edited Faith title' }));
  assert.ok([...state.docs.values()].every(doc => doc.topic === 'living-heritage'));
  assert.equal(state.generated.length, 1, 'a genuine source content edit retains translation generation');
  assert.equal(state.outdated.length, 1);
});

test('A full form with unchanged text, language, tags, category and status is still a topic-only change', async context => {
  const state = setup(context);
  const source = state.docs.get(id(1));
  const before = [...state.docs.values()].map(withoutSyncMetadata);
  const payload = Object.fromEntries(['title', 'description', 'content', 'language', 'tags', 'category', 'status'].map(field => [field, clone(source[field])]));
  success(await state.put({ ...payload, topic: 'architecture-art-public-heritage' }));
  assert.deepEqual([...state.docs.values()].map(withoutSyncMetadata), before);
  assert.deepEqual(state.generated, []);
  assert.deepEqual(state.outdated, []);
  assert.deepEqual(state.saves, []);
  assertDerivedTranslations(state);
});

test('A topic-only update does not apply automatic language or slug repairs to a legacy source', async context => {
  const state = setup(context, [article(1, 'en', { title: text.gu, content: text.gu.repeat(20) })]);
  const before = withoutSyncMetadata(state.docs.get(id(1)));
  success(await state.put({ topic: 'language-cultural-identity' }));
  assert.deepEqual(withoutSyncMetadata(state.docs.get(id(1))), before);
  assert.deepEqual(state.generated, []);
});

test('A topic-only update does not introduce source identity or language metadata on legacy records', async context => {
  const state = setup(context, [article(1, 'gu', { sourceArticleId: undefined, sourceLanguage: undefined })]);
  const before = withoutSyncMetadata(state.docs.get(id(1)));
  success(await state.put({ topic: 'language-cultural-identity' }));
  assert.deepEqual(withoutSyncMetadata(state.docs.get(id(1))), before);
  assert.deepEqual(Object.keys(state.writes[0].update.$set).sort(), ['contentFingerprint', 'lastSyncedAt', 'syncVersion', 'topic']);
});

test('A real content edit with a topic change retains existing translation processing', async context => {
  const state = setup(context);
  success(await state.put({ topic: 'community-social-traditions', content: 'Actually revised source body' }));
  assert.equal(state.generated.length, 1);
  assert.equal(state.outdated.length, 1);
  assert.ok([...state.docs.values()].every(doc => doc.topic === 'community-social-traditions'));
});

test('A topic change with an unpublish keeps the existing metadata-only lifecycle update path', async context => {
  const state = setup(context);
  const result = success(await state.put({ topic: 'faith-spiritual-life', status: 'draft' }));
  assert.equal(result.status, 'draft');
  assert.ok([...state.docs.values()].every(doc => doc.topic === 'faith-spiritual-life' && doc.status === 'draft'));
  assert.deepEqual(state.saves, []);
  assert.deepEqual(state.generated, []);
});

for (const topic of ['food-agricultural-heritage', null, '']) {
  test(`Translated children reject Faith topic edits (${JSON.stringify(topic)}) with 409`, async context => {
    const state = setup(context);
    const response = await state.put({ topic }, id(2));
    assert.equal(response.status, 409);
    assert.match(response.body.message, /source article/);
    assert.equal(state.writes.length, 0);
  });
}

test('An unchanged topic resubmitted on a child does not block its ordinary text editing', async context => {
  const state = setup(context);
  const result = success(await state.put({ topic: 'living-heritage', content: 'Reviewed child translation' }, id(2)));
  assert.equal(result.topic, 'living-heritage');
  assert.equal(result.content, 'Reviewed child translation');
  assert.deepEqual(state.generated, [id(2)], 'real child text edits retain their existing translation processing');
  assert.equal(result.translationReviewStatus, 'reviewed');
});

for (const category of ['national', 'regional', 'editorial', 'pulse-dialogue', 'youth-pulse', 'community-reporter']) {
  test(`Leaving Faith clears its topic without imposing topic policy on ${category}`, async context => {
    const state = setup(context);
    success(await state.put({ category }));
    for (const doc of state.docs.values()) {
      assert.equal(doc.category, category);
      assert.equal(doc.topic, null);
    }
  });
}

test('Entering Faith does not retain a foreign Youth topic when the optional topic is omitted', async context => {
  const state = setup(context, [article(1, 'en', { category: 'youth-pulse', topic: 'campus-buzz', track: 'campus-buzz' })]);
  const result = success(await state.put({ category: 'faith-culture' }));
  assert.equal(result.topic, null);
  assert.equal(result.track, 'campus-buzz', 'other category metadata policies are not redefined');
});

for (const category of ['national', 'regional', 'editorial', 'pulse-dialogue', 'youth-pulse', 'community-reporter']) {
  test(`Ordinary ${category} authoring keeps its previous topic/track behavior`, async context => {
    const state = setup(context, [article(1, 'en', { category, topic: 'campus-buzz', track: 'campus-buzz', status: 'draft' })]);
    const created = success(await state.post({ ...draftPayload, category, topic: 'not-a-faith-code', track: 'campus-buzz' }), 201);
    assert.equal(created.topic, undefined, 'main CMS continues ignoring supplied topic outside Faith');
    assert.equal(created.track, 'campus-buzz');
    const updated = success(await state.put({ topic: { not: 'a Faith validation input' } }));
    assert.equal(updated.topic, 'campus-buzz');
    assert.equal(updated.track, 'campus-buzz');
    const before = article(10, 'en', { category, topic: 'campus-buzz' });
    assert.equal(computeContentFingerprint(before), computeContentFingerprint({ ...before, topic: 'another-topic' }));
    assert.equal(Object.prototype.hasOwnProperty.call(buildChildNewsSyncPatch(before, before), 'topic'), false);
  });
}

test('Faith fingerprint detects topic changes and clears without changing the translation source-text hash', () => {
  const before = article(1);
  const changed = { ...before, topic: 'folk-arts-festivals-textiles' };
  const cleared = { ...before, topic: null };
  assert.equal(new Set([before, changed, cleared].map(computeContentFingerprint)).size, 3);
  assert.equal(new Set([before, changed, cleared].map(sourceHashForDoc)).size, 1);
  assert.equal(computeContentFingerprint(cleared), computeContentFingerprint({ ...before, topic: undefined }));
  assert.deepEqual(buildFaithTopicPatch({ category: 'faith-culture', existingCategory: 'faith-culture', topicProvided: false }), { ok: true, value: undefined });
});

for (const lang of locales) {
  for (const topic of ['living-heritage', null]) {
    test(`New translation siblings inherit ${JSON.stringify(topic)} from a ${lang} Faith source`, async context => {
      const state = setup(context, [article(1, lang, { topic, sourceLanguage: lang, status: 'draft' })]);
      const generation = loadWithFixtures(require.resolve('../services/articleTranslationGeneration.service'), {
        './googleTranslationService': {
          ...require('../services/googleTranslationService'),
          translateText: async (value, sourceLang, targetLang) => ({ ok: true, text: `${targetLang} fixture translation` }),
        },
        '../lib/cache': { invalidateArticleLanguageCaches: async () => {}, invalidateArticleCaches: async () => {} },
      });
      const result = await generation.generateArticleTranslations(state.docs.get(id(1)), { targetLanguages: locales });
      assert.equal(result.ok, true);
      assert.equal(state.creates.length, 2);
      assert.deepEqual(state.creates.map(doc => doc.lang).sort(), locales.filter(locale => locale !== lang).sort());
      for (const child of state.creates) {
        assert.equal(child.topic, topic);
        assert.equal(child.sourceArticleId, id(1));
        assert.equal(child.category, 'faith-culture');
        assert.equal(child.status, 'draft');
      }
    });
  }
}

test('Topic synchronization skips unrelated sources, unsupported locales and other categories', async context => {
  const skipped = [
    article(4, 'hi', { sourceArticleId: id(90) }),
    article(5, 'gu', { sourceArticleId: id(5) }),
    article(6, 'fr'),
    article(7, 'hi', { category: 'youth-pulse', topic: 'campus-buzz' }),
    article(8, 'gu', { translationGroupId: 'another-group', translationKey: 'another-group' }),
  ];
  const state = setup(context, [article(1), article(2, 'hi'), article(3, 'gu', { sourceArticleId: undefined }), ...skipped]);
  success(await state.put({ topic: 'language-cultural-identity' }));
  for (const doc of skipped) {
    const updated = state.docs.get(doc._id);
    assert.deepEqual(withoutSyncMetadata(updated), withoutSyncMetadata(doc));
    assert.equal(updated.topic, doc.topic);
    assert.deepEqual(updated.translations, doc.translations);
    assert.deepEqual(updated.translationStatus, doc.translationStatus);
  }
  assert.equal(state.docs.get(id(2)).topic, 'language-cultural-identity');
  assert.equal(state.docs.get(id(3)).topic, 'language-cultural-identity');
});

test('Topic synchronization recognizes existing EN/HI/GU language aliases without rewriting them', async context => {
  const children = [
    article(2, 'hi', { lang: 'Hindi', language: 'Hindi', originalLang: 'Hindi' }),
    article(3, 'gu', { lang: 'Gujarati', language: 'Gujarati', originalLang: 'Gujarati' }),
  ];
  const state = setup(context, [article(1), ...children]);
  success(await state.put({ topic: 'faith-spiritual-life' }));
  for (const child of children) {
    const updated = state.docs.get(child._id);
    assert.equal(updated.topic, 'faith-spiritual-life');
    assert.deepEqual(withoutSyncMetadata(updated), withoutSyncMetadata(child));
  }
});

for (const topic of ['faith-spiritual-life', null]) {
  test(`A sibling error rolls back the group and retrying ${JSON.stringify(topic)} commits sibling metadata`, async context => {
    const state = setup(context);
    const before = clone(state.rows);
    state.siblingFailure = true;
    const response = await state.put({ topic });
    assert.equal(response.status, 503);
    assert.match(response.body.message, /synchronization failed/);
    assert.doesNotMatch(JSON.stringify(response.body), /internal database/);
    assert.ok(state.errors.length);
    assert.equal(state.cacheInvalidations, 0);
    assert.deepEqual(state.invalidations, []);
    assert.deepEqual(clone(state.rows), before);
    assert.ok(state.transactions[0].aborted && state.transactions[0].ended && !state.transactions[0].committed);
    state.siblingFailure = false;
    success(await state.put({ topic }));
    assert.ok([...state.docs.values()].every(doc => doc.topic === topic));
    assert.deepEqual(state.generated, []);
    assert.equal(state.cacheInvalidations, 1);
    assert.equal(state.invalidations.length, 1);
    assert.ok(state.transactions[1].committed && state.transactions[1].ended);
  });
}

test('A source/category race returns 409 without changing source or sibling metadata', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  state.rows.News.forEach(doc => { doc.topic = 'living-heritage'; doc.syncVersion = 4; });
  const before = JSON.stringify(state.rows);
  const update = context.mock.method(News, 'findOneAndUpdate', async () => null);
  const response = await state.request('put', `/api/articles/${ids[0]}`, { topic: 'faith-spiritual-life' });
  assert.equal(response.status, 409);
  assert.equal(JSON.stringify(state.rows), before);
  assert.equal(update.mock.calls[0].arguments[0].syncVersion, 4);
  assert.equal(state.invalidations.length, 0);
});

test('A zero-match sibling update cannot be reported as successful synchronization', async context => {
  const state = setup(context);
  const before = clone(state.rows);
  state.siblingRace = true;
  assert.equal((await state.put({ topic: null })).status, 503);
  assert.equal(state.writes.find(write => write.method === 'updateOne').filter.syncVersion, 5);
  assert.deepEqual(clone(state.rows), before);
  assert.deepEqual(state.invalidations, []);
  assert.equal(state.cacheInvalidations, 0);
  assert.ok(state.transactions[0].aborted && state.transactions[0].ended);
});

test('An older topic synchronization cannot overwrite a sibling with a newer source version', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  state.rows.News.forEach(doc => { doc.topic = 'living-heritage'; doc.syncVersion = 4; });
  state.rows.News[1].syncVersion = 6;
  const before = JSON.stringify(state.rows);
  const response = await state.request('put', `/api/articles/${ids[0]}`, { topic: null });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(state.rows), before);
  assert.equal(state.invalidations.length, 0);
});

test('Faith topic changes submitted while publishing reach existing siblings without regenerating their content', async context => {
  const state = setup(context, [article(1, 'en', { status: 'draft' }), article(2, 'hi'), article(3, 'gu')]);
  const before = clone(state.docs.get(id(2)));
  const result = success(await state.put({ status: 'published', topic: 'faith-spiritual-life' }));
  assert.equal(result.status, 'published');
  assert.ok([...state.docs.values()].every(doc => doc.topic === 'faith-spiritual-life'));
  const child = state.docs.get(id(2));
  for (const field of [
    '_id', 'slug', 'language', 'lang', 'originalLang', 'sourceArticleId', 'publishedAt',
    'title', 'description', 'content', 'humanEdited', 'translationReviewStatus', 'translationMeta',
  ]) assert.deepEqual(child[field], before[field], field);
  assert.deepEqual(state.generated, []);
  assert.ok(state.rows.News.every(doc => doc.status === 'published' && doc.workflowStage === 'PUBLISHED'));
  assertDerivedTranslations(state);
});

test('A Faith category switch submitted while publishing clears existing Faith sibling taxonomy', async context => {
  const state = setup(context, [article(1, 'en', { status: 'draft' }), article(2, 'hi'), article(3, 'gu')]);
  success(await state.put({ category: 'national', status: 'published' }));
  assert.ok([...state.docs.values()].every(doc => doc.topic === null));
});

test('Public-copy CMS IDs resolve topic edits to canonical News without adding public-copy fields', async context => {
  const state = setup(context);
  state.rows.Article.push({ _id: id(90), category: 'faith-culture', sourceNewsId: id(1) });
  success(await state.put({ topic: 'living-heritage' }, id(90)));
  assert.equal(state.docs.get(id(1)).topic, 'living-heritage');
  assert.ok(state.publicSync.includes(id(1)));
  assert.equal(state.publicSync.includes(id(90)), false);
  assert.equal(PublicArticle.schema.path('topic'), undefined);
  state.rows.Article.push({ _id: id(91), category: 'faith-culture' });
  assert.equal((await state.put({ topic: null }, id(91))).status, 409);
});

test('Faith topic authoring retains authentication and Founder publishing protection', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  state.rows.News.forEach(doc => { doc.topic = 'living-heritage'; });
  const before = clone(state.rows);

  assert.equal((await state.request('post', '/api/articles', { ...draftPayload, topic: 'living-heritage' }, null)).status, 401);
  assert.equal((await state.request('put', `/api/articles/${ids[0]}`, { topic: null }, null)).status, 401);
  assert.equal(state.transactions.length, 0);

  for (const [method, url, body] of [
    ['post', '/api/articles', { ...draftPayload, topic: 'living-heritage', status: 'published' }],
    ['put', `/api/articles/${ids[0]}`, { topic: 'living-heritage', status: 'published' }],
  ]) {
    const response = await state.request(method, url, body, 'editor');
    assert.equal(response.status, 403, response.text);
    assert.match(response.body.message, /effective Founder-granted Publish News right/);
    if (method === 'put') assert.equal(response.body.code, 'ARTICLE_PUBLISH_FORBIDDEN');
  }

  for (const [model, rows] of Object.entries(state.rows)) {
    if (model !== 'AuditLog') assert.deepEqual(clone(rows), before[model], model);
  }
  const writes = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
  assert.deepEqual(state.calls.filter(call => call.name !== 'AuditLog' && writes.has(call.method)), []);
  assert.deepEqual(state.invalidations, []);
  assert.equal(state.transactions.length, 2);
  assert.ok(state.transactions.every(session => session.aborted && session.ended && !session.committed));
});
