const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || 'test-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeOpaqueFounderToken() {
  return makeOpaqueAdminToken('founder@example.com');
}

function makeDoc(overrides = {}) {
  const doc = {
    _id: overrides._id || '507f1f77bcf86cd799439901',
    title: 'English title',
    description: 'English summary',
    content: '<p>English body</p>',
    slug: 'english-title',
    slugs: { en: 'english-title' },
    category: 'national',
    status: 'draft',
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    translationGroupId: 'grp-publish-pipeline',
    translationKey: 'grp-publish-pipeline',
    workflowStage: 'DRAFT',
    workflowHistory: [],
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

function makeLanguageDoc(lang, overrides = {}) {
  const labels = {
    en: ['English title', 'English summary', '<p>English body</p>', 'english-title'],
    hi: ['हिंदी शीर्षक', 'हिंदी सारांश', '<p>हिंदी सामग्री</p>', 'hindi-title'],
    gu: ['ગુજરાતી શીર્ષક', 'ગુજરાતી સારાંશ', '<p>ગુજરાતી લેખ</p>', 'gujarati-title'],
  };
  const [title, description, content, slug] = labels[lang];
  return makeDoc({
    _id: `507f1f77bcf86cd7994399${lang === 'en' ? '01' : lang === 'hi' ? '02' : '03'}`,
    title,
    description,
    content,
    slug,
    slugs: { [lang]: slug },
    language: lang,
    lang,
    originalLang: lang,
    sourceArticleId: lang === 'en' ? undefined : '507f1f77bcf86cd799439901',
    ...overrides,
  });
}

function queryDoc(doc) {
  return {
    select() { return this; },
    lean: async () => doc,
    then(resolve, reject) { return Promise.resolve(doc).then(resolve, reject); },
    catch(reject) { return Promise.resolve(doc).catch(reject); },
  };
}

function restore(originals) {
  for (const item of originals) {
    for (const [key, value] of Object.entries(item.values)) item.target[key] = value;
  }
}

function installPublishMocks(t, docs, options = {}) {
  const originals = [
    {
      target: News,
      values: {
      findById: News.findById,
      find: News.find,
      findOne: News.findOne,
      create: News.create,
      updateOne: News.updateOne,
      },
    },
    {
      target: PublicArticle,
      values: {
      findOneAndUpdate: PublicArticle.findOneAndUpdate,
      updateMany: PublicArticle.updateMany,
      },
    },
    {
      target: PushHistory,
      values: {
      create: PushHistory.create,
      },
    },
  ];
  const prevFetch = global.fetch;
  const created = [];
  const pushHistory = [];
  let fetchCalls = 0;

  News.findById = async (id) => docs.find((doc) => String(doc._id) === String(id)) || docs[0] || null;
  News.find = async (query) => {
    const raw = JSON.stringify(query || {});
    const groupMatch = raw.match(/grp-[a-z0-9-]+/i);
    const groupKey = groupMatch ? groupMatch[0] : null;
    const excludedId = query && query._id && query._id.$ne ? String(query._id.$ne) : null;
    return docs.filter((doc) => {
      if (excludedId && String(doc._id) === excludedId) return false;
      if (groupKey && doc.translationGroupId !== groupKey && doc.translationKey !== groupKey) return false;
      return true;
    });
  };
  News.findOne = (query) => {
    const raw = JSON.stringify(query || {});
    const lang = ['en', 'hi', 'gu'].find((candidate) => raw.includes(`"language":"${candidate}"`) || raw.includes(`"lang":"${candidate}"`));
    const existing = lang ? docs.find((doc) => doc.language === lang || doc.lang === lang) : null;
    return queryDoc(existing || null);
  };
  News.updateOne = async () => ({ acknowledged: true, modifiedCount: 1 });
  News.create = async (payload) => {
    const ids = [
      '507f1f77bcf86cd799439911',
      '507f1f77bcf86cd799439912',
      '507f1f77bcf86cd799439913',
      '507f1f77bcf86cd799439914',
    ];
    const doc = makeDoc({
      _id: payload._id || ids[docs.length] || '507f1f77bcf86cd799439999',
      ...payload,
      workflowHistory: Array.isArray(payload.workflowHistory) ? payload.workflowHistory : [],
    });
    docs.push(doc);
    created.push(doc);
    return doc;
  };

  PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-sync' }) });
  PublicArticle.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
  PushHistory.create = async (payload) => {
    pushHistory.push(payload);
    return { _id: `push-${pushHistory.length}` };
  };
  global.fetch = async (_url, opts) => {
    fetchCalls += 1;
    if (options.failFetch) {
      return { ok: false, status: 500, json: async () => ({ error: { message: 'translation failed' } }) };
    }
    const body = JSON.parse(String(opts?.body || '{}'));
    const q = Array.isArray(body.q) ? body.q : [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { translations: q.map((value) => ({ translatedText: `${body.target}:${value}` })) } }),
    };
  };

  t.after(() => {
    restore(originals);
    global.fetch = prevFetch;
  });

  return { created, pushHistory, getFetchCalls: () => fetchCalls };
}

async function publishForTest(t, docs, options = {}) {
  const state = installPublishMocks(t, docs, options);
  const result = await publishCanonicalArticle(docs[0]._id, {
    req: { admin: { role: 'Founder', isFounder: true, email: 'founder@example.com' }, body: { reason: 'test publish' } },
    reason: 'test publish',
    source: 'test',
    groupPublish: options.groupPublish,
  });
  return { result, ...state };
}

test('canonical publish publishes a draft with all EN HI GU translations', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('hi'), makeLanguageDoc('gu')];
  const { result, created } = await publishForTest(t, docs, { groupPublish: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.equal(created.length, 0);
  for (const doc of docs) {
    assert.equal(doc.status, 'published');
    assert.equal(doc.workflowStage, 'PUBLISHED');
    assert.ok(doc.publishedAt instanceof Date);
  }
});

test('canonical publish generates missing Hindi translation before publishing', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('gu')];
  const { result, created } = await publishForTest(t, docs);

  assert.equal(result.ok, true);
  assert.deepEqual(created.map((doc) => doc.language), ['hi']);
  assert.deepEqual(docs.map((doc) => doc.status), ['published', 'published', 'published']);
});

test('canonical publish generates missing Gujarati translation before publishing', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('hi')];
  const { result, created } = await publishForTest(t, docs);

  assert.equal(result.ok, true);
  assert.deepEqual(created.map((doc) => doc.language), ['gu']);
  assert.deepEqual(docs.map((doc) => doc.status), ['published', 'published', 'published']);
});

test('canonical publish generates both missing translations before publishing', async (t) => {
  const docs = [makeLanguageDoc('en')];
  const { result, created } = await publishForTest(t, docs);

  assert.equal(result.ok, true);
  assert.deepEqual(created.map((doc) => doc.language).sort(), ['gu', 'hi']);
  assert.deepEqual(docs.map((doc) => doc.status), ['published', 'published', 'published']);
});

test('canonical publish reuses existing cached translations and retry does not duplicate them', async (t) => {
  const docs = [makeLanguageDoc('en', {
    translations: {
      hi: { title: 'कैश हिंदी', summary: 'कैश सारांश', content: '<p>कैश</p>', provider: 'manual', generatedAt: new Date() },
      gu: { title: 'કેશ ગુજરાતી', summary: 'કેશ સારાંશ', content: '<p>કેશ</p>', provider: 'manual', generatedAt: new Date() },
    },
  })];
  const state = installPublishMocks(t, docs);

  await publishCanonicalArticle(docs[0]._id, { req: { admin: { role: 'Founder', isFounder: true } }, source: 'first' });
  await publishCanonicalArticle(docs[0]._id, { req: { admin: { role: 'Founder', isFounder: true } }, source: 'retry' });

  assert.equal(state.getFetchCalls(), 0);
  assert.deepEqual(state.created.map((doc) => doc.language).sort(), ['gu', 'hi']);
  assert.equal(docs.filter((doc) => doc.language === 'hi').length, 1);
  assert.equal(docs.filter((doc) => doc.language === 'gu').length, 1);
  assert.equal(state.pushHistory.length, 1);
});

test('canonical publish failure leaves article drafts unpublished', async (t) => {
  const docs = [makeLanguageDoc('en'), makeLanguageDoc('gu')];
  installPublishMocks(t, docs, { failFetch: true });

  await assert.rejects(
    () => publishCanonicalArticle(docs[0]._id, { req: { admin: { role: 'Founder', isFounder: true } }, source: 'failure' }),
    /Failed to generate required translations/
  );
  assert.equal(docs[0].status, 'draft');
  assert.equal(docs[1].status, 'draft');
  assert.equal(docs[0].publishedAt, undefined);
  assert.equal(docs[1].publishedAt, undefined);
});

test('POST /api/articles/:id/publish preserves Founder authorization', async (t) => {
  const previousFindById = News.findById;
  let findByIdCalled = false;
  News.findById = async () => {
    findByIdCalled = true;
    return makeLanguageDoc('en');
  };
  t.after(() => { News.findById = previousFindById; });

  const res = await request(app)
    .post('/api/articles/507f1f77bcf86cd799439901/publish')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send();

  assert.equal(res.status, 403);
  assert.match(res.body.message, /Founder permission/);
  assert.equal(findByIdCalled, false);
});

test('POST /api/articles can direct-publish through the canonical pipeline for Founder', async (t) => {
  const docs = [];
  const state = installPublishMocks(t, docs);
  News.findById = async (id) => docs.find((doc) => String(doc._id) === String(id)) || null;

  const res = await request(app)
    .post('/api/articles')
    .set('Authorization', `Bearer ${makeOpaqueFounderToken()}`)
    .send({
      title: 'Direct publish source',
      summary: 'Direct publish summary',
      content: '<p>Direct publish body</p>',
      category: 'national',
      language: 'en',
      slug: 'direct-publish-source',
      translationGroupId: 'grp-direct-publish',
      status: 'published',
    });

  assert.equal(res.status, 201);
  assert.equal(res.body.article.status, 'published');
  assert.deepEqual(res.body.publishedLanguages.sort(), ['en', 'gu', 'hi']);
  assert.deepEqual(state.created.map((doc) => doc.language).sort(), ['en', 'gu', 'hi']);
});