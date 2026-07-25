const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeOpaqueFounderToken() {
  return makeOpaqueAdminToken('founder@example.com');
}

function makeQueryResult(doc, capture) {
  return {
    select(arg) {
      if (capture) capture.selectArg = arg;
      return this;
    },
    lean: async () => doc,
  };
}

function makeFindResult(docs) {
  return {
    select() { return this; },
    lean: async () => docs,
  };
}

function makeDoc(obj) {
  const doc = {
    ...obj,
    save: async () => doc,
    toObject: () => ({ ...doc }),
    toJSON: () => ({ ...doc }),
  };
  return doc;
}

function baseArticle(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439201',
    title: 'English Title',
    description: 'English summary',
    content: 'English body',
    slug: 'english-title',
    slugs: { en: 'english-title', hi: 'hindi-title', gu: 'gujarati-title' },
    category: 'national',
    status: 'published',
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    translationGroupId: 'grp-gujarati-1',
    publishedAt: new Date('2026-07-25T09:00:00.000Z'),
    createdAt: new Date('2026-07-25T08:00:00.000Z'),
    ...overrides,
  };
}

test('News and Article models canonicalize Gujarati language aliases to gu', async () => {
  const news = new News({
    title: 'ગુજરાતી લેખ',
    description: 'સારાંશ',
    content: 'મુખ્ય લખાણ',
    category: 'national',
    slug: 'gujarati-alias-news',
    language: 'Gujarati',
    lang: 'gu-IN',
  });
  await news.validate();
  assert.equal(news.language, 'gu');
  assert.equal(news.lang, 'gu');

  const publicArticle = new PublicArticle({
    title: 'ગુજરાતી લેખ',
    summary: 'સારાંશ',
    content: 'મુખ્ય લખાણ',
    category: 'national',
    slug: 'gujarati-alias-public',
    language: 'gj',
    sourceLanguage: 'gu',
  });
  await publicArticle.validate();
  assert.equal(publicArticle.language, 'gu');
});

test('POST /api/articles creates Gujarati draft with language=gu', async () => {
  const prevFindOne = News.findOne;
  const prevCreate = News.create;
  const created = [];

  try {
    News.findOne = () => makeQueryResult(null);
    News.create = async (payload) => {
      created.push(payload);
      return makeDoc({ ...payload, _id: '507f1f77bcf86cd799439211' });
    };

    const res = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        title: 'ગુજરાતી ડ્રાફ્ટ',
        summary: 'ગુજરાતી સારાંશ',
        content: 'ગુજરાતી લેખનું મુખ્ય લખાણ',
        category: 'national',
        language: 'gu',
        translationGroupId: 'grp-create-gu-1',
        sourceArticleId: '507f1f77bcf86cd799439299',
        slug: 'gujarati-draft-create',
        status: 'draft',
      });

    assert.equal(res.status, 201);
    assert.equal(created.length, 1);
    assert.equal(created[0].language, 'gu');
    assert.equal(created[0].lang, 'gu');
    assert.equal(created[0].status, 'draft');
    assert.equal(created[0].translationGroupId, 'grp-create-gu-1');
    assert.equal(created[0].sourceArticleId, '507f1f77bcf86cd799439299');
  } finally {
    News.findOne = prevFindOne;
    News.create = prevCreate;
  }
});

test('POST /api/articles prevents duplicate translationGroupId + language records', async () => {
  const prevFindOne = News.findOne;
  const prevCreate = News.create;
  let findOneCalls = 0;
  let createCalled = false;

  try {
    News.findOne = () => {
      findOneCalls += 1;
      return makeQueryResult(findOneCalls === 1 ? null : { _id: '507f1f77bcf86cd799439212', language: 'gu' });
    };
    News.create = async () => {
      createCalled = true;
      return null;
    };

    const res = await request(app)
      .post('/api/articles')
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        title: 'ડુપ્લિકેટ ગુજરાતી',
        summary: 'સારાંશ',
        content: 'મુખ્ય લખાણ',
        category: 'national',
        language: 'Gujarati',
        translationGroupId: 'grp-duplicate-gu-1',
        slug: 'duplicate-gujarati',
        status: 'draft',
      });

    assert.equal(res.status, 409);
    assert.match(res.body.message, /translationGroupId and language/i);
    assert.equal(createCalled, false);
  } finally {
    News.findOne = prevFindOne;
    News.create = prevCreate;
  }
});

test('POST /api/articles/:id/publish publishes Gujarati article without changing its language', async () => {
  const id = '507f1f77bcf86cd799439221';
  const prevFindById = News.findById;
  const prevFindOne = News.findOne;
  const prevPublicFindOneAndUpdate = PublicArticle.findOneAndUpdate;
  const prevPublicUpdateMany = PublicArticle.updateMany;
  const prevPushCreate = PushHistory.create;

  try {
    const doc = makeDoc({
      _id: 'gujarati-publish-test-doc',
      title: 'ગુજરાતી પ્રકાશિત',
      description: 'ગુજરાતી સારાંશ',
      content: 'ગુજરાતી લેખનું મુખ્ય લખાણ',
      category: 'national',
      slug: 'gujarati-publish',
      slugs: { gu: 'gujarati-publish' },
      language: 'gu',
      lang: 'gu',
      originalLang: 'gu',
      status: 'draft',
      workflowStage: 'DRAFT',
      translationGroupId: 'grp-publish-gu-1',
      sourceArticleId: '507f1f77bcf86cd799439299',
    });

    News.findById = async () => doc;
    News.findOne = () => makeQueryResult(null);
    PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-gu-1' }) });
    PublicArticle.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
    PushHistory.create = async () => ({ _id: 'push-1' });

    const res = await request(app)
      .post(`/api/articles/${id}/publish`)
      .set('Authorization', `Bearer ${makeOpaqueFounderToken()}`)
      .send();

    assert.equal(res.status, 200);
    assert.equal(doc.status, 'published');
    assert.equal(doc.language, 'gu');
    assert.equal(doc.lang, 'gu');
    assert.equal(res.body.article.language, 'gu');
  } finally {
    News.findById = prevFindById;
    News.findOne = prevFindOne;
    PublicArticle.findOneAndUpdate = prevPublicFindOneAndUpdate;
    PublicArticle.updateMany = prevPublicUpdateMany;
    PushHistory.create = prevPushCreate;
  }
});

test('Public detail resolves EN, HI, and GU sibling records from one translation group', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;
  const prevFind = News.find;

  try {
    mongoose.connection.readyState = 1;

    const en = baseArticle();
    const hi = baseArticle({
      _id: '507f1f77bcf86cd799439202',
      title: 'हिंदी शीर्षक',
      description: 'हिंदी सारांश',
      content: 'हिंदी सामग्री',
      slug: 'hindi-title',
      language: 'hi',
      lang: 'hi',
      originalLang: 'hi',
    });
    const gu = baseArticle({
      _id: '507f1f77bcf86cd799439203',
      title: 'ગુજરાતી શીર્ષક',
      description: 'ગુજરાતી સારાંશ',
      content: 'ગુજરાતી મુખ્ય લખાણ',
      slug: 'gujarati-title',
      language: 'gu',
      lang: 'gu',
      originalLang: 'gu',
    });
    const groupDocs = [en, hi, gu];
    News.find = () => makeFindResult(groupDocs);

    async function fetchLang(lang) {
      let call = 0;
      News.findOne = () => {
        call += 1;
        if (call === 1) return makeQueryResult(en);
        if (lang === 'hi') return makeQueryResult(hi);
        if (lang === 'gu') return makeQueryResult(gu);
        return makeQueryResult(null);
      };
      return request(app).get(`/api/public/news/english-title?lang=${lang}`);
    }

    const enRes = await fetchLang('en');
    assert.equal(enRes.status, 200);
    assert.equal(enRes.body.title, 'English Title');
    assert.equal(enRes.body.language, 'en');
    assert.equal(enRes.body.resolvedLang, 'en');
    assert.deepEqual(enRes.body.translationAvailability.translations, { en: true, hi: true, gu: true });

    const hiRes = await fetchLang('hi');
    assert.equal(hiRes.status, 200);
    assert.equal(hiRes.body.title, 'हिंदी शीर्षक');
    assert.equal(hiRes.body.language, 'hi');
    assert.equal(hiRes.body.resolvedLang, 'hi');
    assert.equal(hiRes.body.isTranslated, false);
    assert.deepEqual(hiRes.body.translationAvailability.translations, { en: true, hi: true, gu: true });

    const guRes = await fetchLang('gu');
    assert.equal(guRes.status, 200);
    assert.equal(guRes.body.title, 'ગુજરાતી શીર્ષક');
    assert.equal(guRes.body.content, 'ગુજરાતી મુખ્ય લખાણ');
    assert.equal(guRes.body.language, 'gu');
    assert.equal(guRes.body.resolvedLang, 'gu');
    assert.equal(guRes.body.isTranslated, false);
    assert.equal(guRes.body.requestedLanguage, 'gu');
    assert.equal(guRes.body.resolvedLanguage, 'gu');
    assert.equal(guRes.body.isFallback, false);
    assert.deepEqual(guRes.body.translations, { en: true, hi: true, gu: true });
    assert.deepEqual(guRes.body.translationAvailability.translations, { en: true, hi: true, gu: true });

    let guSlugCall = 0;
    News.findOne = () => {
      guSlugCall += 1;
      return makeQueryResult(guSlugCall === 1 ? gu : null);
    };
    const guSlugRes = await request(app).get('/api/public/news/gujarati-title?lang=gu');
    assert.equal(guSlugRes.status, 200);
    assert.equal(guSlugRes.body.title, 'ગુજરાતી શીર્ષક');
    assert.equal(guSlugRes.body.language, 'gu');
    assert.equal(guSlugRes.body.canonicalSlug, 'gujarati-title');
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.findOne = prevFindOne;
    News.find = prevFind;
  }
});

test('Missing Gujarati sibling falls back without pretending content language is Gujarati', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;
  const prevFind = News.find;

  try {
    mongoose.connection.readyState = 1;
    let call = 0;
    News.findOne = () => {
      call += 1;
      return makeQueryResult(call === 1 ? baseArticle() : null);
    };
    News.find = () => makeFindResult([baseArticle()]);

    const missingRes = await request(app).get('/api/public/news/english-title?lang=gu');
    assert.equal(missingRes.status, 404);
    assert.deepEqual(missingRes.body.translationAvailability.translations, { en: true, hi: false, gu: false });

    call = 0;
    const res = await request(app).get('/api/public/news/english-title?lang=gu&fallback=true');
    assert.equal(res.status, 200);
    assert.equal(res.body.title, 'English Title');
    assert.equal(res.body.requestedLang, 'gu');
    assert.equal(res.body.resolvedLang, 'en');
    assert.equal(res.body.resolvedLanguage, 'en');
    assert.equal(res.body.language, 'en');
    assert.equal(res.body.isFallback, true);
    assert.equal(res.body.isTranslated, false);
    assert.equal(res.body.translationAvailability.translations.gu, false);
    assert.equal(res.body.translationAvailability.fallbackEnabled, true);
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.findOne = prevFindOne;
    News.find = prevFind;
  }
});

test('Gujarati draft, scheduled, archived, and deleted stories are not returned publicly', async () => {
  const prevReadyState = mongoose.connection.readyState;
  const prevFindOne = News.findOne;
  const prevPublicFindOne = PublicArticle.findOne;
  const capturedFilters = [];

  try {
    mongoose.connection.readyState = 1;
    News.findOne = (filter) => {
      capturedFilters.push(filter);
      return makeQueryResult(null);
    };
    PublicArticle.findOne = () => makeQueryResult(null);

    for (const slug of ['gu-draft', 'gu-scheduled', 'gu-archived', 'gu-deleted']) {
      const res = await request(app).get(`/api/public/news/${slug}?lang=gu`);
      assert.equal(res.status, 404);
    }

    assert.ok(capturedFilters.length >= 3);
    for (const filter of capturedFilters) {
      const serialized = JSON.stringify(filter);
      assert.match(serialized, /published/);
      assert.match(serialized, /publishedAt/);
      assert.match(serialized, /deletedAt/);
    }
  } finally {
    mongoose.connection.readyState = prevReadyState;
    News.findOne = prevFindOne;
    PublicArticle.findOne = prevPublicFindOne;
  }
});

test('Updating Gujarati article does not modify English or Hindi siblings', async () => {
  const id = '507f1f77bcf86cd799439231';
  const prevFindById = News.findById;
  const prevFindByIdAndUpdate = News.findByIdAndUpdate;
  const prevFindOne = News.findOne;
  const updates = [];

  try {
    const gu = baseArticle({
      _id: id,
      title: 'જૂનું ગુજરાતી',
      description: 'જૂનો સારાંશ',
      content: 'જૂનું લખાણ',
      slug: 'old-gujarati',
      language: 'gu',
      lang: 'gu',
      originalLang: 'gu',
      status: 'draft',
      workflowStage: 'DRAFT',
      sourceArticleId: '507f1f77bcf86cd799439299',
    });

    News.findById = () => ({ select: () => ({ lean: async () => gu }) });
    News.findOne = () => makeQueryResult(null);
    News.findByIdAndUpdate = async (targetId, op) => {
      updates.push({ targetId, op });
      return makeDoc({ ...gu, ...(op.$set || {}) });
    };

    const res = await request(app)
      .put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
      .send({
        title: 'નવું ગુજરાતી',
        summary: 'નવો સારાંશ',
        content: 'નવું મુખ્ય લખાણ',
        language: 'gu',
      });

    assert.equal(res.status, 200);
    assert.ok(updates.length >= 1);
    assert.ok(updates.every((update) => update.targetId === id));
    const languageUpdate = updates.find((update) => update.op?.$set?.language === 'gu');
    assert.ok(languageUpdate);
    assert.equal(languageUpdate.op.$set.title, 'નવું ગુજરાતી');
    assert.equal(languageUpdate.op.$set.lang, 'gu');
  } finally {
    News.findById = prevFindById;
    News.findByIdAndUpdate = prevFindByIdAndUpdate;
    News.findOne = prevFindOne;
  }
});

test('Publish-all-languages validates complete EN HI GU group before changing statuses', async () => {
  const id = '507f1f77bcf86cd799439241';
  const prevFindById = News.findById;
  const prevFind = News.find;

  try {
    const en = makeDoc(baseArticle({ _id: id, status: 'draft', workflowStage: 'DRAFT' }));
    const hi = makeDoc(baseArticle({
      _id: '507f1f77bcf86cd799439242',
      title: 'हिंदी शीर्षक',
      description: 'हिंदी सारांश',
      content: 'हिंदी सामग्री',
      slug: 'hindi-title',
      language: 'hi',
      lang: 'hi',
      originalLang: 'hi',
      status: 'draft',
      workflowStage: 'DRAFT',
    }));
    const guIncomplete = makeDoc(baseArticle({
      _id: '507f1f77bcf86cd799439243',
      title: 'ગુજરાતી શીર્ષક',
      description: '',
      content: 'ગુજરાતી મુખ્ય લખાણ',
      slug: 'gujarati-title',
      language: 'gu',
      lang: 'gu',
      originalLang: 'gu',
      status: 'draft',
      workflowStage: 'DRAFT',
    }));

    News.findById = async () => en;
    News.find = async () => [en, hi, guIncomplete];

    const res = await request(app)
      .post(`/api/articles/${id}/publish-all-languages`)
      .set('Authorization', `Bearer ${makeOpaqueFounderToken()}`)
      .send();

    assert.equal(res.status, 400);
    assert.deepEqual(res.body.invalidRecords, [{ language: 'gu', id: '507f1f77bcf86cd799439243', missingFields: ['summary'] }]);
    assert.equal(en.status, 'draft');
    assert.equal(hi.status, 'draft');
    assert.equal(guIncomplete.status, 'draft');
  } finally {
    News.findById = prevFindById;
    News.find = prevFind;
  }
});

test('Publish-all-languages publishes complete EN HI GU group together', async () => {
  const id = '507f1f77bcf86cd799439251';
  const prevFindById = News.findById;
  const prevFind = News.find;
  const prevPublicFindOneAndUpdate = PublicArticle.findOneAndUpdate;
  const saved = [];

  try {
    const en = makeDoc(baseArticle({ _id: id, status: 'draft', workflowStage: 'DRAFT' }));
    const hi = makeDoc(baseArticle({
      _id: '507f1f77bcf86cd799439252',
      title: 'हिंदी शीर्षक',
      description: 'हिंदी सारांश',
      content: 'हिंदी सामग्री',
      slug: 'hindi-title',
      language: 'hi',
      lang: 'hi',
      originalLang: 'hi',
      status: 'draft',
      workflowStage: 'DRAFT',
    }));
    const gu = makeDoc(baseArticle({
      _id: '507f1f77bcf86cd799439253',
      title: 'ગુજરાતી શીર્ષક',
      description: 'ગુજરાતી સારાંશ',
      content: 'ગુજરાતી મુખ્ય લખાણ',
      slug: 'gujarati-title',
      language: 'gu',
      lang: 'gu',
      originalLang: 'gu',
      status: 'draft',
      workflowStage: 'DRAFT',
    }));
    for (const doc of [en, hi, gu]) {
      doc.save = async () => {
        saved.push(String(doc._id));
        return doc;
      };
    }

    News.findById = async () => en;
    News.find = async () => [en, hi, gu];
    PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-sync' }) });

    const res = await request(app)
      .post(`/api/articles/${id}/publish-all-languages`)
      .set('Authorization', `Bearer ${makeOpaqueFounderToken()}`)
      .send({ reason: 'complete group' });

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.publishedLanguages.sort(), ['en', 'gu', 'hi']);
    assert.equal(saved.length, 3);
    for (const doc of [en, hi, gu]) {
      assert.equal(doc.status, 'published');
      assert.equal(doc.workflowStage, 'PUBLISHED');
      assert.ok(doc.publishedAt instanceof Date);
    }
  } finally {
    News.findById = prevFindById;
    News.find = prevFind;
    PublicArticle.findOneAndUpdate = prevPublicFindOneAndUpdate;
  }
});
