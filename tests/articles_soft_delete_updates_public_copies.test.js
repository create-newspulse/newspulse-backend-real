const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');

function restore(originals) {
  for (const [k, v] of Object.entries(originals.News)) News[k] = v;
  for (const [k, v] of Object.entries(originals.PublicArticle)) PublicArticle[k] = v;
  for (const [k, v] of Object.entries(originals.PushHistory || {})) PushHistory[k] = v;
}

test('DELETE /api/articles/:id also marks public copies as draft', async () => {
  const id = '507f1f77bcf86cd7994390aa';
  const originals = {
    News: { findById: News.findById, find: News.find, findByIdAndUpdate: News.findByIdAndUpdate },
    PublicArticle: { findOneAndUpdate: PublicArticle.findOneAndUpdate, updateMany: PublicArticle.updateMany },
    PushHistory: { create: PushHistory.create },
  };

  try {
    // The delete route uses: await News.findById(id).select(...).lean();
    // Stub the Mongoose query chain.
    News.findById = (_id) => ({
      select: () => ({
        lean: async () => (String(_id) === id
          ? { _id: id, workflowStage: 'PUBLISHED', slug: 'hello', title: 'T', coverImage: null, coverImageUrl: null, imageURL: null, translationGroupId: 'grp1', translationKey: 'grp1' }
          : null),
      }),
    });

    News.find = () => ({
      select() { return this; },
      lean: async () => [{ _id: id, workflowStage: 'PUBLISHED', slug: 'hello', title: 'T', coverImage: null, coverImageUrl: null, imageURL: null, translationGroupId: 'grp1', translationKey: 'grp1' }],
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
      catch(reject) { return Promise.resolve([]).catch(reject); },
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
      PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-sync' }) });
      PushHistory.create = async () => ({ _id: 'push-delete' });

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
    assert.equal(res.body.deletedCount, 1);
    assert.deepEqual(res.body.deletedIds, [id]);

    assert.equal(called, true);
    assert.deepEqual(lastUpdate, { $set: { status: 'draft', publishedAt: null } });

    // Sanity check: query includes at least one identifier clause.
    assert.equal(!!(lastQuery && lastQuery.$or && Array.isArray(lastQuery.$or) && lastQuery.$or.length), true);
  } finally {
    restore(originals);
  }
});
