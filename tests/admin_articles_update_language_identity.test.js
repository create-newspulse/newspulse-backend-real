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
  const id = overrides._id || '507f1f77bcf86cd799439a01';
  const groupKey = overrides.translationGroupId === undefined ? 'tg-update-language-1' : overrides.translationGroupId;
  return {
    _id: id,
    title: 'Existing title',
    description: 'Existing summary',
    content: '<p>Existing content</p>',
    category: 'national',
    status: 'draft',
    workflowStage: 'DRAFT',
    slug: 'existing-title',
    slugs: { en: 'existing-title', hi: 'existing-title-hi', gu: 'existing-title-gu' },
    tags: [],
    language: 'en',
    lang: 'en',
    originalLang: 'en',
    translationGroupId: groupKey,
    translationKey: groupKey,
    sourceArticleId: '507f1f77bcf86cd799439fff',
    syncVersion: 0,
    ...overrides,
  };
}

function makeDoc(record) {
  const doc = { ...record };
  doc.save = async () => doc;
  doc.toObject = () => {
    const out = { ...doc };
    delete out.save;
    delete out.toObject;
    return out;
  };
  return doc;
}

function installUpdateStubs(t, beforeDoc, options = {}) {
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

  News.findById = () => ({ select: () => ({ lean: async () => beforeDoc }) });
  News.find = () => queryResult([]);
  News.updateMany = async () => ({ acknowledged: true, modifiedCount: 0 });
  News.findOne = (query) => {
    findOneQueries.push(query);
    return queryResult(typeof options.duplicateForQuery === 'function' ? options.duplicateForQuery(query) : null);
  };
  News.findByIdAndUpdate = async (id, op) => {
    updates.push({ id: String(id), op });
    return makeDoc({ ...beforeDoc, ...(op && op.$set ? op.$set : {}) });
  };
  PublicArticle.findOneAndUpdate = () => ({ lean: async () => ({ _id: 'public-sync' }) });
  Contributor.findById = () => ({ lean: async () => ({ _id: '507f1f77bcf86cd799439b01', status: 'active', canonicalName: 'Pulse Contributor' }) });

  return { updates, findOneQueries };
}

function putArticle(id, body) {
  return request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send(body);
}

function restoreDraft(id, body = {}) {
  return request(app)
    .post(`/api/admin/drafts/${id}/restore`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send(body);
}

function assertNoIdentityRewrite(updateOp) {
  assert.equal(Object.prototype.hasOwnProperty.call(updateOp.$set || {}, 'language'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updateOp.$set || {}, 'lang'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updateOp.$set || {}, 'originalLang'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updateOp.$set || {}, 'translationGroupId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updateOp.$set || {}, 'translationKey'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(updateOp.$set || {}, 'sourceArticleId'), false);
}

function hasLanguageClause(query, lang) {
  return JSON.stringify(query).includes(`"language":"${lang}"`)
    || JSON.stringify(query).includes(`"lang":"${lang}"`);
}

function excludesDeletedStatus(query) {
  return JSON.stringify(query).includes('"status":{"$ne":"deleted"}');
}

function assertSingleActiveSlotQuery(stubs, lang) {
  assert.equal(stubs.findOneQueries.length, 1);
  assert.equal(hasLanguageClause(stubs.findOneQueries[0], lang), true);
  assert.equal(excludesDeletedStatus(stubs.findOneQueries[0]), true);
}

function installDraftRestoreStubs(t, draftDoc, options = {}) {
  const originals = {
    findById: News.findById,
    findOne: News.findOne,
  };
  const findOneQueries = [];
  let saveCount = 0;
  const doc = makeDoc(draftDoc);
  doc.save = async () => {
    saveCount += 1;
    return doc;
  };

  t.after(() => {
    News.findById = originals.findById;
    News.findOne = originals.findOne;
  });

  News.findById = async () => doc;
  News.findOne = (query) => {
    findOneQueries.push(query);
    return queryResult(typeof options.duplicateForQuery === 'function' ? options.duplicateForQuery(query) : null);
  };

  return { doc, findOneQueries, get saveCount() { return saveCount; } };
}

test('PUT existing EN article edit does not perform a false duplicate-language conflict', async (t) => {
  const id = '507f1f77bcf86cd799439a11';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'en', lang: 'en', originalLang: 'en' }));

  const res = await putArticle(id, { content: '<p>Edited English body</p>', language: 'en' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'en');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT existing HI article with missing language but lang=hi ignores stale default English payload', async (t) => {
  const id = '507f1f77bcf86cd799439a12';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: undefined, lang: 'hi', originalLang: 'hi' }));

  const res = await putArticle(id, { content: '<p>Edited Hindi body</p>', language: 'en' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'hi');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT existing GU article with missing language but lang=gu ignores stale default English payload', async (t) => {
  const id = '507f1f77bcf86cd799439a13';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: undefined, lang: 'gu', originalLang: 'gu' }));

  const res = await putArticle(id, { content: '<p>Edited Gujarati body</p>', language: 'en' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'gu');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT existing translated article can use originalLang fallback without false conflict', async (t) => {
  const id = '507f1f77bcf86cd799439a14';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: undefined, lang: undefined, originalLang: 'hi' }));

  const res = await putArticle(id, { content: '<p>Edited originalLang fallback body</p>', language: 'en' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'hi');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT existing HI article explicitly changed to EN returns genuine duplicate 409 when EN sibling exists', async (t) => {
  const id = '507f1f77bcf86cd799439a15';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'hi', lang: 'hi', originalLang: 'hi' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'en')
      ? { _id: '507f1f77bcf86cd799439a16', language: 'en', lang: 'en', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited body</p>', language: 'en' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT existing GU article explicitly changed to HI returns genuine duplicate 409 when HI sibling exists', async (t) => {
  const id = '507f1f77bcf86cd799439a17';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'hi')
      ? { _id: '507f1f77bcf86cd799439a18', language: 'hi', lang: 'hi', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited body</p>', language: 'hi' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT published GU edit succeeds when only same-group GU duplicate is soft-deleted', async (t) => {
  const id = '507f1f77bcf86cd799439a22';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu', status: 'published' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu') && !excludesDeletedStatus(query)
      ? { _id: '507f1f77bcf86cd799439c22', language: 'gu', lang: 'gu', status: 'deleted', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited Gujarati published body</p>', language: 'gu' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'gu');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT published HI edit succeeds when only same-group HI duplicate is soft-deleted', async (t) => {
  const id = '507f1f77bcf86cd799439a23';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'hi', lang: 'hi', originalLang: 'hi', status: 'published' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'hi') && !excludesDeletedStatus(query)
      ? { _id: '507f1f77bcf86cd799439c23', language: 'hi', lang: 'hi', status: 'deleted', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited Hindi published body</p>', language: 'hi' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'hi');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT published EN edit succeeds when only same-group EN duplicate is soft-deleted', async (t) => {
  const id = '507f1f77bcf86cd799439a24';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'en', lang: 'en', originalLang: 'en', status: 'published' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'en') && !excludesDeletedStatus(query)
      ? { _id: '507f1f77bcf86cd799439c24', language: 'en', lang: 'en', status: 'deleted', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited English published body</p>', language: 'en' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'en');
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT language change ignores soft-deleted same-language duplicate but query excludes deleted records', async (t) => {
  const id = '507f1f77bcf86cd799439a25';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'en', lang: 'en', originalLang: 'en' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu') && !excludesDeletedStatus(query)
      ? { _id: '507f1f77bcf86cd799439c25', language: 'gu', lang: 'gu', status: 'deleted', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited body</p>', language: 'gu' });

  assert.equal(res.statusCode, 200);
  assert.equal(stubs.findOneQueries.length, 1);
  assert.equal(excludesDeletedStatus(stubs.findOneQueries[0]), true);
  assert.equal(stubs.updates[0].op.$set.language, 'gu');
  assert.equal(stubs.updates[0].op.$set.lang, 'gu');
});

test('PUT published GU changed into existing active GU slot returns genuine 409', async (t) => {
  const id = '507f1f77bcf86cd799439a26';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'hi', lang: 'hi', originalLang: 'hi', status: 'published' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu')
      ? { _id: '507f1f77bcf86cd799439c26', language: 'gu', lang: 'gu', status: 'published', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited body</p>', language: 'gu' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT ordinary published GU edit returns 409 when active GU duplicate exists', async (t) => {
  const id = '507f1f77bcf86cd799439a2a';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu', status: 'published' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu')
      ? { _id: '507f1f77bcf86cd799439c2a', language: 'gu', lang: 'gu', status: 'draft', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Ordinary Gujarati edit</p>', language: 'gu' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT ordinary draft HI edit returns 409 when active HI duplicate exists', async (t) => {
  const id = '507f1f77bcf86cd799439a2b';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'hi', lang: 'hi', originalLang: 'hi', status: 'draft' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'hi')
      ? { _id: '507f1f77bcf86cd799439c2b', language: 'hi', lang: 'hi', status: 'published', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Ordinary Hindi edit</p>', language: 'hi' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT ordinary published EN edit returns 409 when active EN duplicate exists', async (t) => {
  const id = '507f1f77bcf86cd799439a2c';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'en', lang: 'en', originalLang: 'en', status: 'published' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'en')
      ? { _id: '507f1f77bcf86cd799439c2c', language: 'en', lang: 'en', status: 'draft', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Ordinary English edit</p>', language: 'en' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT draft HI changed into existing published HI slot returns genuine 409', async (t) => {
  const id = '507f1f77bcf86cd799439a27';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'en', lang: 'en', originalLang: 'en', status: 'draft' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'hi')
      ? { _id: '507f1f77bcf86cd799439c27', language: 'hi', lang: 'hi', status: 'published', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { content: '<p>Edited body</p>', language: 'hi' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT restore of deleted GU returns 409 when active GU sibling already exists', async (t) => {
  const id = '507f1f77bcf86cd799439a28';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu', status: 'deleted' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu')
      ? { _id: '507f1f77bcf86cd799439c28', language: 'gu', lang: 'gu', status: 'published', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { status: 'draft' });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.updates.length, 0);
});

test('PUT restore of deleted GU succeeds when no active GU sibling exists', async (t) => {
  const id = '507f1f77bcf86cd799439a29';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu', status: 'deleted' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu') && !excludesDeletedStatus(query)
      ? { _id: '507f1f77bcf86cd799439c29', language: 'gu', lang: 'gu', status: 'deleted', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await putArticle(id, { status: 'draft' });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'gu');
  assert.equal(stubs.updates[0].op.$set.status, 'draft');
});

test('POST draft restore of deleted GU returns 409 when active GU sibling exists', async (t) => {
  const id = '507f1f77bcf86cd799439a2d';
  const stubs = installDraftRestoreStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu', status: 'deleted' }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu')
      ? { _id: '507f1f77bcf86cd799439c2d', language: 'gu', lang: 'gu', status: 'published', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await restoreDraft(id);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /translationGroupId and language/i);
  assert.equal(stubs.saveCount, 0);
});

test('POST draft restore of deleted GU succeeds when only GU duplicate is soft-deleted', async (t) => {
  const id = '507f1f77bcf86cd799439a2e';
  const stubs = installDraftRestoreStubs(t, makeArticle({ _id: id, language: 'gu', lang: 'gu', originalLang: 'gu', status: 'deleted', deletedAt: new Date() }), {
    duplicateForQuery: (query) => (hasLanguageClause(query, 'gu') && !excludesDeletedStatus(query)
      ? { _id: '507f1f77bcf86cd799439c2e', language: 'gu', lang: 'gu', status: 'deleted', translationGroupId: 'tg-update-language-1' }
      : null),
  });

  const res = await restoreDraft(id);

  assert.equal(res.statusCode, 200);
  assert.equal(stubs.findOneQueries.length, 1);
  assert.equal(hasLanguageClause(stubs.findOneQueries[0], 'gu'), true);
  assert.equal(excludesDeletedStatus(stubs.findOneQueries[0]), true);
  assert.equal(stubs.doc.status, 'draft');
  assert.equal(stubs.doc.deletedAt, null);
  assert.equal(stubs.saveCount, 1);
});

test('PUT duplicate validation query excludes the current article id', async (t) => {
  const id = '507f1f77bcf86cd799439a19';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: 'en', lang: 'en', originalLang: 'en' }));

  const res = await putArticle(id, { content: '<p>Edited body</p>', language: 'hi' });

  assert.equal(res.statusCode, 200);
  assert.equal(stubs.findOneQueries.length, 1);
  assert.deepEqual(stubs.findOneQueries[0]._id, { $ne: id });
});

test('PUT ordinary edit leaves translation identity fields unchanged', async (t) => {
  const id = '507f1f77bcf86cd799439a20';
  const stubs = installUpdateStubs(t, makeArticle({ _id: id, language: undefined, lang: 'hi', originalLang: 'hi', sourceArticleId: '507f1f77bcf86cd799439aaa' }));

  const res = await putArticle(id, { summary: 'Edited summary', language: 'en' });

  assert.equal(res.statusCode, 200);
  assertNoIdentityRewrite(stubs.updates[0].op);
});

test('PUT Pulse Dialogue ordinary edit does not trigger false language conflict', async (t) => {
  const id = '507f1f77bcf86cd799439a21';
  const contributorId = '507f1f77bcf86cd799439b01';
  const stubs = installUpdateStubs(t, makeArticle({
    _id: id,
    category: 'pulse-dialogue',
    language: undefined,
    lang: 'gu',
    originalLang: 'gu',
    pulseDialogue: { contributorId, dialogueFormat: 'essay', series: 'Original series' },
  }));

  const res = await putArticle(id, {
    content: '<p>Edited Pulse Dialogue body</p>',
    language: 'en',
    pulseDialogue: { contributorId, series: 'Updated series' },
  });

  assert.equal(res.statusCode, 200);
  assertSingleActiveSlotQuery(stubs, 'gu');
  assertNoIdentityRewrite(stubs.updates[0].op);
  assert.equal(stubs.updates[0].op.$set['pulseDialogue.series'], 'Updated series');
});