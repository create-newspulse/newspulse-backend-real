require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installEditorialFixture } = require('./helpers/editorialLifecycleFixture');

process.env.GOOGLE_TRANSLATE_API_KEY = 'fixture-translation-key';

function installSource(context) {
  const state = installEditorialFixture(context);
  context.mock.method(require('../models/PublicSiteSettings'), 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  const id = '507f1f77bcf86cd799439011';
  state.rows.News.push({
    _id: id, title: 'Title', description: 'Desc', content: 'Body', slug: 'slug',
    tags: ['t1'], category: 'national', status: 'published', lang: 'gu', language: 'gu',
    translationGroupId: 'grp-1', translationKey: null,
    imageURL: '/uploads/a.png', coverImageUrl: '/uploads/a.png',
    topic: 'politics', location: { state: 'Gujarat' },
    publishedAt: new Date('2025-01-01T00:00:00Z'),
  });
  return { state, id };
}

test('POST /api/admin/news/:id/generate-translations requires auth (401)', async context => {
  const { state, id } = installSource(context);
  const before = structuredClone(state.rows);
  const response = await state.request('post', `/api/admin/news/${id}/generate-translations`, undefined, null);
  assert.equal(response.statusCode, 401);
  assert.deepEqual(state.rows, before);
  assert.equal(state.transactions.length, 0);
});

test('POST /api/admin/news/:id/generate-translations creates missing target docs linked by translationKey', async context => {
  const { state, id } = installSource(context);
  const before = structuredClone(state.rows.News[0]);
  const fetch = global.fetch;
  context.mock.method(global, 'fetch', async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1/')) return fetch(url, options);
    const body = JSON.parse(options.body);
    assert.ok(Array.isArray(body.q));
    return {
      ok: true, status: 200,
      json: async () => ({ data: { translations: body.q.map(value => ({ translatedText: `${body.target}:${value}` })) } }),
    };
  });

  const response = await state.request('post', `/api/admin/news/${id}/generate-translations`);
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.success, true);
  assert.equal(response.body.translationKey, 'grp-1');
  const source = state.rows.News.find(doc => doc._id === id);
  assert.equal(source.translationKey, 'grp-1');
  assert.equal(source.translationGroupId, 'grp-1');
  for (const field of ['_id', 'slug', 'status', 'publishedAt', 'imageURL', 'coverImageUrl']) {
    assert.deepEqual(source[field], before[field], field);
  }
  const created = state.rows.News.filter(doc => doc._id !== id);
  assert.equal(created.length, 2);
  assert.deepEqual(created.map(doc => doc.lang).sort(), ['en', 'hi']);
  for (const child of created) {
    assert.equal(child.translationKey, 'grp-1');
    assert.equal(child.translationGroupId, 'grp-1');
    assert.equal(String(child.sourceArticleId), id);
    assert.equal(child.status, 'draft');
    assert.equal(child.translationReviewStatus, 'review_required');
    assert.equal(child.machineGenerated, true);
    assert.equal(child.translatedByProvider, 'google_translate');
  }
  assert.ok(state.rows.Article.every(copy => copy.sourceNewsId === id || copy.status !== 'published'));
  assert.ok(state.transactions[0].committed && state.transactions[0].ended);
});

test('compatibility generation rejects staff writes to a published group (403)', async context => {
  const { state, id } = installSource(context);
  const before = structuredClone(state.rows);
  const response = await state.request('post', `/api/admin/news/${id}/generate-translations`, undefined, 'editor');
  assert.equal(response.statusCode, 403);
  for (const name of ['News', 'Article', 'TranslationJob']) assert.deepEqual(state.rows[name], before[name]);
  assert.deepEqual(state.invalidations, []);
  assert.ok(state.transactions.every(session => session.aborted && session.ended && !session.committed));
});
