const test = require('node:test');
const assert = require('node:assert/strict');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

for (const [method, alias] of [['delete', 'hard-delete'], ['post', 'hard-delete'], ['post', 'hard']]) {
  test(`${method.toUpperCase()} /api/articles/:id/${alias} permanently deletes when status=deleted`, async (t) => {
    const state = installEditorialFixture(t);
    const { ids } = seedGroup(state, { status: 'deleted' });
    const path = `/api/articles/${ids[0]}/${alias}`;
    for (const [role, status] of [[null, 401], ['editor', 403]]) {
      const denied = await state.request(method, path, {}, role);
      assert.equal(denied.status, status);
      assert.equal(state.rows.News.length, 3);
      assert.equal(state.rows.Article.length, 3);
    }
    const result = await state.request(method, path, {});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.message, 'Article permanently deleted.');
    assert.equal(state.rows.News.length, 0);
    assert.equal(state.rows.Article.length, 0);
  });
}

test('DELETE /api/articles/:id/hard-delete returns 409 if the story is not deleted', async (t) => {
  const state = installEditorialFixture(t);
  const { ids } = seedGroup(state, { status: 'draft' });
  const result = await state.request('delete', `/api/articles/${ids[0]}/hard-delete`);
  assert.equal(result.status, 409);
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.Article.length, 3);
});
