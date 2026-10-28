require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

function installGroupFixture(context, status = 'draft') {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state, { status });
  const titles = { en: 'English title', hi: 'हिंदी शीर्षक', gu: 'ગુજરાતી શીર્ષક' };
  for (const row of [...state.rows.News, ...state.rows.Article]) {
    row.title = titles[row.language];
    row.category = 'national';
  }
  return { state, ids, publication };
}

function makeQueryResult(doc, capture) {
  return {
    select(arg) {
      if (capture) capture.selectArg = arg;
      return this;
    },
    lean: async () => doc,
  };
}

function makeFindResult(docs) {
  const query = {
    select() { return this; },
    lean: async () => docs,
    then(resolve, reject) { return Promise.resolve(docs).then(resolve, reject); },
    catch(reject) { return Promise.resolve(docs).catch(reject); },
  };
  return query;
}

function baseArticle(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439201',
    title: 'English Title',
    description: 'English summary',
    content: 'English body',
    slug: 'english-title',
    slugs: { en: 'english-title', hi: 'hindi-title', gu: 'gujarati-title' },
    category: 'national',
    status: 'published',
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    translationGroupId: 'grp-gujarati-1',
    publishedAt: new Date('2026-07-25T09:00:00.000Z'),
    createdAt: new Date('2026-07-25T08:00:00.000Z'),
    ...overrides,
  };
}

test('News and Article models canonicalize Gujarati language aliases to gu', async () => {
  const news = new News({
    title: 'ગુજરાતી લેખ',
    description: 'સારાંશ',
    content: 'મુખ્ય લખાણ',
    category: 'national',
    slug: 'gujarati-alias-news',
    language: 'Gujarati',
    lang: 'gu-IN',
  });
  await news.validate();
  assert.equal(news.language, 'gu');
  assert.equal(news.lang, 'gu');

  const publicArticle = new PublicArticle({
    title: 'ગુજરાતી લેખ',
    summary: 'સારાંશ',
    content: 'મુખ્ય લખાણ',
    category: 'national',
    slug: 'gujarati-alias-public',
    language: 'gj',
    sourceLanguage: 'gu',
  });
  await publicArticle.validate();
  assert.equal(publicArticle.language, 'gu');
});

test('POST /api/articles creates Gujarati draft with language=gu', async context => {
  const state = installEditorialFixture(context);
  const sourceId = '507f1f77bcf86cd799439299';
  state.rows.News.push(baseArticle({
    _id: sourceId, sourceArticleId: sourceId, status: 'draft', publishedAt: null,
    translationGroupId: 'grp-create-gu-1', translationKey: 'grp-create-gu-1',
  }));
  const res = await state.request('post', '/api/articles', {
    title: 'ગુજરાતી ડ્રાફ્ટ', summary: 'ગુજરાતી સારાંશ', content: 'ગુજરાતી લેખનું મુખ્ય લખાણ',
    category: 'national', language: 'gu', translationGroupId: 'grp-create-gu-1',
    sourceArticleId: sourceId, slug: 'gujarati-draft-create', status: 'draft',
  });
  assert.equal(res.status, 201, res.text);
  const created = state.rows.News.filter(doc => doc._id !== sourceId);
  assert.equal(created.length, 1);
  assert.equal(created[0].language, 'gu');
  assert.equal(created[0].lang, 'gu');
  assert.equal(created[0].status, 'draft');
  assert.equal(created[0].translationGroupId, 'grp-create-gu-1');
  assert.equal(created[0].sourceArticleId, sourceId);
});

test('POST /api/articles prevents duplicate translationGroupId + language records', async context => {
  const state = installEditorialFixture(context);
  state.rows.News.push(baseArticle({
    language: 'gu', lang: 'gu', originalLang: 'gu', translationGroupId: 'grp-duplicate-gu-1',
  }));
  const before = structuredClone(state.rows);
  const res = await state.request('post', '/api/articles', {
    title: 'ડુપ્લિકેટ ગુજરાતી', summary: 'સારાંશ', content: 'મુખ્ય લખાણ',
    category: 'national', language: 'Gujarati', translationGroupId: 'grp-duplicate-gu-1',
    slug: 'duplicate-gujarati', status: 'draft',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.deepEqual(state.rows, before);
  assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'create').length, 0);
});

test('POST /api/articles/:id/publish publishes Gujarati article without changing its language', async context => {
  const { state, ids } = installGroupFixture(context);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    doc.sourceArticleId = ids[2];
    doc.sourceLanguage = 'gu';
  }
  const publicIds = state.rows.Article.map(copy => copy._id);
  const res = await state.request('post', `/api/articles/${ids[2]}/publish`);
  assert.equal(res.status, 200, res.text);
  const doc = state.rows.News.find(row => row._id === ids[2]);
  assert.equal(doc.status, 'published');
  assert.equal(doc.language, 'gu');
  assert.equal(doc.lang, 'gu');
  assert.equal(res.body.article.language, 'gu');
  assert.deepEqual(res.body.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.deepEqual(state.rows.Article.map(copy => copy._id), publicIds);
  assert.ok(state.rows.Article.every(copy => copy.status === 'published'));
});

test('Public detail resolves EN, HI, and GU sibling records from one translation group', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;
  const prevFind = News.find;

  try {
    mongoose.connection.readyState = 1;

    const en = baseArticle();
    const hi = baseArticle({
      _id: '507f1f77bcf86cd799439202',
      title: 'हिंदी शीर्षक',
      description: 'हिंदी सारांश',
      content: 'हिंदी सामग्री',
      slug: 'hindi-title',
      language: 'hi',
      lang: 'hi',
      originalLang: 'hi',
    });
    const gu = baseArticle({
      _id: '507f1f77bcf86cd799439203',
      title: 'ગુજરાતી શીર્ષક',
      description: 'ગુજરાતી સારાંશ',
      content: 'ગુજરાતી મુખ્ય લખાણ',
      slug: 'gujarati-title',
      language: 'gu',
      lang: 'gu',
      originalLang: 'gu',
    });
    const groupDocs = [en, hi, gu];
    News.find = () => makeFindResult(groupDocs);

    async function fetchLang(lang) {
      let call = 0;
      News.findOne = () => {
        call += 1;
        if (call === 1) return makeQueryResult(en);
        if (lang === 'hi') return makeQueryResult(hi);
        if (lang === 'gu') return makeQueryResult(gu);
        return makeQueryResult(null);
      };
      return request(app).get(`/api/public/news/english-title?lang=${lang}`);
    }

    const enRes = await fetchLang('en');
    assert.equal(enRes.status, 200);
    assert.equal(enRes.body.title, 'English Title');
    assert.equal(enRes.body.language, 'en');
    assert.equal(enRes.body.resolvedLang, 'en');
    assert.deepEqual(enRes.body.translationAvailability.translations, { en: true, hi: true, gu: true });

    const hiRes = await fetchLang('hi');
    assert.equal(hiRes.status, 200);
    assert.equal(hiRes.body.title, 'हिंदी शीर्षक');
    assert.equal(hiRes.body.language, 'hi');
    assert.equal(hiRes.body.resolvedLang, 'hi');
    assert.equal(hiRes.body.isTranslated, false);
    assert.deepEqual(hiRes.body.translationAvailability.translations, { en: true, hi: true, gu: true });

    const guRes = await fetchLang('gu');
    assert.equal(guRes.status, 200);
    assert.equal(guRes.body.title, 'ગુજરાતી શીર્ષક');
    assert.equal(guRes.body.content, 'ગુજરાતી મુખ્ય લખાણ');
    assert.equal(guRes.body.language, 'gu');
    assert.equal(guRes.body.resolvedLang, 'gu');
    assert.equal(guRes.body.isTranslated, false);
    assert.equal(guRes.body.requestedLanguage, 'gu');
    assert.equal(guRes.body.resolvedLanguage, 'gu');
    assert.equal(guRes.body.isFallback, false);
    assert.deepEqual(guRes.body.translations, { en: true, hi: true, gu: true });
    assert.deepEqual(guRes.body.translationAvailability.translations, { en: true, hi: true, gu: true });

    let guSlugCall = 0;
    News.findOne = () => {
      guSlugCall += 1;
      return makeQueryResult(guSlugCall === 1 ? gu : null);
    };
    const guSlugRes = await request(app).get('/api/public/news/gujarati-title?lang=gu');
    assert.equal(guSlugRes.status, 200);
    assert.equal(guSlugRes.body.title, 'ગુજરાતી શીર્ષક');
    assert.equal(guSlugRes.body.language, 'gu');
    assert.equal(guSlugRes.body.canonicalSlug, 'gujarati-title');
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.findOne = prevFindOne;
    News.find = prevFind;
  }
});

test('Missing Gujarati sibling falls back without pretending content language is Gujarati', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;
  const prevFind = News.find;

  try {
    mongoose.connection.readyState = 1;
    let call = 0;
    News.findOne = () => {
      call += 1;
      return makeQueryResult(call === 1 ? baseArticle() : null);
    };
    News.find = () => makeFindResult([baseArticle()]);

    const missingRes = await request(app).get('/api/public/news/english-title?lang=gu');
    assert.equal(missingRes.status, 404);
    assert.deepEqual(missingRes.body.translationAvailability.translations, { en: true, hi: false, gu: false });

    call = 0;
    const res = await request(app).get('/api/public/news/english-title?lang=gu&fallback=true');
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'English Title');
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.resolvedLanguage, 'en');
    assert.equal(res.body.language, 'en');
    assert.equal(res.body.isFallback, true);
    assert.equal(res.body.isTranslated, false);
    assert.equal(res.body.translationAvailability.translations.gu, false);
    assert.equal(res.body.translationAvailability.fallbackEnabled, true);
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.findOne = prevFindOne;
    News.find = prevFind;
  }
});

test('Gujarati draft, scheduled, archived, and deleted stories are not returned publicly', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;
  const prevPublicFindOne = PublicArticle.findOne;
  const capturedFilters = [];

  try {
    mongoose.connection.readyState = 1;
    News.findOne = (filter) => {
      capturedFilters.push(filter);
      return makeQueryResult(null);
    };
    PublicArticle.findOne = () => makeQueryResult(null);

    for (const slug of ['gu-draft', 'gu-scheduled', 'gu-archived', 'gu-deleted']) {
      const res = await request(app).get(`/api/public/news/${slug}?lang=gu`);
      assert.equal(res.status, 404);
    }

    assert.ok(capturedFilters.length >= 3);
    for (const filter of capturedFilters) {
      const serialized = JSON.stringify(filter);
      assert.match(serialized, /published/);
      assert.match(serialized, /publishedAt/);
      assert.match(serialized, /deletedAt/);
    }
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.findOne = prevFindOne;
    PublicArticle.findOne = prevPublicFindOne;
  }
});

test('Updating Gujarati article preserves English and Hindi sibling content and publication identities', async context => {
  const { state, ids } = installGroupFixture(context);
  const before = structuredClone(state.rows.News);
  const res = await state.request('put', `/api/articles/${ids[2]}`, {
    title: 'નવું ગુજરાતી', summary: 'નવો સારાંશ', content: 'નવું મુખ્ય લખાણ', language: 'gu',
  });
  assert.equal(res.status, 200, res.text);
  const gu = state.rows.News.find(doc => doc._id === ids[2]);
  assert.equal(gu.title, 'નવું ગુજરાતી');
  assert.equal(gu.description, 'નવો સારાંશ');
  assert.equal(gu.content, 'નવું મુખ્ય લખાણ');
  assert.equal(gu.language, 'gu');
  assert.equal(gu.lang, 'gu');
  assert.equal(gu.originalLang, 'gu');
  for (const previous of before.slice(0, 2)) {
    const stored = state.rows.News.find(doc => doc._id === previous._id);
    for (const field of [
      '_id', 'title', 'description', 'content', 'slug', 'language', 'lang', 'originalLang',
      'sourceArticleId', 'translationGroupId', 'publishedAt', 'createdAt', 'coverImage',
    ]) assert.deepEqual(stored[field], previous[field], field);
  }
});

test('DELETE /api/articles/:id soft-deletes every member of a multilingual translation group', async context => {
  const { state, ids, publication } = installGroupFixture(context, 'published');
  const other = baseArticle({
    _id: '507f1f77bcf86cd799439274', translationGroupId: 'unrelated', translationKey: 'unrelated',
    slug: 'unrelated-delete-group', sourceArticleId: '507f1f77bcf86cd799439274',
  });
  state.rows.News.push(structuredClone(other));
  const response = await state.request('delete', `/api/articles/${ids[2]}`, { reason: 'delete full story' });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.deletedCount, 3);
  assert.deepEqual(new Set(response.body.deletedIds), new Set(ids));
  for (const doc of state.rows.News.filter(doc => ids.includes(doc._id))) {
    assert.equal(doc.status, 'deleted');
    assert.equal(doc.workflowStage, 'REJECTED');
    assert.ok(doc.deletedAt instanceof Date);
    assert.deepEqual(doc.publishedAt, publication);
  }
  assert.deepEqual(state.rows.News.find(doc => doc._id === other._id), other);
  assert.equal(state.rows.Article.length, 3);
  assert.ok(state.rows.Article.every(copy => copy.status === 'deleted' && copy.deletedAt instanceof Date));
  assert.ok(state.rows.Article.every(copy => copy.publishedAt.getTime() === publication.getTime()));
  assert.equal(state.rows.PushHistory.length, 3);
});

test('DELETE /api/articles/:id soft-deletes only the selected legacy article when no group key exists', async context => {
  const state = installEditorialFixture(context);
  const legacyId = '507f1f77bcf86cd799439281';
  const siblingId = '507f1f77bcf86cd799439282';
  const legacy = baseArticle({ _id: legacyId, translationGroupId: null, translationKey: null, slug: 'legacy-delete-one' });
  const sibling = baseArticle({ _id: siblingId, translationGroupId: null, translationKey: null, slug: 'legacy-do-not-delete' });
  state.rows.News.push(structuredClone(legacy), structuredClone(sibling));
  const res = await state.request('delete', `/api/articles/${legacyId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.deletedCount, 1);
  assert.deepEqual(res.body.deletedIds, [legacyId]);
  assert.equal(state.rows.News.find(doc => doc._id === legacyId).status, 'deleted');
  assert.deepEqual(state.rows.News.find(doc => doc._id === siblingId), sibling);
});

test('Publish-all-languages validates complete EN HI GU group before changing statuses', async context => {
  const { state, ids } = installGroupFixture(context);
  state.rows.News[2].description = '';
  const before = structuredClone(state.rows);
  const res = await state.request('post', `/api/articles/${ids[0]}/publish-all-languages`);
  assert.equal(res.status, 400, res.text);
  assert.deepEqual(res.body.invalidRecords, [{ language: 'gu', id: ids[2], missingFields: ['summary'] }]);
  for (const name of ['News', 'Article', 'TranslationJob']) assert.deepEqual(state.rows[name], before[name]);
  assert.deepEqual(state.invalidations, []);
  assert.ok(state.transactions[0].aborted && state.transactions[0].ended && !state.transactions[0].committed);
});

test('Publish-all-languages publishes complete EN HI GU group together', async context => {
  const { state, ids } = installGroupFixture(context);
  const publicIds = state.rows.Article.map(copy => copy._id);
  const res = await state.request('post', `/api/articles/${ids[0]}/publish-all-languages`, { reason: 'complete group' });
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.body.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.deepEqual(state.rows.News.map(doc => doc._id), ids);
  assert.deepEqual(state.rows.Article.map(copy => copy._id), publicIds);
  for (const doc of state.rows.News) {
    assert.equal(doc.status, 'published');
    assert.equal(doc.workflowStage, 'PUBLISHED');
    assert.ok(doc.publishedAt instanceof Date);
    const copy = state.rows.Article.find(item => item.sourceNewsId === doc._id);
    assert.equal(copy.status, 'published');
    assert.equal(copy.language, doc.language);
    assert.deepEqual(copy.publishedAt, doc.publishedAt);
  }
  assert.ok(state.transactions[0].committed && state.transactions[0].ended);
});
