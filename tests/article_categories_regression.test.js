const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const { buildPublicCategoryFilter, getCanonicalPublicCategoryKey, isSupportedPublicCategory } = require('../lib/categories');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');

const NEW_CATEGORY_VALUES = ['faith-culture', 'pulse-dialogue', 'tech-gadgets'];
const EXISTING_CATEGORY_VALUES = ['national', 'business', 'lifestyle', 'editorial', 'sports', 'tech'];

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function matchesCategoryFilter(filterValue, category) {
  if (!filterValue) return true;
  const value = String(category || '');
  if (filterValue instanceof RegExp) return filterValue.test(value);
  return filterValue === value;
}

function makeArticleQuery(items) {
  return {
    sort() { return this; },
    skip() { return this; },
    limit() { return this; },
    lean: async () => items,
  };
}

function makeNewsDoc(overrides = {}) {
  const doc = {
    _id: overrides._id || '507f1f77bcf86cd799439801',
    title: overrides.title || 'Category regression title',
    description: overrides.description || 'Category regression summary',
    content: overrides.content || '<p>Category regression body</p>',
    slug: overrides.slug || 'category-regression-title',
    slugs: overrides.slugs || { en: overrides.slug || 'category-regression-title' },
    category: overrides.category || 'national',
    status: overrides.status || 'draft',
    language: overrides.language || 'en',
    lang: overrides.lang || overrides.language || 'en',
    originalLang: overrides.originalLang || overrides.language || 'en',
    translationGroupId: overrides.translationGroupId || 'category-regression-group',
    translationKey: overrides.translationKey || overrides.translationGroupId || 'category-regression-group',
    workflowStage: overrides.workflowStage || 'DRAFT',
    workflowHistory: Array.isArray(overrides.workflowHistory) ? overrides.workflowHistory : [],
    saveCount: 0,
    ...overrides,
  };
  doc.save = async () => {
    doc.saveCount += 1;
    return doc;
  };
  doc.toObject = () => ({ ...doc });
  doc.toJSON = () => ({ ...doc });
  return doc;
}

function makePublishDoc(lang, overrides = {}) {
  const labels = {
    en: ['Tech Gadgets English', 'Tech Gadgets summary', '<p>Tech Gadgets body</p>', 'tech-gadgets-english'],
    hi: ['टेक गैजेट्स हिंदी', 'टेक गैजेट्स सारांश', '<p>टेक गैजेट्स लेख</p>', 'tech-gadgets-hindi'],
    gu: ['ટેક ગેજેટ્સ ગુજરાતી', 'ટેક ગેજેટ્સ સારાંશ', '<p>ટેક ગેજેટ્સ લેખ</p>', 'tech-gadgets-gujarati'],
  };
  const [title, description, content, slug] = labels[lang];
  return makeNewsDoc({
    _id: `507f1f77bcf86cd7994398${lang === 'en' ? '01' : lang === 'hi' ? '02' : '03'}`,
    title,
    description,
    content,
    slug,
    slugs: { [lang]: slug },
    category: 'tech-gadgets',
    language: lang,
    lang,
    originalLang: lang,
    sourceArticleId: lang === 'en' ? undefined : '507f1f77bcf86cd799439801',
    ...overrides,
  });
}

test('Article category enum keeps existing categories and accepts new categories across statuses', async () => {
  for (const category of [...EXISTING_CATEGORY_VALUES, ...NEW_CATEGORY_VALUES]) {
    assert.equal(PublicArticle.CATEGORY_VALUES.includes(category), true, `${category} should be configured`);
  }

  const statuses = ['draft', 'published', 'scheduled', 'archived', 'deleted'];
  for (const category of NEW_CATEGORY_VALUES) {
    for (const status of statuses) {
      const doc = new PublicArticle({
        title: `Article ${category} ${status}`,
        slug: `article-${category}-${status}`,
        summary: 'Summary',
        content: 'Body',
        category,
        status,
        language: 'en',
        sourceLanguage: 'en',
      });
      await doc.validate();
    }
  }

  const existing = new PublicArticle({
    title: 'Existing national article',
    slug: 'existing-national-article',
    summary: 'Summary',
    content: 'Body',
    category: 'national',
    status: 'published',
    language: 'en',
    sourceLanguage: 'en',
  });
  await existing.validate();
});

test('public category filtering recognizes existing and new category slugs without merging tech and tech-gadgets', () => {
  for (const category of ['national', 'tech', ...NEW_CATEGORY_VALUES]) {
    assert.equal(isSupportedPublicCategory(category, PublicArticle.CATEGORY_VALUES), true);
    const filter = buildPublicCategoryFilter(category);
    assert.ok(filter instanceof RegExp);
    assert.equal(filter.test(category), true);
  }

  assert.equal(getCanonicalPublicCategoryKey('science-technology'), 'tech');
  assert.equal(getCanonicalPublicCategoryKey('tech-gadgets'), 'tech-gadgets');

  const scienceTechnologyFilter = buildPublicCategoryFilter('tech');
  const techGadgetsFilter = buildPublicCategoryFilter('tech-gadgets');
  assert.equal(scienceTechnologyFilter.test('tech'), true);
  assert.equal(scienceTechnologyFilter.test('science-technology'), true);
  assert.equal(scienceTechnologyFilter.test('tech-gadgets'), false);
  assert.equal(techGadgetsFilter.test('tech-gadgets'), true);
  assert.equal(techGadgetsFilter.test('tech'), false);
  assert.equal(techGadgetsFilter.test('science-technology'), false);
});

test('GET /api/public/stories keeps Science Technology tech articles separate from tech-gadgets', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFind = PublicArticle.find;

  try {
    mongoose.connection.readyState = 1;

    const docs = [
      { _id: '507f1f77bcf86cd799439821', title: 'Science Technology Story', summary: 'Science summary', content: 'Science body', slug: 'science-technology-story', category: 'tech', status: 'published', language: 'en', originalLang: 'en', publishedAt: new Date('2026-01-01T00:00:00.000Z') },
      { _id: '507f1f77bcf86cd799439822', title: 'Tech Gadgets Story', summary: 'Gadgets summary', content: 'Gadgets body', slug: 'tech-gadgets-story', category: 'tech-gadgets', status: 'published', language: 'en', originalLang: 'en', publishedAt: new Date('2026-01-02T00:00:00.000Z') },
    ];

    PublicArticle.find = (query) => {
      if (!query || !query.category) return makeArticleQuery([]);
      return makeArticleQuery(docs.filter((doc) => matchesCategoryFilter(query.category, doc.category)));
    };

    const scienceRes = await request(app).get('/api/public/stories?category=tech&lang=en&limit=10');
    assert.equal(scienceRes.status, 200);
    assert.deepEqual(scienceRes.body.data.map((item) => item.category), ['tech']);
    assert.deepEqual(scienceRes.body.data.map((item) => item.slug), ['science-technology-story']);

    const gadgetsRes = await request(app).get('/api/public/stories?category=tech-gadgets&lang=en&limit=10');
    assert.equal(gadgetsRes.status, 200);
    assert.deepEqual(gadgetsRes.body.data.map((item) => item.category), ['tech-gadgets']);
    assert.deepEqual(gadgetsRes.body.data.map((item) => item.slug), ['tech-gadgets-story']);
  } finally {
    PublicArticle.find = prevFind;
    mongoose.connection.readyState = prevReadyState;
  }
});

test('POST /api/articles saves a faith-culture draft through the existing draft flow', async () => {
  const prevFindOne = News.findOne;
  const prevCreate = News.create;
  const created = [];

  try {
    News.findOne = () => ({ select: () => ({ lean: async () => null }) });
    News.create = async (payload) => {
      created.push(payload);
      return makeNewsDoc({ ...payload, _id: '507f1f77bcf86cd799439811' });
    };

    const res = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        title: 'Faith Culture Draft',
        summary: 'Faith Culture summary',
        content: '<p>Faith Culture body</p>',
        category: 'faith-culture',
        status: 'draft',
        language: 'en',
        sourceArticleId: '507f1f77bcf86cd799439899',
      });

    assert.equal(res.status, 201);
    assert.equal(created.length, 1);
    assert.equal(created[0].category, 'faith-culture');
    assert.equal(created[0].status, 'draft');
  } finally {
    News.findOne = prevFindOne;
    News.create = prevCreate;
  }
});

test('publish workflow syncs tech-gadgets through the existing public article path', async () => {
  const docs = [makePublishDoc('en'), makePublishDoc('hi'), makePublishDoc('gu')];
  const originals = {
    newsFind: News.find,
    publicFindOneAndUpdate: PublicArticle.findOneAndUpdate,
    publicUpdateMany: PublicArticle.updateMany,
    pushCreate: PushHistory.create,
  };
  const publicUpdates = [];

  try {
    News.find = async () => docs;
    PublicArticle.findOneAndUpdate = (_filter, update) => {
      publicUpdates.push(update.$set);
      return { lean: async () => ({ _id: 'public-tech-gadgets' }) };
    };
    PublicArticle.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    PushHistory.create = async () => ({ _id: 'push-tech-gadgets' });

    const result = await publishCanonicalArticle(docs[0], {
      req: { admin: { role: 'Founder', isFounder: true, email: 'founder@example.com' }, body: { reason: 'category regression' } },
      source: 'category-regression-test',
      groupPublish: true,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.publishedLanguages.sort(), ['en', 'gu', 'hi']);
    assert.equal(docs.every((doc) => doc.status === 'published'), true);
    assert.equal(publicUpdates.length, 3);
    assert.deepEqual(Array.from(new Set(publicUpdates.map((update) => update.category))), ['tech-gadgets']);
  } finally {
    News.find = originals.newsFind;
    PublicArticle.findOneAndUpdate = originals.publicFindOneAndUpdate;
    PublicArticle.updateMany = originals.publicUpdateMany;
    PushHistory.create = originals.pushCreate;
  }
});