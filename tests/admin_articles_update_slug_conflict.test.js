const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const Contributor = require('../models/Contributor');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function queryResult(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
    catch(reject) { return Promise.resolve(value).catch(reject); },
  };
}

function makeArticle(overrides = {}) {
  const lang = overrides.language || overrides.lang || 'en';
  const id = overrides._id || '507f1f77bcf86cd79943b001';
  const groupKey = overrides.translationGroupId === undefined ? 'tg-slug-update-1' : overrides.translationGroupId;
  return {
    _id: id,
    title: 'Existing title',
    description: 'Existing summary',
    content: '<p>Existing content</p>',
    category: 'national',
    status: 'draft',
    workflowStage: 'DRAFT',
    slug: `existing-${lang}-slug`,
    slugs: { [lang]: `existing-${lang}-slug` },
    tags: [],
    language: lang,
    lang,
    originalLang: lang,
    translationGroupId: groupKey,
    translationKey: groupKey,
    sourceArticleId: lang === 'en' ? null : '507f1f77bcf86cd79943b0ff',
    syncVersion: 0,
    ...overrides,
  };
}

function makeDoc(record) {
  const doc = { ...record, slugs: { ...(record.slugs || {}) } };
  doc.save = async () => doc;
  doc.toObject = () => {
    const out = { ...doc };
    delete out.save;
    delete out.toObject;
    return out;
  };
  return doc;
}

function applySet(doc, set = {}) {
  const next = { ...doc, slugs: { ...(doc.slugs || {}) } };
  for (const [key, value] of Object.entries(set)) {
    if (key.startsWith('slugs.')) {
      const lang = key.slice('slugs.'.length);
      next.slugs[lang] = value;
    } else {
      next[key] = value;
    }
  }
  return next;
}

function installArticleUpdateStubs(t, beforeDoc, options = {}) {
  const originals = {
    findById: News.findById,
    findByIdAndUpdate: News.findByIdAndUpdate,
    findOne: News.findOne,
    find: News.find,
    updateMany: News.updateMany,
    publicFindOneAndUpdate: PublicArticle.findOneAndUpdate,
    contributorFindById: Contributor.findById,
  };
  const updates = [];
  const findOneQueries = [];

  t.after(() => {
    News.findById = originals.findById;
    News.findByIdAndUpdate = originals.findByIdAndUpdate;
    News.findOne = originals.findOne;
    News.find = originals.find;
    News.updateMany = originals.updateMany;
    PublicArticle.findOneAndUpdate = originals.publicFindOneAndUpdate;
    Contributor.findById = originals.contributorFindById;
  });

  let stored = { ...beforeDoc, slugs: { ...(beforeDoc.slugs || {}) } };
  News.findById = () => ({ select: () => ({ lean: async () => stored }) });
  News.find = () => queryResult([]);
  News.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
  News.findOne = (query) => {
    findOneQueries.push(query);
    if (query && Object.prototype.hasOwnProperty.call(query, 'slug')) {
      return queryResult(typeof options.duplicateForSlugQuery === 'function' ? options.duplicateForSlugQuery(query) : null);
    }
    return queryResult(null);
  };
  News.findByIdAndUpdate = async (id, op) => {
    updates.push({ id: String(id), op });
    stored = applySet(stored, op && op.$set ? op.$set : {});
    return makeDoc(stored);
  };
  PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-sync' }) });
  Contributor.findById = () => ({ lean: async () => ({ _id: '507f1f77bcf86cd79943b099', status: 'active', canonicalName: 'Pulse Contributor' }) });

  return { updates, findOneQueries, getStored: () => stored };
}

function installCreateStubs(t, options = {}) {
  const originals = {
    findOne: News.findOne,
    create: News.create,
  };
  const findOneQueries = [];
  let createCalls = 0;

  t.after(() => {
    News.findOne = originals.findOne;
    News.create = originals.create;
  });

  News.findOne = (query) => {
    findOneQueries.push(query);
    if (query && Object.prototype.hasOwnProperty.call(query, 'slug')) {
      return queryResult(typeof options.duplicateForSlugQuery === 'function' ? options.duplicateForSlugQuery(query) : null);
    }
    return queryResult(null);
  };
  News.create = async (payload) => {
    createCalls += 1;
    return makeDoc({ _id: '507f1f77bcf86cd79943b777', ...payload });
  };

  return { findOneQueries, getCreateCalls: () => createCalls };
}

function putArticle(id, body) {
  return request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send(body);
}

function postArticle(body) {
  return request(app)
    .post('/api/articles')
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send(body);
}

function slugQueries(stubs) {
  return stubs.findOneQueries.filter((query) => query && Object.prototype.hasOwnProperty.call(query, 'slug'));
}

function assertTranslationIdentityUnchanged(updateOp) {
  const set = updateOp.$set || {};
  assert.equal(Object.prototype.hasOwnProperty.call(set, 'language'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(set, 'lang'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(set, 'originalLang'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(set, 'translationGroupId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(set, 'translationKey'), false);
}

test('PUT existing article save with unchanged slug succeeds without slug duplicate lookup', async (t) => {
  const id = '507f1f77bcf86cd79943b101';
  const stubs = installArticleUpdateStubs(t, makeArticle({ _id: id, slug: 'my-existing-slug', slugs: { en: 'my-existing-slug' } }));

  const res = await putArticle(id, { summary: 'Edited summary only' });

  assert.equal(res.statusCode, 200);
  assert.equal(slugQueries(stubs).length, 0);
  assert.equal(stubs.updates[0].op.$set.slug, undefined);
  assert.equal(stubs.getStored().slug, 'my-existing-slug');
});

test('PUT existing article changed headline/content with same explicit slug succeeds and excludes current id', async (t) => {
  const id = '507f1f77bcf86cd79943b102';
  const stubs = installArticleUpdateStubs(t, makeArticle({ _id: id, slug: 'my-existing-slug', slugs: { en: 'my-existing-slug' } }));

  const res = await putArticle(id, {
    title: 'Changed headline',
    content: '<p>Changed content</p>',
    slug: 'my-existing-slug',
  });

  assert.equal(res.statusCode, 200);
  const queries = slugQueries(stubs);
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]._id, { $ne: id });
  assert.equal(queries[0].slug, 'my-existing-slug');
  assert.equal(stubs.updates[0].op.$set.slug, 'my-existing-slug');
});

test('PUT article changed to another article slug still returns slug conflict', async (t) => {
  const id = '507f1f77bcf86cd79943b103';
  const otherId = '507f1f77bcf86cd79943b104';
  const stubs = installArticleUpdateStubs(t, makeArticle({ _id: id, slug: 'story-two', slugs: { en: 'story-two' } }), {
    duplicateForSlugQuery: (query) => (query.slug === 'story-one' ? { _id: otherId, slug: 'story-one' } : null),
  });

  const res = await putArticle(id, { slug: 'story-one' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /Slug already exists/);
  assert.equal(stubs.updates.length, 0);
});

test('POST new article with duplicate slug keeps create-time slug protection', async (t) => {
  const stubs = installCreateStubs(t, {
    duplicateForSlugQuery: (query) => (query.slug === 'story-one' ? { _id: '507f1f77bcf86cd79943b105', slug: 'story-one' } : null),
  });

  const res = await postArticle({
    title: 'Story One',
    summary: 'Summary',
    content: '<p>Body</p>',
    category: 'national',
    language: 'en',
    slug: 'story-one',
  });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /Slug already exists/);
  assert.equal(stubs.getCreateCalls(), 0);
  assert.equal(slugQueries(stubs).length, 1);
});

test('PUT EN HI and GU existing translations ordinary edits preserve slugs and translation identity', async (t) => {
  for (const lang of ['en', 'hi', 'gu']) {
    await t.test(`${lang} ordinary edit`, async (t) => {
      const id = `507f1f77bcf86cd79943b20${lang === 'en' ? '1' : lang === 'hi' ? '2' : '3'}`;
      const slug = `existing-${lang}-slug`;
      const stubs = installArticleUpdateStubs(t, makeArticle({ _id: id, language: lang, lang, originalLang: lang, slug, slugs: { [lang]: slug } }));

      const res = await putArticle(id, { content: `<p>Edited ${lang} body</p>` });

      assert.equal(res.statusCode, 200);
      assert.equal(slugQueries(stubs).length, 0);
      assert.equal(stubs.getStored().slug, slug);
      assertTranslationIdentityUnchanged(stubs.updates[0].op);
    });
  }
});

test('PUT Pulse Dialogue ordinary edit/save succeeds with unchanged slug and untouched identity', async (t) => {
  const id = '507f1f77bcf86cd79943b301';
  const contributorId = '507f1f77bcf86cd79943b099';
  const stubs = installArticleUpdateStubs(t, makeArticle({
    _id: id,
    category: 'pulse-dialogue',
    language: 'gu',
    lang: 'gu',
    originalLang: 'gu',
    slug: 'pulse-dialogue-gu',
    slugs: { gu: 'pulse-dialogue-gu' },
    pulseDialogue: { contributorId, dialogueFormat: 'essay', series: 'Original series' },
  }));

  const res = await putArticle(id, {
    content: '<p>Edited Pulse Dialogue body</p>',
    pulseDialogue: { contributorId, series: 'Updated series' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(slugQueries(stubs).length, 0);
  assert.equal(stubs.getStored().slug, 'pulse-dialogue-gu');
  assertTranslationIdentityUnchanged(stubs.updates[0].op);
  assert.equal(stubs.updates[0].op.$set['pulseDialogue.series'], 'Updated series');
});