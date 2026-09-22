const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const { buildPublicCategoryFilter, isSupportedPublicCategory } = require('../lib/categories');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');

const NEW_CATEGORY_VALUES = ['faith-culture', 'pulse-dialogue', 'tech-gadgets'];
const EXISTING_CATEGORY_VALUES = ['national', 'business', 'lifestyle', 'editorial', 'sports'];

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
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

test('public category filtering recognizes existing and new category slugs', () => {
  for (const category of ['national', ...NEW_CATEGORY_VALUES]) {
    assert.equal(isSupportedPublicCategory(category, PublicArticle.CATEGORY_VALUES), true);
    const filter = buildPublicCategoryFilter(category);
    assert.ok(filter instanceof RegExp);
    assert.equal(filter.test(category), true);
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