const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const News = require('../models/News');
const PublicArticle = require('../models/Article');

// Ensure we load the app in test/import mode (server.js already skips DB when imported)
process.env.NODE_ENV = 'test';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('PUT /api/articles/:id ignores title="undefined" sentinel (does not $set title)', async () => {
  const id = '507f1f77bcf86cd799439011';

  const prevFindById = News.findById;
  const prevFindByIdAndUpdate = News.findByIdAndUpdate;
  const prevPublicFindOneAndUpdate = PublicArticle.findOneAndUpdate;

  /** @type {any[]} */
  const capturedUpdates = [];

  try {
    const beforeDoc = {
      _id: id,
      title: 'Original Title',
      description: 'Original Summary',
      content: '<p>Original</p>',
      category: 'national',
      status: 'draft',
      lang: 'en',
      language: 'en',
      slug: 'original-title',
      slugs: { en: 'original-title', hi: null, gu: null },
      tags: [],
      translationGroupId: 'tg-1',
      workflowStage: 'DRAFT',
    };

    News.findById = () => ({
      select: () => ({
        lean: async () => beforeDoc,
      }),
    });

    News.findByIdAndUpdate = async (_id, op) => {
      capturedUpdates.push(op);
      const docLike = {
        ...beforeDoc,
        ...(op && op.$set ? op.$set : {}),
      };

      // Mongoose-doc-like surface area used by the route.
      docLike.save = async () => docLike;
      docLike.toObject = () => ({ ...docLike });

      return docLike;
    };

    PublicArticle.findOneAndUpdate = () => ({
      lean: async () => ({ ok: true }),
    });

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'undefined', tags: 'x' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.ok(capturedUpdates.length >= 1, 'expected News.findByIdAndUpdate to be called');

    const firstOp = capturedUpdates[0];
    assert.ok(firstOp && firstOp.$set && typeof firstOp.$set === 'object', 'expected first update op to use $set');
    assert.equal(Object.prototype.hasOwnProperty.call(firstOp.$set, 'title'), false, 'should not $set title');
  } finally {
    News.findById = prevFindById;
    News.findByIdAndUpdate = prevFindByIdAndUpdate;
    PublicArticle.findOneAndUpdate = prevPublicFindOneAndUpdate;
  }
});
