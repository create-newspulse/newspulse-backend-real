const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const News = require('../models/News');
const PublicArticle = require('../models/Article');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('PUT /api/articles/:id must not downgrade published→draft (ignore status in payload)', async () => {
  const id = '507f1f77bcf86cd799439012';

  const prevFindById = News.findById;
  const prevFindByIdAndUpdate = News.findByIdAndUpdate;
  const prevFindOne = News.findOne;
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
      status: 'published',
      publishedAt: new Date('2025-01-01T00:00:00.000Z'),
      lang: 'en',
      language: 'en',
      slug: 'original-title',
      slugs: { en: 'original-title', hi: null, gu: null },
      tags: [],
      translationGroupId: 'tg-1',
      workflowStage: 'PUBLISHED',
    };

    News.findById = () => ({
      select: () => ({
        lean: async () => beforeDoc,
      }),
    });

    // Used by assertSlugUnique() when title updates regenerate slug.
    News.findOne = () => ({
      select: () => ({
        lean: async () => null,
      }),
    });

    News.findByIdAndUpdate = async (_id, op) => {
      capturedUpdates.push(op);
      const set = op && op.$set ? op.$set : {};
      const docLike = {
        ...beforeDoc,
        ...set,
      };

      docLike.toObject = () => ({ ...docLike });
      docLike.save = async () => docLike;
      return docLike;
    };

    PublicArticle.findOneAndUpdate = () => ({
      lean: async () => ({ ok: true }),
    });

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Updated Title', status: 'draft', tags: 'x' });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);

    assert.ok(capturedUpdates.length >= 1, 'expected News.findByIdAndUpdate to be called');

    const firstOp = capturedUpdates[0];
    assert.ok(firstOp && firstOp.$set && typeof firstOp.$set === 'object', 'expected first update op to use $set');
    assert.equal(Object.prototype.hasOwnProperty.call(firstOp.$set, 'status'), false, 'should not $set status');
  } finally {
    News.findById = prevFindById;
    News.findByIdAndUpdate = prevFindByIdAndUpdate;
    News.findOne = prevFindOne;
    PublicArticle.findOneAndUpdate = prevPublicFindOneAndUpdate;
  }
});
