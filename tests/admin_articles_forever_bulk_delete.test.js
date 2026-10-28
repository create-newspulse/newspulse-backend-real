require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

test('POST /api/admin/articles/forever/bulk requires auth (401)', async context => {
  const state = installEditorialFixture(context);
  const res = await state.request('post', '/api/admin/articles/forever/bulk', {
    ids: ['507f1f77bcf86cd799439011'],
  }, null);
  assert.equal(res.statusCode, 401);
  assert.equal(state.transactions.length, 0);
});

test('POST /api/admin/articles/forever/bulk validates ids array (400)', async context => {
  const state = installEditorialFixture(context);
  for (const body of [{}, { ids: [] }, { ids: ['not-an-objectid'] }]) {
    const res = await state.request('post', '/api/admin/articles/forever/bulk', body);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(state.transactions.length, 0);
  assert.deepEqual(state.rows.News, []);
});

test('POST /api/admin/articles/forever/bulk deletes only soft-deleted groups and deduplicates selected siblings', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  const unrelated = { _id: '507f1f77bcf86cd799439099', slug: 'unrelated', status: 'published' };
  state.rows.News.push(unrelated);
  const res = await state.request('post', '/api/admin/articles/forever/bulk', { ids: ids.slice(0, 2) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.deletedCount, 3);
  assert.equal(res.body.publicDeletedCount, 3);
  assert.deepEqual(new Set(res.body.deletedIds), new Set(ids));
  assert.deepEqual(state.rows.News, [unrelated]);
  assert.deepEqual(state.rows.Article, []);
  const deletes = state.calls.filter(call => call.name === 'News' && call.method === 'deleteMany');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].filter.status, 'deleted');
  assert.deepEqual(new Set(deletes[0].filter._id.$in), new Set(ids));
  assert.equal(deletes[0].options.session, state.transactions[0]);
});

test('DELETE /api/admin/articles/forever/all-deleted deletes complete soft-deleted groups only', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  const unrelated = { _id: '507f1f77bcf86cd799439098', slug: 'untouched-draft', status: 'draft' };
  state.rows.News.push(unrelated);
  const res = await state.request('delete', '/api/admin/articles/forever/all-deleted');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.deletedCount, 3);
  assert.deepEqual(new Set(res.body.deletedIds), new Set(ids));
  assert.deepEqual(state.rows.News, [unrelated]);
  assert.deepEqual(state.rows.Article, []);
});

test('permanent bulk and all-deleted actions reject authenticated non-Founder staff (403)', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  const before = structuredClone(state.rows);
  for (const [method, url, body] of [
    ['post', '/api/admin/articles/forever/bulk', { ids }],
    ['delete', '/api/admin/articles/forever/all-deleted', undefined],
  ]) {
    const res = await state.request(method, url, body, 'editor');
    assert.equal(res.statusCode, 403);
  }
  assert.deepEqual(state.rows.News, before.News);
  assert.deepEqual(state.rows.Article, before.Article);
  assert.equal(state.transactions.length, 0);
  assert.deepEqual(state.invalidations, []);
});
