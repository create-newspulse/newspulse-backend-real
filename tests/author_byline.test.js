const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
const { buildAuthorBylinePatch, prepareAuthorBylineForPublication, withPublicAuthorByline } = require('../services/authorByline.service');

test('author attribution needs only a name, never a User, and freezes until explicitly edited', async (context) => {
  const User = require('../models/User');
  for (const method of ['find', 'findOne', 'findById']) context.mock.method(User, method, () => { throw new Error('Author bylines must not query Users'); });
  const doc = { category: 'national', status: 'draft' };
  assert.equal(await buildAuthorBylinePatch({}, doc), undefined);
  doc.authorByline = await buildAuthorBylinePatch({ authorByline: { enabled: true, snapshot: { name: ' Shailesh Rathod ' }, snapshotCapturedAt: '2000-01-01' } }, doc);
  assert.deepEqual(doc.authorByline, { enabled: true, snapshot: { name: 'Shailesh Rathod' } });
  await prepareAuthorBylineForPublication(doc, new Date('2026-01-01'));
  const frozen = structuredClone(doc.authorByline);
  await prepareAuthorBylineForPublication(doc, new Date('2026-02-01'));
  assert.deepEqual(doc.authorByline, frozen);
  doc.status = 'published';
  assert.equal(await buildAuthorBylinePatch({ summary: 'Unrelated edit' }, doc), undefined);
  assert.deepEqual(await buildAuthorBylinePatch({ authorByline: { enabled: true } }, doc), frozen);
  const updated = await buildAuthorBylinePatch({ authorByline: { snapshot: { name: 'Another Author', publicDesignation: 'Independent Writer', email: 'private@example.test' } } }, doc);
  assert.deepEqual(updated.snapshot, { name: 'Another Author', publicDesignation: 'Independent Writer' });
  assert.ok(updated.snapshotCapturedAt > frozen.snapshotCapturedAt);
  assert.deepEqual(await buildAuthorBylinePatch({ authorByline: { enabled: false } }, doc), { enabled: false });
});

test('author input requires a nonblank name and validates optional fields and uploaded photos', async () => {
  for (const input of [null, [], { enabled: 'true' }, { enabled: true }, { enabled: true, snapshot: null }, { enabled: true, snapshot: [] }, { enabled: true, snapshot: {} }, { enabled: true, snapshot: { name: ' ' } }]) {
    await assert.rejects(buildAuthorBylinePatch({ authorByline: input }), { statusCode: 400 });
  }
  for (const [field, limit] of Object.entries({ name: 160, publicDesignation: 160, photoUrl: 2048, shortBio: 600 })) {
    for (const value of [123, 'x'.repeat(limit + 1)]) {
      await assert.rejects(buildAuthorBylinePatch({ authorByline: { enabled: true, snapshot: { name: 'Author', [field]: value } } }), { statusCode: 400 });
    }
  }
  for (const photoUrl of ['https://example.test/photo.jpg', '/uploads/author-photo.jpg', '/uploads/images/author.png']) {
    const result = await buildAuthorBylinePatch({ authorByline: { enabled: true, snapshot: { name: 'Author', photoUrl } } });
    assert.equal(result.snapshot.photoUrl, photoUrl);
  }
  for (const photoUrl of ['javascript:alert(1)', 'data:image/png;base64,abc', 'http://example.test/photo.jpg', 'https://user:password@example.test/photo.jpg', '//example.test/photo.jpg', '/private-photo', '/uploads/../private', '/uploads/%2e%2e/private', '/uploads/..\\private']) {
    await assert.rejects(buildAuthorBylinePatch({ authorByline: { enabled: true, snapshot: { name: 'Author', photoUrl } } }), { statusCode: 400 });
  }
});

test('public author output is allowlisted, optional, and separate from Pulse Dialogue', async () => {
  assert.deepEqual(withPublicAuthorByline({ title: 'Legacy story' }), { title: 'Legacy story' });
  assert.deepEqual(withPublicAuthorByline({ authorByline: { enabled: false } }), {});
  const snapshot = { name: 'Author', publicDesignation: 'Columnist', photoUrl: '/uploads/author.jpg', shortBio: 'Public biography' };
  assert.deepEqual(withPublicAuthorByline({ authorByline: { enabled: true, snapshotCapturedAt: new Date(), internalId: 'private', snapshot: { ...snapshot, email: 'private@example.test' } } }), { authorByline: { enabled: true, snapshot } });
  assert.deepEqual(withPublicAuthorByline({ authorByline: { enabled: true, snapshot: { name: 'Author', photoUrl: 'javascript:alert(1)' } } }), {});
  const pulseDialogue = { contributorId: '507f1f77bcf86cd799439901', bylineSnapshot: { name: 'Contributor' }, disclaimer: 'Original disclaimer' };
  const dialogue = { category: 'pulse-dialogue', pulseDialogue };
  assert.deepEqual(withPublicAuthorByline({ ...dialogue, authorByline: { enabled: true, snapshot } }), dialogue);
  await assert.rejects(buildAuthorBylinePatch({ authorByline: { enabled: true, snapshot } }, dialogue), /separate/);
});

for (const Model of [require('../models/Article'), require('../models/News')]) {
  const makeArticle = (fields = {}) => new Model({
    title: 'Test article', description: 'Summary', slug: 'test-article', category: 'national',
    originalLang: 'en', sourceLanguage: 'en', ...fields,
  });

  test(`${Model.modelName}: legacy articles and disabled author bylines remain valid`, () => {
    const legacy = makeArticle();
    assert.equal(legacy.validateSync(), undefined);
    assert.equal(legacy.toObject().authorByline, undefined);
    const disabled = makeArticle({ authorByline: {} });
    assert.equal(disabled.authorByline.enabled, false);
    assert.equal(disabled.validateSync(), undefined);
    assert.equal(makeArticle({ authorByline: { enabled: false, snapshot: {} } }).validateSync(), undefined);
  });

  test(`${Model.modelName}: enabled author needs only a name and discards unknown fields`, () => {
    for (const authorByline of [{ enabled: true }, { enabled: true, snapshot: {} }, { enabled: true, snapshot: { name: ' ' } }]) {
      assert.ok(makeArticle({ authorByline }).validateSync());
    }
    const valid = makeArticle({ authorByline: { enabled: true, snapshot: { name: 'Independent Author', email: 'private@example.test', permissions: ['internal'] } } });
    assert.equal(valid.validateSync(), undefined);
    assert.deepEqual(valid.toObject().authorByline, { enabled: true, snapshot: { name: 'Independent Author' } });
  });
}

test('public HTTP responses allowlist author fields and legacy writes cannot bypass validation', async (context) => {
  const express = require('express');
  const request = require('supertest');
  const mongoose = require('mongoose');
  const News = require('../models/News');
  const Article = require('../models/Article');
  const { getPublicNewsByTranslationKey } = require('../controllers/publicNewsController');
  const { getArticleBySlug, listArticles } = require('../controllers/publicArticlesController');
  const { createNews, updateNews, getPublishedNewsBySlug } = require('../controllers/newsController');
  const app = express();
  app.use(express.json());
  app.get('/news', getPublicNewsByTranslationKey);
  app.get('/legacy-news/:slug', getPublishedNewsBySlug);
  app.post('/legacy-news', createNews);
  app.put('/legacy-news/:id', updateNews);
  app.get('/articles', listArticles);
  app.get('/articles/:slug', getArticleBySlug);
  const previousReadyState = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = previousReadyState; });
  const articleId = '507f1f77bcf86cd799439901';
  const snapshot = { name: 'Independent Author', publicDesignation: 'Correspondent', photoUrl: '/uploads/author.jpg', shortBio: 'Public biography' };
  const doc = {
    _id: articleId, title: 'Article', description: 'Summary', summary: 'Summary', content: 'Content', slug: 'article',
    category: 'national', status: 'published', language: 'en', lang: 'en', originalLang: 'en', translationKey: 'byline-group',
    authorByline: {
      enabled: true, internalId: 'private-id', snapshotCapturedAt: new Date(),
      snapshot: { ...snapshot, email: 'private@example.test', phone: 'private-phone', permissions: ['internal'] },
    },
  };
  const query = (result) => ({
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; }, lean: async () => result,
  });
  context.mock.method(News, 'findOne', () => query(doc));
  context.mock.method(Article, 'findOne', () => query(doc));
  context.mock.method(Article, 'find', () => query([doc]));
  context.mock.method(Article, 'countDocuments', async () => 1);
  context.mock.method(require('../models/User'), 'findOne', () => { throw new Error('Public reads must not query Users'); });
  for (const endpoint of ['/news?translationKey=byline-group&lang=en', '/articles/article', '/articles', '/legacy-news/article']) {
    const response = await request(app).get(endpoint);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const article = response.body.items ? response.body.items[0] : (response.body.data || response.body);
    assert.deepEqual(article.authorByline, { enabled: true, snapshot });
    for (const forbidden of ['private@example.test', 'private-phone', 'permissions', 'internalId', 'snapshotCapturedAt']) {
      assert.equal(JSON.stringify(response.body).includes(forbidden), false, forbidden);
    }
  }
  for (const payload of [{ authorByline: { enabled: true, snapshot } }, { 'authorByline.snapshot.name': 'Unvalidated' }]) {
    assert.equal((await request(app).post('/legacy-news').send(payload)).status, 400);
    assert.equal((await request(app).put(`/legacy-news/${articleId}`).send(payload)).status, 400);
  }
  doc.authorByline = { enabled: false };
  assert.equal((await request(app).get('/articles/article')).body.authorByline, undefined);
});

test('translation synchronization shares all author fields and propagates explicit removal', () => {
  const { buildChildNewsSyncPatch } = require('../services/translationGroupSync.service');
  const master = {
    _id: '507f1f77bcf86cd799439901', lang: 'en', originalLang: 'en', status: 'draft', category: 'national',
    authorByline: { enabled: true, snapshot: { name: 'Shared Name', publicDesignation: 'Writer', shortBio: 'Shared bio', photoUrl: '/uploads/author.jpg' } },
  };
  for (const language of ['en', 'hi', 'gu']) {
    const child = { lang: language, language, authorByline: master.authorByline };
    assert.deepEqual(buildChildNewsSyncPatch(master, child).authorByline, master.authorByline);
    assert.deepEqual(buildChildNewsSyncPatch({ ...master, authorByline: { enabled: false } }, child).authorByline, { enabled: false });
  }
});

test('the uncommitted reporter selector is no longer registered', () => {
  const router = require('../routes/articles.routes');
  assert.equal(router.stack.some((layer) => layer.route?.path === '/articles/reporter-options'), false);
});