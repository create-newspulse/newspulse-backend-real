require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

test('DELETE /api/articles/:id hides matching public copies and preserves publication chronology', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  state.rows.Article.push({
    _id: '707f1f77bcf86cd79943a010', slug: 'story-en', status: 'published',
    publishedAt: publication, sourceNewsId: null,
  });
  const unrelated = {
    _id: '707f1f77bcf86cd79943a011', slug: 'unrelated', status: 'published',
    publishedAt: publication, sourceNewsId: '507f1f77bcf86cd79943a099',
  };
  state.rows.Article.push(unrelated);

  const response = await state.request('delete', `/api/articles/${ids[0]}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.success, true);
  assert.equal(response.body.deletedCount, 3);
  assert.deepEqual(new Set(response.body.deletedIds), new Set(ids));
  for (const copy of state.rows.Article.filter(copy => copy._id !== unrelated._id)) {
    assert.equal(copy.status, 'deleted');
    assert.ok(copy.deletedAt instanceof Date);
    assert.deepEqual(copy.publishedAt, publication);
  }
  assert.deepEqual(state.rows.Article.find(copy => copy._id === unrelated._id), unrelated);
  assert.ok(state.rows.News.every(doc => doc.status === 'deleted'));
  assert.ok(state.rows.News.every(doc => doc.publishedAt.getTime() === publication.getTime()));
  const writes = state.calls.filter(call => call.name === 'Article' && call.method === 'updateMany');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.session, state.transactions[0]);
  assert.ok(state.transactions[0].committed && state.transactions[0].ended);
});
