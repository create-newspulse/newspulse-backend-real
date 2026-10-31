require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');
const mongoose = require('mongoose');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

function installPublicationRouteFixture(context) {
  const state = installEditorialFixture(context);
  context.mock.method(require('../models/PublicSiteSettings'), 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  const fetch = global.fetch;
  context.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1/')) return fetch(url, options);
    const body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ data: {
      translations: body.q.map(value => ({ translatedText: `${body.target}:${value}` })),
    } }) };
  });
  return state;
}

function makeDoc(overrides = {}) {
  const doc = {
    _id: overrides._id || '507f1f77bcf86cd799439901',
    title: 'English title',
    description: 'English summary',
    content: '<p>English body</p>',
    slug: 'english-title',
    slugs: { en: 'english-title' },
    category: 'national',
    status: 'draft',
    scheduledAt: overrides.status === 'scheduled' ? new Date('2020-01-01T00:00:00.000Z') : null,
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    translationGroupId: 'grp-publish-pipeline',
    translationKey: 'grp-publish-pipeline',
    workflowStage: 'DRAFT',
    workflowHistory: [],
    saveCount: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saveCount += 1;
    return doc;
  };
  doc.toObject = () => ({ ...doc });
  doc.toJSON = () => ({ ...doc });
  return doc;
}

function makeLanguageDoc(lang, overrides = {}) {
  const labels = {
    en: ['English title', 'English summary', '<p>English body</p>', 'english-title'],
    hi: ['हिंदी शीर्षक', 'हिंदी सारांश', '<p>हिंदी सामग्री</p>', 'hindi-title'],
    gu: ['ગુજરાતી શીર્ષક', 'ગુજરાતી સારાંશ', '<p>ગુજરાતી લેખ</p>', 'gujarati-title'],
  };
  const [title, description, content, slug] = labels[lang];
  return makeDoc({
    _id: `507f1f77bcf86cd7994399${lang === 'en' ? '01' : lang === 'hi' ? '02' : '03'}`,
    title,
    description,
    content,
    slug,
    slugs: { [lang]: slug },
    language: lang,
    lang,
    originalLang: lang,
    sourceArticleId: lang === 'en' ? undefined : '507f1f77bcf86cd799439901',
    ...overrides,
  });
}

function queryDoc(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
    then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
    catch(reject) { return Promise.resolve(doc).catch(reject); },
  };
}

function restore(originals) {
  for (const item of originals) {
    for (const [key, value] of Object.entries(item.values)) item.target[key] = value;
  }
}

function installPublishMocks(t, docs, options = {}) {
  t.mock.method(mongoose, 'startSession', async () => ({
    async withTransaction(work) {
      const before = docs.map(doc => ({
        doc, data: structuredClone(Object.fromEntries(Object.entries(doc).filter(([, value]) => typeof value !== 'function'))),
      }));
      try { return await work(); }
      catch (error) {
        docs.splice(0, docs.length, ...before.map(item => item.doc));
        for (const { doc, data } of before) {
          for (const [key, value] of Object.entries(doc)) if (typeof value !== 'function') delete doc[key];
          Object.assign(doc, data);
        }
        throw error;
      }
    },
    endSession: async () => {},
  }));
  t.mock.method(News, 'updateMany', async () => ({ acknowledged: true, matchedCount: docs.length, modifiedCount: docs.length }));
  const originals = [
    {
      target: News,
      values: {
      findById: News.findById,
      find: News.find,
      findOne: News.findOne,
      create: News.create,
      updateOne: News.updateOne,
      },
    },
    {
      target: PublicArticle,
      values: {
      findOneAndUpdate: PublicArticle.findOneAndUpdate,
      updateMany: PublicArticle.updateMany,
      },
    },
    {
      target: PushHistory,
      values: {
      create: PushHistory.create,
      },
    },
  ];
  const prevFetch = global.fetch;
  const created = [];
  const pushHistory = [];
  const publicCopies = [];
  let fetchCalls = 0;

  News.findById = (id) => queryDoc(docs.find((doc) => String(doc._id) === String(id)) || null);
  News.find = (query) => {
    const raw = JSON.stringify(query || {});
    const groupMatch = raw.match(/grp-[a-z0-9-]+/i);
    const groupKey = groupMatch ? groupMatch[0] : null;
    const excludedId = query && query._id && query._id.$ne ? String(query._id.$ne) : null;
    return queryDoc(docs.filter((doc) => {
      if (excludedId && String(doc._id) === excludedId) return false;
      if (groupKey && doc.translationGroupId !== groupKey && doc.translationKey !== groupKey) return false;
      return true;
    }));
  };
  News.findOne = (query) => {
    const raw = JSON.stringify(query || {});
    const lang = ['en', 'hi', 'gu'].find((candidate) => raw.includes(`"language":"${candidate}"`) || raw.includes(`"lang":"${candidate}"`));
    const existing = lang ? docs.find((doc) => doc.language === lang || doc.lang === lang) : null;
    return queryDoc(existing || null);
  };
  News.updateOne = async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
  const createDoc = (payload) => {
    const ids = [
      '507f1f77bcf86cd799439911',
      '507f1f77bcf86cd799439912',
      '507f1f77bcf86cd799439913',
      '507f1f77bcf86cd799439914',
    ];
    const doc = makeDoc({
      _id: payload._id || ids[docs.length] || '507f1f77bcf86cd799439999',
      ...payload,
      workflowHistory: Array.isArray(payload.workflowHistory) ? payload.workflowHistory : [],
    });
    docs.push(doc);
    created.push(doc);
    return doc;
  };
  News.create = async (payload) => Array.isArray(payload) ? payload.map(createDoc) : createDoc(payload);

  PublicArticle.findOneAndUpdate = (_filter, update) => {
    publicCopies.push(update.$set);
    return { lean: async () => ({ _id: 'public-sync' }) };
  };
  PublicArticle.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
  PushHistory.create = async (payload) => {
    pushHistory.push(payload);
    return { _id: `push-${pushHistory.length}` };
  };
  global.fetch = async (_url, opts) => {
    fetchCalls += 1;
    if (options.failFetch) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'translation failed' } }) };
    }
    const body = JSON.parse(String(opts?.body || '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((value) => ({ translatedText: `${body.target}:${value}` })) } }),
    };
  };

  t.after(() => {
    restore(originals);
    global.fetch = prevFetch;
  });

  return { created, pushHistory, publicCopies, getFetchCalls: () => fetchCalls };
}

async function publishForTest(t, docs, options = {}) {
  const state = installPublishMocks(t, docs, options);
  const result = await publishCanonicalArticle(docs[0]._id, {
    actor: { byRole: 'Founder', byUserId: null },
    reason: 'test publish',
    source: 'test',
    groupPublish: options.groupPublish,
  });
  return { result, ...state };
}

for (const translationMode of ['existing', 'generated', 'cached']) {
  test(`author publication snapshot is shared and frozen across ${translationMode} EN HI GU translations`, async (context) => {
    const source = makeLanguageDoc('en', {
      authorByline: { enabled: true, snapshot: { name: 'Independent Author', publicDesignation: 'Writer', photoUrl: '/uploads/author.jpg', shortBio: 'Public bio' } },
    });
    const docs = translationMode === 'existing' ? [source, makeLanguageDoc('hi'), makeLanguageDoc('gu')] : [source];
    if (translationMode === 'cached') {
      source.translations = Object.fromEntries(['hi', 'gu'].map((lang) => [lang, {
        title: `${lang} title`, summary: `${lang} summary`, content: `<p>${lang} content</p>`, provider: 'manual',
      }]));
    }
    context.mock.method(require('../models/User'), 'findOne', () => { throw new Error('Publication must not query Users'); });
    const state = await publishForTest(context, docs);
    const snapshot = structuredClone(source.authorByline);
    assert.equal(snapshot.snapshot.name, 'Independent Author');
    assert.ok(snapshot.snapshotCapturedAt);
    assert.deepEqual(state.result.publishedLanguages.sort(), ['en', 'gu', 'hi']);
    for (const doc of docs) assert.deepEqual(doc.authorByline, snapshot);
    assert.equal(state.publicCopies.length, 3);
    for (const copy of state.publicCopies) assert.deepEqual(copy.authorByline, snapshot);
    await publishCanonicalArticle(source, { logger: { warn() {} } });
    for (const doc of docs) assert.deepEqual(doc.authorByline, snapshot);
  });
}

test('author byline survives draft creation, edit, preview, scheduling and scheduled publication', async (context) => {
  const state = installPublicationRouteFixture(context);
  context.mock.method(require('../models/User'), 'findOne', () => { throw new Error('Author workflow must not query Users'); });
  const token = state.token('founder');
  const created = await request(app).post('/api/admin/articles').set('Authorization', `Bearer ${token}`).send({
    title: 'Author draft', summary: 'Author summary', content: '<p>Author body</p>', category: 'national', language: 'en', status: 'draft',
    authorByline: { enabled: true, snapshot: { name: 'Independent Author', photoUrl: '/uploads/author.jpg' } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  let doc = state.rows.News[0];
  const byline = structuredClone(doc.authorByline);
  const edited = await request(app).put(`/api/admin/articles/${doc._id}`).set('Authorization', `Bearer ${token}`).send({ summary: 'Edited summary' });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  doc = state.rows.News.find(row => row._id === doc._id);
  assert.deepEqual(doc.authorByline, byline);
  const preview = await request(app).get(`/api/articles/${doc._id}`).set('Authorization', `Bearer ${token}`);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.article.authorByline, byline);
  const publicPreview = await request(app).get(`/api/articles/${doc._id}`);
  assert.equal(publicPreview.status, 404);
  const scheduled = await request(app).post(`/api/articles/${doc._id}/schedule`).set('Authorization', `Bearer ${token}`).send({ scheduledAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  doc = state.rows.News.find(row => row._id === doc._id);
  assert.equal(doc.status, 'scheduled');
  assert.deepEqual(doc.authorByline, byline);
  const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
  const result = await publishDueScheduledArticles({
    allowDisconnected: true,
    News, PushHistory,
    now: new Date('2030-01-01T00:00:00.000Z'),
  });
  assert.equal(result.published, 1);
  doc = state.rows.News.find(row => row._id === doc._id);
  assert.equal(doc.status, 'published');
  assert.ok(doc.authorByline.snapshotCapturedAt);
  assert.deepEqual(doc.authorByline.snapshot, byline.snapshot);
  const frozen = structuredClone(doc.authorByline);
  const managed = await request(app).put(`/api/admin/articles/${doc._id}`).set('Authorization', `Bearer ${token}`).send({ summary: 'Managed summary' });
  assert.equal(managed.status, 200, JSON.stringify(managed.body));
  doc = state.rows.News.find(row => row._id === doc._id);
  assert.deepEqual(doc.authorByline, frozen);
  let child = state.rows.News.find(row => row.language === 'hi');
  assert.ok(child, 'scheduled publication must persist the generated Hindi edition');
  const invalidEdit = await request(app).put(`/api/admin/articles/${doc._id}`).set('Authorization', `Bearer ${token}`).send({ authorByline: { snapshot: { name: ' ' } } });
  assert.equal(invalidEdit.status, 400);
  doc = state.rows.News.find(row => row._id === doc._id);
  assert.deepEqual(doc.authorByline, frozen);
  const conflictingName = await request(app).put(`/api/admin/articles/${child._id}`).set('Authorization', `Bearer ${token}`).send({ authorByline: { snapshot: { name: 'Different child author' } } });
  assert.equal(conflictingName.status, 409);
  const conflicting = await request(app).put(`/api/admin/articles/${child._id}`).set('Authorization', `Bearer ${token}`).send({ authorByline: { enabled: false } });
  assert.equal(conflicting.status, 409);
  child = state.rows.News.find(row => row._id === child._id);
  assert.deepEqual(child.authorByline, frozen);
  const publicId = state.rows.Article.find(copy => copy.sourceNewsId === doc._id)._id;
  const replacement = { name: 'Shailesh Rathod', publicDesignation: 'Independent Writer', shortBio: 'Updated biography' };
  const explicitEdit = await request(app).put(`/api/admin/articles/${publicId}`).set('Authorization', `Bearer ${token}`).send({ authorByline: { snapshot: replacement, snapshotCapturedAt: '2000-01-01' } });
  assert.equal(explicitEdit.status, 200, JSON.stringify(explicitEdit.body));
  doc = state.rows.News.find(row => row._id === doc._id);
  child = state.rows.News.find(row => row._id === child._id);
  assert.deepEqual(doc.authorByline.snapshot, replacement);
  assert.equal(child.authorByline.enabled, true);
  assert.deepEqual(child.authorByline.snapshot, replacement);
  assert.equal(new Date(child.authorByline.snapshotCapturedAt).getTime(), new Date(doc.authorByline.snapshotCapturedAt).getTime());
  assert.notEqual(new Date(doc.authorByline.snapshotCapturedAt).getUTCFullYear(), 2000);
  const fromPublicId = await request(app).put(`/api/admin/articles/${publicId}`).set('Authorization', `Bearer ${token}`).send({ authorByline: { enabled: false } });
  assert.equal(fromPublicId.status, 200, JSON.stringify(fromPublicId.body));
  doc = state.rows.News.find(row => row._id === doc._id);
  child = state.rows.News.find(row => row._id === child._id);
  assert.deepEqual(doc.authorByline, { enabled: false });
  assert.deepEqual(child.authorByline, { enabled: false });
});

test('invalid author snapshot leaves publication drafts and snapshots unchanged', async (context) => {
  const byline = { enabled: true, snapshot: { name: ' ' } };
  const docs = [makeLanguageDoc('en', { authorByline: structuredClone(byline) }), makeLanguageDoc('hi'), makeLanguageDoc('gu')];
  installPublishMocks(context, docs);
  await assert.rejects(publishCanonicalArticle(docs[0]), /name is required/);
  for (const doc of docs) assert.equal(doc.status, 'draft');
  assert.deepEqual(docs[0].authorByline, byline);
});

test('scheduled child publishes the full group with one frozen snapshot across scheduler batches', async (context) => {
  const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
  const byline = { enabled: true, snapshot: { name: 'Preview name', shortBio: 'Public bio' } };
  const source = makeLanguageDoc('en', { status: 'scheduled', authorByline: structuredClone(byline) });
  const docs = [source, ...['hi', 'gu'].map(lang => makeLanguageDoc(lang, { status: 'scheduled', authorByline: structuredClone(byline) }))];
  installPublishMocks(context, docs);
  context.mock.method(require('../models/User'), 'findOne', () => { throw new Error('Scheduled publication must not query Users'); });
  for (const [index, child] of docs.slice(1).entries()) {
    const result = await publishDueScheduledArticles({
      allowDisconnected: true,
      News: {
        find: () => ({ limit: () => child.status === 'scheduled' ? [child] : [] }),
      },
      PushHistory: { create: async () => ({}) },
    });
    assert.equal(result.published, index === 0 ? 1 : 0);
  }
  assert.equal(source.authorByline.snapshot.name, 'Preview name');
  assert.ok(source.authorByline.snapshotCapturedAt);
  for (const doc of docs) {
    assert.equal(doc.status, 'published');
    assert.deepEqual(doc.authorByline, source.authorByline);
  }
});

test('a failed scheduled article save does not persist a source publication snapshot', async (context) => {
  const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
  const byline = { enabled: true, snapshot: { name: 'Preview name' } };
  const source = makeLanguageDoc('en', { status: 'scheduled', authorByline: structuredClone(byline) });
  const child = makeLanguageDoc('hi', { status: 'scheduled', authorByline: structuredClone(byline) });
  installPublishMocks(context, [source, child, makeLanguageDoc('gu', { status: 'scheduled' })]);
  child.save = async () => { throw new Error('Simulated persistence failure'); };
  let sourceWrites = 0;
  const result = await publishDueScheduledArticles({
    allowDisconnected: true,
    logger: { warn() {} },
    News: {
      find: () => ({ limit: () => [child] }),
      findById: async () => source,
      updateOne: async () => { sourceWrites += 1; },
    },
    PushHistory: { create: async () => ({}) },
  });
  assert.equal(result.failed, 1);
  assert.equal(result.published, 0);
  assert.equal(sourceWrites, 0);
  assert.deepEqual(source.authorByline, byline);
});

test('canonical publish publishes a draft with all EN HI GU translations', async (t) => {
  let refreshScheduled = false;
  t.after(require('../lib/cache').onArticleCachesInvalidated((event) => {
    assert.equal(event.publicVisibilityRemoved, true);
    refreshScheduled = true;
    return new Promise(() => {});
  }));
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('hi'), makeLanguageDoc('gu')];
  const { result, created } = await publishForTest(t, docs, { groupPublish: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ok, true);
  assert.equal(refreshScheduled, true);
  assert.deepEqual(result.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.equal(created.length, 0);
  for (const doc of docs) {
    assert.equal(doc.status, 'published');
    assert.equal(doc.workflowStage, 'PUBLISHED');
    assert.ok(doc.publishedAt instanceof Date);
  }
});

test('canonical publish generates missing Hindi translation before publishing', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('gu')];
  const { result, created } = await publishForTest(t, docs);

  assert.equal(result.ok, true);
  assert.deepEqual(created.map((doc) => doc.language), ['hi']);
  assert.deepEqual(docs.map((doc) => doc.status), ['published', 'published', 'published']);
});

test('canonical publish generates missing Gujarati translation before publishing', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('hi')];
  const { result, created } = await publishForTest(t, docs);

  assert.equal(result.ok, true);
  assert.deepEqual(created.map((doc) => doc.language), ['gu']);
  assert.deepEqual(docs.map((doc) => doc.status), ['published', 'published', 'published']);
});

test('canonical publish generates both missing translations before publishing', async (t) => {
  const docs = [makeLanguageDoc('en')];
  const { result, created } = await publishForTest(t, docs);

  assert.equal(result.ok, true);
  assert.deepEqual(created.map((doc) => doc.language).sort(), ['gu', 'hi']);
  assert.deepEqual(docs.map((doc) => doc.status), ['published', 'published', 'published']);
});

test('canonical publish reuses existing cached translations and retry does not duplicate them', async (t) => {
  const docs = [makeLanguageDoc('en', {
    translations: {
      hi: { title: 'कैश हिंदी', summary: 'कैश सारांश', content: '<p>कैश</p>', provider: 'manual', generatedAt: new Date() },
      gu: { title: 'કેશ ગુજરાતી', summary: 'કેશ સારાંશ', content: '<p>કેશ</p>', provider: 'manual', generatedAt: new Date() },
    },
  })];
  const state = installPublishMocks(t, docs);

  await publishCanonicalArticle(docs[0]._id, { actor: { byRole: 'Founder', byUserId: null }, source: 'first' });
  await publishCanonicalArticle(docs[0]._id, { actor: { byRole: 'Founder', byUserId: null }, source: 'retry' });

  assert.equal(state.getFetchCalls(), 0);
  assert.deepEqual(state.created.map((doc) => doc.language).sort(), ['gu', 'hi']);
  assert.equal(docs.filter((doc) => doc.language === 'hi').length, 1);
  assert.equal(docs.filter((doc) => doc.language === 'gu').length, 1);
  assert.equal(state.pushHistory.length, 1);
});

for (const mode of ['throw', 'null']) {
  test(`canonical publication rejects ${mode} public sync failure and preserves previous News visibility`, async (t) => {
    const publishedAt = new Date('2026-01-02T00:00:00.000Z');
    const docs = ['en', 'hi', 'gu'].map((lang) => makeLanguageDoc(lang, { status: 'published', publishedAt, views: 17 }));
    const ids = docs.map((doc) => doc._id);
    const state = installPublishMocks(t, docs);
    const warnings = [];
    PublicArticle.findOneAndUpdate = () => ({
      lean: async () => {
        if (mode === 'throw') throw new Error('private-sync-error-must-not-leak');
        return null;
      },
    });
    await assert.rejects(
      publishCanonicalArticle(docs[0], { logger: { warn: (...args) => warnings.push(args) } }),
      { statusCode: 503, code: 'PUBLIC_ARTICLE_SYNC_FAILED', message: 'Public article synchronization failed. Retry the operation.' }
    );
    assert.equal(JSON.stringify(warnings).includes('private-sync-error'), false);
    assert.ok(warnings.length > 0);
    assert.equal(state.getFetchCalls(), 0);
    assert.deepEqual(docs.map((doc) => doc._id), ids);
    for (const doc of docs) {
      assert.equal(doc.status, 'published');
      assert.deepEqual(doc.publishedAt, publishedAt);
      assert.equal(doc.views, 17);
    }
  });
}

test('publication hides stale legacy copies without rewriting their dates or upserting groups', async (t) => {
  const docs = ['en', 'hi', 'gu'].map((lang, index) => makeLanguageDoc(lang, {
    status: 'published',
    publishedAt: new Date(`2026-01-0${index + 2}T00:00:00.000Z`),
  }));
  const state = installPublishMocks(t, docs);
  const writes = [];
  PublicArticle.updateMany = async (filter, update, options) => {
    writes.push({ filter, update, options });
    return { acknowledged: true, matchedCount: 1, modifiedCount: 0 };
  };
  const result = await publishCanonicalArticle(docs[0]);
  assert.deepEqual(result.publicSync, { ok: true, failedArticleIds: [] });
  assert.equal(writes.length, 1);
  for (const write of writes) {
    assert.notEqual(write.options.upsert, true);
    assert.ok(write.options.session);
    assert.deepEqual(write.update.$set, { status: 'draft' });
  }
  assert.deepEqual(state.publicCopies.map((copy) => copy.publishedAt), docs.map((doc) => doc.publishedAt));
});

for (const mode of ['throw', 'unacknowledged']) {
  test(`legacy public visibility ${mode} aborts publication before canonical upserts`, async (t) => {
    const docs = ['en', 'hi', 'gu'].map((lang) => makeLanguageDoc(lang));
    installPublishMocks(t, docs);
    const warnings = [];
    PublicArticle.updateMany = async () => {
      if (mode === 'throw') throw new Error('private-legacy-error-must-not-leak');
      return { acknowledged: false };
    };
    await assert.rejects(
      publishCanonicalArticle(docs[0], { logger: { warn: (...args) => warnings.push(args) } }),
      { statusCode: 503, code: 'PUBLIC_ARTICLE_SYNC_FAILED' }
    );
    assert.ok(docs.every((doc) => doc.status === 'draft'));
    assert.equal(warnings.length, 1);
    assert.equal(JSON.stringify(warnings).includes('private-legacy-error'), false);
  });
}

test('publish API exposes an incomplete public sync without leaking the driver error', async (t) => {
  const docs = ['en', 'hi', 'gu'].map((lang) => makeLanguageDoc(lang));
  installPublishMocks(t, docs);
  const user = { _id: '507f1f77bcf86cd799439711', email: 'founder@example.com', role: 'founder', status: 'active', noExpiry: true };
  const descriptor = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', { configurable: true, writable: true, value: 1 });
  t.after(() => {
    if (descriptor) Object.defineProperty(mongoose.connection, 'readyState', descriptor);
    else delete mongoose.connection.readyState;
  });
  t.mock.method(require('../models/User'), 'findById', () => ({ lean: async () => user }));
  const token = require('jsonwebtoken').sign({ sub: user._id, role: user.role, type: 'access' }, process.env.JWT_SECRET, { expiresIn: '5m' });
  PublicArticle.findOneAndUpdate = () => ({ lean: async () => null });
  const res = await request(app)
    .post(`/api/articles/${docs[0]._id}/publish`)
    .auth(token, { type: 'bearer' })
    .send();
  assert.equal(res.status, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.message, 'Public article synchronization failed. Retry the operation.');
  assert.ok(docs.every(doc => doc.status === 'draft'));
});

test('canonical publish failure leaves article drafts unpublished', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('gu')];
  installPublishMocks(t, docs, { failFetch: true });

  await assert.rejects(
    () => publishCanonicalArticle(docs[0]._id, { actor: { byRole: 'Founder', byUserId: null }, source: 'failure' }),
    /Failed to generate required translations/
  );
  assert.equal(docs[0].status, 'draft');
  assert.equal(docs[1].status, 'draft');
  assert.equal(docs[0].publishedAt, undefined);
  assert.equal(docs[1].publishedAt, undefined);
});

test('POST /api/articles/:id/publish rejects staff without verified Founder-granted publication authority', async (t) => {
  const state = installPublicationRouteFixture(t);
  const { ids } = seedGroup(state, { status: 'draft' });
  const before = structuredClone(state.rows);
  const res = await state.request('post', `/api/articles/${ids[0]}/publish`, undefined, 'admin');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'ARTICLE_PUBLISH_FORBIDDEN');
  for (const name of ['News', 'Article', 'TranslationJob']) assert.deepEqual(state.rows[name], before[name]);
  const writes = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
  assert.deepEqual(state.calls.filter(call => ['News', 'Article', 'TranslationJob'].includes(call.name) && writes.has(call.method)), []);
  assert.deepEqual(state.invalidations, []);
});

test('POST /api/articles can direct-publish through the canonical pipeline for Founder', async (t) => {
  const state = installPublicationRouteFixture(t);

  const res = await request(app)
    .post('/api/articles')
    .set('Authorization', `Bearer ${state.token('founder')}`)
    .send({
      title: 'Direct publish source',
      summary: 'Direct publish summary',
      content: '<p>Direct publish body</p>',
      category: 'national',
      language: 'en',
      slug: 'direct-publish-source',
      translationGroupId: 'grp-direct-publish',
      status: 'published',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.article.status, 'published');
  assert.deepEqual(res.body.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.deepEqual(state.rows.News.map(doc => doc.language).sort(), ['en', 'gu', 'hi']);
  assert.equal(state.rows.Article.length, 3);
  assert.ok(state.rows.Article.every(copy => copy.status === 'published'));
});