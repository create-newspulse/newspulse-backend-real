const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeOpaqueFounderToken() {
  return makeOpaqueAdminToken('founder@example.com');
}

function makeChainableQuery(items, capture = {}) {
  return {
    sort(arg) {
      capture.sortArg = arg;
      return this;
    },
    skip(n) {
      capture.skip = n;
      return this;
    },
    limit(n) {
      capture.limit = n;
      return this;
    },
    select(arg) {
      capture.selectArg = arg;
      return this;
    },
    lean: async () => items,
  };
}

function makeDoc(obj) {
  return {
    ...obj,
    save: async () => obj,
    toObject: () => ({ ...obj }),
    toJSON: () => ({ ...obj }),
  };
}

test('Article schemas default editorialType for editorial and clear stale values for normal news', async () => {
  const editorial = new News({
    title: 'Editorial',
    description: 'Summary',
    content: 'Body',
    category: 'editorial',
    slug: 'editorial-schema-default',
    language: 'en',
    lang: 'en',
  });
  await editorial.validate();
  assert.equal(editorial.editorialType, 'editorial');

  const special = new News({
    title: 'Special',
    description: 'Summary',
    content: 'Body',
    category: 'editorial',
    editorialType: 'special_story',
    slug: 'special-schema-type',
    language: 'en',
    lang: 'en',
  });
  await special.validate();
  assert.equal(special.editorialType, 'special_story');

  const normal = new News({
    title: 'National',
    description: 'Summary',
    content: 'Body',
    category: 'national',
    editorialType: 'special_story',
    slug: 'normal-clears-editorial-type',
    language: 'en',
    lang: 'en',
  });
  await normal.validate();
  assert.equal(normal.editorialType, undefined);

  const invalid = new News({
    title: 'Invalid',
    description: 'Summary',
    content: 'Body',
    category: 'editorial',
    editorialType: 'profile',
    slug: 'invalid-editorial-type',
    language: 'en',
    lang: 'en',
  });
  await assert.rejects(() => invalid.validate(), /editorialType/);

  const publicEditorial = new PublicArticle({
    title: 'Public Editorial',
    summary: 'Summary',
    content: 'Body',
    category: 'editorial',
    slug: 'public-editorial-schema-default',
    language: 'en',
    sourceLanguage: 'en',
  });
  await publicEditorial.validate();
  assert.equal(publicEditorial.editorialType, 'editorial');
});

test('POST /api/articles validates editorialType and leaves normal news unchanged', async () => {
  const prevFindOne = News.findOne;
  const prevCreate = News.create;
  const created = [];

  try {
    News.findOne = () => ({ select: () => ({ lean: async () => null }) });
    News.create = async (doc) => {
      created.push(doc);
      return makeDoc({ ...doc, _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439101') });
    };

    const token = makeOpaqueAdminToken();
    const basePayload = {
      title: 'Editorial Create',
      summary: 'Editorial summary',
      content: '<p>Editorial body</p>',
      sourceArticleId: '507f1f77bcf86cd799439199',
      language: 'en',
    };

    const editorialRes = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...basePayload, category: 'editorial', editorialType: 'editorial' });
    assert.equal(editorialRes.status, 201);
    assert.equal(created.at(-1).category, 'editorial');
    assert.equal(created.at(-1).editorialType, 'editorial');

    const specialRes = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...basePayload, title: 'Special Create', category: 'editorial', editorialType: 'special_story' });
    assert.equal(specialRes.status, 201);
    assert.equal(created.at(-1).editorialType, 'special_story');

    const defaultRes = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...basePayload, title: 'Default Editorial', category: 'editorial' });
    assert.equal(defaultRes.status, 201);
    assert.equal(created.at(-1).editorialType, 'editorial');

    const invalidRes = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...basePayload, title: 'Invalid Editorial', category: 'editorial', editorialType: 'profile' });
    assert.equal(invalidRes.status, 400);
    assert.match(invalidRes.body.message, /editorialType/i);

    const normalRes = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...basePayload, title: 'Normal News', category: 'national', editorialType: 'special_story' });
    assert.equal(normalRes.status, 201);
    assert.equal(Object.prototype.hasOwnProperty.call(created.at(-1), 'editorialType'), false);
  } finally {
    News.findOne = prevFindOne;
    News.create = prevCreate;
  }
});

test('PUT /api/articles clears stale editorialType and blocks unsupported values', async () => {
  const id = '507f1f77bcf86cd799439111';
  const prevFindById = News.findById;
  const prevFindByIdAndUpdate = News.findByIdAndUpdate;
  const updates = [];

  try {
    const before = {
      _id: id,
      title: 'Editorial Draft',
      description: 'Summary',
      content: 'Body',
      category: 'editorial',
      editorialType: 'special_story',
      status: 'draft',
      workflowStage: 'DRAFT',
      slug: 'editorial-draft',
      language: 'en',
      lang: 'en',
      sourceArticleId: '507f1f77bcf86cd799439199',
    };

    News.findById = () => ({ select: () => ({ lean: async () => before }) });
    News.findByIdAndUpdate = async (_id, op) => {
      updates.push(op);
      return makeDoc({ ...before, ...(op.$set || {}), category: 'national', editorialType: undefined });
    };

    const token = makeOpaqueAdminToken();
    const clearRes = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'national' });
    assert.equal(clearRes.status, 200);
    assert.deepEqual(updates[0].$unset, { editorialType: '' });

    const invalidRes = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ category: 'editorial', editorialType: 'profile' });
    assert.equal(invalidRes.status, 400);
    assert.match(invalidRes.body.message, /editorialType/i);
  } finally {
    News.findById = prevFindById;
    News.findByIdAndUpdate = prevFindByIdAndUpdate;
  }
});

test('Draft Desk supports category=editorial and source filters without duplicating records', async () => {
  const prevFind = News.find;
  const prevCount = News.countDocuments;
  const captures = [];

  try {
    News.find = (query) => {
      captures.push(query);
      const source = query.source || 'editor';
      return makeChainableQuery([
        {
          _id: '507f1f77bcf86cd799439121',
          title: `${source} editorial`,
          language: 'en',
          category: 'editorial',
          status: 'draft',
          source,
          createdAt: new Date('2026-07-25T10:00:00.000Z'),
        },
      ]);
    };
    News.countDocuments = async () => 1;

    const token = makeOpaqueAdminToken();
    const categoryRes = await request(app)
      .get('/api/admin/drafts?category=editorial')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(categoryRes.status, 200);
    assert.deepEqual(captures.at(-1), { status: 'draft', category: 'editorial' });
    assert.equal(categoryRes.body.data.length, 1);
    assert.equal(categoryRes.body.data[0].editorialType, 'editorial');

    const founderRes = await request(app)
      .get('/api/admin/drafts?source=founder')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(founderRes.status, 200);
    assert.deepEqual(captures.at(-1), { status: 'draft', source: 'founder' });
    assert.equal(founderRes.body.data[0].source, 'founder');

    const editorRes = await request(app)
      .get('/api/admin/drafts?source=editor')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(editorRes.status, 200);
    assert.deepEqual(captures.at(-1), { status: 'draft', source: 'editor' });
    assert.equal(editorRes.body.data[0].source, 'editor');
  } finally {
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('Manage News category=editorial returns editorialType fallback', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = News.find;
  const prevCount = News.countDocuments;
  let capturedQuery = null;

  try {
    mongoose.connection.readyState = 1;
    News.find = (query) => {
      capturedQuery = query;
      return makeChainableQuery([
        {
          _id: '507f1f77bcf86cd799439131',
          title: 'Manage Editorial',
          description: 'Summary',
          category: 'editorial',
          status: 'draft',
          updatedAt: new Date('2026-07-25T10:00:00.000Z'),
        },
      ]);
    };
    News.countDocuments = async () => 1;

    const res = await request(app)
      .get('/api/articles?category=editorial')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`);

    assert.equal(res.status, 200);
    assert.equal(String(capturedQuery.category), '/^(?:editorial)$/i');
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].editorialType, 'editorial');
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.find = prevFind;
    News.countDocuments = prevCount;
  }
});

test('Public editorial listing returns only visible published editorial articles with editorialType', async () => {
  const prevFind = News.find;
  const capturedQueries = [];

  try {
    const past = new Date('2026-07-25T09:00:00.000Z');
    const docs = [
      {
        _id: '507f1f77bcf86cd799439141',
        title: 'Public Editorial',
        description: 'Summary',
        content: 'Body',
        category: 'editorial',
        status: 'published',
        slug: 'public-editorial',
        slugs: { en: 'public-editorial' },
        language: 'en',
        lang: 'en',
        originalLang: 'en',
        publishedAt: past,
        createdAt: past,
      },
      {
        _id: '507f1f77bcf86cd799439142',
        title: 'Public Special',
        description: 'Summary',
        content: 'Body',
        category: 'editorial',
        editorialType: 'special_story',
        status: 'published',
        slug: 'public-special',
        slugs: { en: 'public-special' },
        language: 'en',
        lang: 'en',
        originalLang: 'en',
        publishedAt: past,
        createdAt: past,
      },
    ];

    News.find = (query) => {
      capturedQueries.push(query);
      const isCategoryQuery = Object.prototype.hasOwnProperty.call(query, 'category');
      return makeChainableQuery(isCategoryQuery ? docs : []);
    };

    const res = await request(app).get('/api/public/articles?category=editorial&limit=10');

    assert.equal(res.status, 200);
    assert.equal(res.body.data.items.length, 2);
    assert.deepEqual(res.body.data.items.map((item) => item.editorialType).sort(), ['editorial', 'special_story']);
    assert.equal(String(capturedQueries[0].category), '/^(?:editorial)$/i');

    const visibilityFilter = buildPubliclyVisibleNewsArticleFilter({ now: new Date('2026-07-25T10:00:00.000Z') });
    assert.ok(JSON.stringify(visibilityFilter).includes('publishedAt'));
  } finally {
    News.find = prevFind;
  }
});

test('syncPublicArticleFromNews preserves editorialType and defaults missing editorial type', async () => {
  const prevFindOneAndUpdate = PublicArticle.findOneAndUpdate;
  const updates = [];

  try {
    PublicArticle.findOneAndUpdate = (_query, update) => {
      updates.push(update.$set);
      return { lean: async () => ({ _id: 'public-editorial-sync' }) };
    };

    await syncPublicArticleFromNews({
      _id: '507f1f77bcf86cd799439151',
      title: 'Synced Editorial',
      description: 'Summary',
      content: 'Body',
      category: 'editorial',
      status: 'published',
      slug: 'synced-editorial',
      language: 'en',
      lang: 'en',
      originalLang: 'en',
    });
    assert.equal(updates.at(-1).editorialType, 'editorial');

    await syncPublicArticleFromNews({
      _id: '507f1f77bcf86cd799439152',
      title: 'Synced Special',
      description: 'Summary',
      content: 'Body',
      category: 'editorial',
      editorialType: 'special_story',
      status: 'published',
      slug: 'synced-special',
      language: 'en',
      lang: 'en',
      originalLang: 'en',
    });
    assert.equal(updates.at(-1).editorialType, 'special_story');

    await syncPublicArticleFromNews({
      _id: '507f1f77bcf86cd799439153',
      title: 'Synced National',
      description: 'Summary',
      content: 'Body',
      category: 'national',
      editorialType: 'special_story',
      status: 'published',
      slug: 'synced-national',
      language: 'en',
      lang: 'en',
      originalLang: 'en',
    });
    assert.equal(updates.at(-1).editorialType, undefined);
  } finally {
    PublicArticle.findOneAndUpdate = prevFindOneAndUpdate;
  }
});

test('Unauthorized publishing returns founder permission 403', async () => {
  const id = '507f1f77bcf86cd799439161';
  const prevFindById = News.findById;
  const prevFindByIdAndUpdate = News.findByIdAndUpdate;
  let updateCalled = false;

  try {
    const before = {
      _id: id,
      title: 'Editorial Draft',
      description: 'Summary',
      content: 'Body',
      category: 'editorial',
      editorialType: 'editorial',
      status: 'draft',
      workflowStage: 'DRAFT',
      slug: 'editorial-draft-publish',
      language: 'en',
      lang: 'en',
      sourceArticleId: '507f1f77bcf86cd799439199',
    };
    News.findById = () => ({ select: () => ({ lean: async () => before }) });
    News.findByIdAndUpdate = async () => {
      updateCalled = true;
      return null;
    };

    const token = makeOpaqueAdminToken();
    const updatePublishRes = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status: 'published' });
    assert.equal(updatePublishRes.status, 403);
    assert.equal(updatePublishRes.body.message, 'Access Denied. Founder permission is required.');
    assert.equal(updateCalled, false);

    const directPublishRes = await request(app)
      .post(`/api/articles/${id}/publish`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    assert.equal(directPublishRes.status, 403);
    assert.equal(directPublishRes.body.message, 'Access Denied. Founder permission is required.');

    assert.ok(makeOpaqueFounderToken(), 'founder token helper remains available for founder-only route tests');
  } finally {
    News.findById = prevFindById;
    News.findByIdAndUpdate = prevFindByIdAndUpdate;
  }
});
