const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const News = require('../models/News');

process.env.NODE_ENV = 'test';

const app = require('../server');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

test('PUT /api/articles/:id applies sponsored article fields on admin updates', async () => {
  const id = '507f1f77bcf86cd799439112';
  const linkedFeatureId = '507f1f77bcf86cd799439113';

  const prevFindById = News.findById;
  const prevFindByIdAndUpdate = News.findByIdAndUpdate;

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
      originalLang: 'en',
      slug: 'original-title',
      slugs: { en: 'original-title', hi: null, gu: null },
      tags: [],
      translationGroupId: 'tg-sponsored-1',
      workflowStage: 'DRAFT',
      syncVersion: 0,
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
      docLike.save = async () => docLike;
      docLike.toObject = () => ({ ...docLike });
      return docLike;
    };

    const token = makeOpaqueAdminToken();
    const res = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        isSponsoredArticle: true,
        sponsorName: 'Acme Corp',
        sponsorDisclosure: 'Presented by Acme Corp',
        sponsorCtaText: 'Learn More',
        sponsorCtaUrl: 'https://example.com/sponsored',
        sponsorFeatureEligible: 'true',
        sponsorFeatureLinkedId: linkedFeatureId,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(capturedUpdates.length >= 1, 'expected News.findByIdAndUpdate to be called');

    const firstOp = capturedUpdates[0];
    assert.ok(firstOp && firstOp.$set && typeof firstOp.$set === 'object', 'expected first update op to use $set');
    assert.equal(firstOp.$set.isSponsored, true);
    assert.equal(firstOp.$set.isSponsoredArticle, true);
    assert.equal(firstOp.$set.sponsorName, 'Acme Corp');
    assert.equal(firstOp.$set.sponsorLabel, 'Sponsored');
    assert.equal(firstOp.$set.sponsorDisclosure, 'Presented by Acme Corp');
    assert.equal(firstOp.$set.sponsorCtaText, 'Learn More');
    assert.equal(firstOp.$set.sponsorCtaUrl, 'https://example.com/sponsored');
    assert.equal(firstOp.$set.sponsorFeatureEligible, true);
    assert.equal(firstOp.$set.sponsorFeatureLinkedId, linkedFeatureId);
  } finally {
    News.findById = prevFindById;
    News.findByIdAndUpdate = prevFindByIdAndUpdate;
  }
});