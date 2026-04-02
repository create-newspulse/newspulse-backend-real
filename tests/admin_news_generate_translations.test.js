const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const News = require('../models/News');

function restore(originals) {
  for (const [k, v] of Object.entries(originals)) News[k] = v;
}

test('POST /api/admin/news/:id/generate-translations requires auth (401)', async () => {
  const res = await request(app)
    .post('/api/admin/news/507f1f77bcf86cd799439011/generate-translations')
    .send();
  assert.equal(res.statusCode, 401);
});

test('POST /api/admin/news/:id/generate-translations creates missing EN/HI/GU docs linked by translationKey', async () => {
  const id = '507f1f77bcf86cd799439011';
  const originals = {
    findById: News.findById,
    updateOne: News.updateOne,
    findOne: News.findOne,
    create: News.create,
  };

  // Stub global fetch for Google Translate v2.
  const prevFetch = global.fetch;
  global.fetch = async (_url, opts) => {
    const body = JSON.parse(String(opts && opts.body ? opts.body : '{}'));
    const qs = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          translations: qs.map((q) => ({ translatedText: `T:${q}` })),
        },
      }),
    };
  };

  try {
    News.findById = async (_id) => (_id === id ? {
      _id: id,
      title: 'Title',
      description: 'Desc',
      content: 'Body',
      slug: 'slug',
      tags: ['t1'],
      category: 'national',
      status: 'published',
      lang: 'gu',
      language: 'gu',
      translationGroupId: 'grp-1',
      translationKey: null,
      imageURL: '/uploads/a.png',
      coverImageUrl: '/uploads/a.png',
      topic: 'politics',
      location: { state: 'Gujarat' },
      publishedAt: new Date('2025-01-01T00:00:00Z'),
      date: new Date('2025-01-01T00:00:00Z'),
    } : null);

    let updated = null;
    News.updateOne = async (q, u) => { updated = { q, u }; return { acknowledged: true, modifiedCount: 1 }; };

    // For each language, simulate: none exists.
    News.findOne = async (_q) => null;

    const created = [];
    News.create = async (payload) => { created.push(payload); return { _id: `id-${payload.lang}` }; };

    const res = await request(app)
      .post(`/api/admin/news/${id}/generate-translations`)
      .set('Cookie', 'np_admin=admin@newspulse.ai')
      .send();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);
    assert.equal(res.body.translationKey, 'grp-1');

    // Source doc should be updated to have translationKey + translationGroupId.
    assert.ok(updated);
    assert.equal(String(updated.u.$set.translationKey), 'grp-1');
    assert.equal(String(updated.u.$set.translationGroupId), 'grp-1');

    // Should create 3 docs.
    assert.equal(created.length, 3);
    const langs = created.map((p) => p.lang).sort();
    assert.deepEqual(langs, ['en', 'gu', 'hi']);

    // Ensure linkage.
    for (const p of created) {
      assert.equal(p.translationKey, 'grp-1');
      assert.equal(p.translationGroupId, 'grp-1');
    }
  } finally {
    restore(originals);
    global.fetch = prevFetch;
  }
});
