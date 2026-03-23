const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');

function restore(originals) {
  for (const [k, v] of Object.entries(originals.News)) News[k] = v;
  for (const [k, v] of Object.entries(originals.PublicArticle)) PublicArticle[k] = v;
}

test('DELETE /api/articles/:id also marks public copies as draft', async () => {
  const id = '507f1f77bcf86cd7994390aa';
  const originals = {
    News: { findById: News.findById, findByIdAndUpdate: News.findByIdAndUpdate },
    PublicArticle: { updateMany: PublicArticle.updateMany },
  };

  try {
    // The delete route uses: await News.findById(id).select(...).lean();
    // Stub the Mongoose query chain.
    News.findById = (_id) => ({
      select: () => ({
        lean: async () => (String(_id) === id
          ? { _id: id, workflowStage: 'PUBLISHED', slug: 'hello', title: 'T', coverImage: null, coverImageUrl: null, imageURL: null }
          : null),
      }),
    });

    News.findByIdAndUpdate = async (_id) => (String(_id) === id
      ? {
          _id: id,
          slug: 'hello',
          slugs: { en: 'hello', hi: 'namaste', gu: 'હેલો' },
          translationKey: 'grp1',
          translationGroupId: 'grp1',
          status: 'deleted',
          deletedAt: new Date(),
          workflowStage: 'REJECTED',
          title: 'T',
        }
      : null);

    let called = false;
    let lastQuery = null;
    let lastUpdate = null;

    PublicArticle.updateMany = async (q, u) => {
      called = true;
      lastQuery = q;
      lastUpdate = u;
      return { acknowledged: true, modifiedCount: 1 };
    };

    const res = await request(app)
      .delete(`/api/articles/${id}`)
      .set('Cookie', 'np_admin=admin@newspulse.ai')
      .send();

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.success, true);

    assert.equal(called, true);
    assert.deepEqual(lastUpdate, { $set: { status: 'draft', publishedAt: null } });

    // Sanity check: query includes at least one identifier clause.
    assert.equal(!!(lastQuery && lastQuery.$or && Array.isArray(lastQuery.$or) && lastQuery.$or.length), true);
  } finally {
    restore(originals);
  }
});
