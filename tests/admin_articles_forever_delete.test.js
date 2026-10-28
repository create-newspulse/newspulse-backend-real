require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

test('DELETE /api/admin/articles/:id/forever (permanent delete)', async (t) => {
  await t.test('401 when unauthenticated', async context => {
    const state = installEditorialFixture(context);
    const res = await state.request('delete', '/api/admin/articles/507f1f77bcf86cd799439011/forever', undefined, null);
    assert.equal(res.statusCode, 401);
    assert.equal(state.transactions.length, 0);
    assert.deepEqual(state.rows.News, []);
  });

  await t.test('200 and complete group removal when every edition is deleted', async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    const res = await state.request('delete', `/api/admin/articles/${ids[1]}/forever`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.deletedCount, 3);
    assert.equal(res.body.publicDeletedCount, 3);
    assert.deepEqual(new Set(res.body.deletedIds), new Set(ids));
    assert.deepEqual(state.rows.News, []);
    assert.deepEqual(state.rows.Article, []);
    assert.equal(state.rows.EditorialTopic[0].pinnedArticleId, null);
    assert.ok(state.transactions[0].committed && state.transactions[0].ended);
  });

  await t.test('409 and no writes when a sibling is not deleted', async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    state.rows.News[2].status = 'draft';
    const before = structuredClone(state.rows);
    const res = await state.request('delete', `/api/admin/articles/${ids[0]}/forever`);
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /completely soft-deleted stories/);
    assert.deepEqual(state.rows, before);
    assert.deepEqual(state.invalidations, []);
    assert.ok(state.transactions[0].aborted && state.transactions[0].ended);
  });

  await t.test('403 and no writes for authenticated non-Founder staff', async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    const before = structuredClone(state.rows);
    const res = await state.request('delete', `/api/admin/articles/${ids[0]}/forever`, undefined, 'editor');
    assert.equal(res.statusCode, 403);
    assert.deepEqual(state.rows.News, before.News);
    assert.deepEqual(state.rows.Article, before.Article);
    assert.equal(state.transactions.length, 0);
    assert.deepEqual(state.invalidations, []);
  });
});

test('CORS preflight allows DELETE + OPTIONS for admin + local origins (articles forever)', async () => {
  const paths = [
    { origin: 'https://admin.newspulse.co.in', path: '/api/admin/articles/507f1f77bcf86cd799439011/forever' },
    { origin: 'http://localhost:9999', path: '/api/admin/articles/507f1f77bcf86cd799439011/forever' },
  ];

  for (const p of paths) {
    const res = await request(app)
      .options(p.path)
      .set('Origin', p.origin)
      .set('Access-Control-Request-Method', 'DELETE')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization')
      .expect(204);

    assert.equal(res.headers['access-control-allow-origin'], p.origin);

    const methods = String(res.headers['access-control-allow-methods'] || '');
    assert.ok(methods.includes('DELETE'));
    assert.ok(methods.includes('OPTIONS'));
  }
});
