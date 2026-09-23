const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PushHistory = require('../models/PushHistory');
const Contributor = require('../models/Contributor');

function makeOpaqueAdminToken(email = 'admin@newspulse.ai') {
  const b64 = Buffer.from(`${email}:0`, 'utf8').toString('base64');
  return `np.${b64}`;
}

function makeFounderToken() {
  return makeOpaqueAdminToken('founder@example.com');
}

function queryResult(value) {
  return {
    select() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
    catch(reject) { return Promise.resolve(value).catch(reject); },
  };
}

function makeNewsDoc(id, lang, overrides = {}) {
  const group = overrides.translationGroupId === undefined ? 'tg-soft-delete-1' : overrides.translationGroupId;
  const sourceArticleId = overrides.sourceArticleId === undefined
    ? (lang === 'en' ? null : '507f1f77bcf86cd79943d001')
    : overrides.sourceArticleId;

  return {
    _id: id,
    title: `${lang.toUpperCase()} title`,
    description: `${lang.toUpperCase()} summary`,
    content: `<p>${lang} body</p>`,
    slug: `story-${lang}`,
    slugs: { en: 'story-en', hi: 'story-hi', gu: 'story-gu' },
    category: 'national',
    status: 'published',
    workflowStage: 'PUBLISHED',
    workflowHistory: [],
    lang,
    language: lang,
    originalLang: lang,
    translationGroupId: group,
    translationKey: group,
    sourceArticleId,
    coverImage: { url: `https://cdn.example.test/${lang}.jpg`, publicId: `cover-${lang}`, alt: `${lang} cover` },
    coverImageUrl: `https://cdn.example.test/${lang}.jpg`,
    imageURL: `https://cdn.example.test/${lang}.jpg`,
    ...overrides,
  };
}

function toDocument(record) {
  const doc = { ...record };
  doc.saveCalls = 0;
  doc.save = async function save() {
    this.saveCalls += 1;
    return this;
  };
  doc.toObject = function toObject() {
    const out = { ...this };
    delete out.save;
    delete out.toObject;
    return out;
  };
  return doc;
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

function applyUpdate(record, update) {
  const next = { ...record };
  if (update && update.$set) {
    Object.assign(next, update.$set);
  }
  if (update && update.$push) {
    for (const [key, value] of Object.entries(update.$push)) {
      next[key] = Array.isArray(next[key]) ? next[key].slice() : [];
      next[key].push(value);
    }
  }
  return next;
}

function matchesGroup(doc, groupKey) {
  return String(doc.translationGroupId || '') === String(groupKey || '')
    || String(doc.translationKey || '') === String(groupKey || '');
}

function installRouteStubs(t, seedDocs, options = {}) {
  const records = new Map(seedDocs.map((doc) => [String(doc._id), cloneRecord(doc)]));
  const updates = [];
  const publicSyncs = [];
  const publicDraftSweeps = [];
  const pushCreates = [];
  const contributorMutations = [];
  const contributorFinds = [];
  const newsFindCalls = [];
  const contributorRecord = options.contributor || null;

  const originals = {
    News: {
      findById: News.findById,
      findOne: News.findOne,
      find: News.find,
      findByIdAndUpdate: News.findByIdAndUpdate,
    },
    PublicArticle: {
      findOneAndUpdate: PublicArticle.findOneAndUpdate,
      updateMany: PublicArticle.updateMany,
    },
    PushHistory: { create: PushHistory.create },
    Contributor: {
      findById: Contributor.findById,
      updateOne: Contributor.updateOne,
      updateMany: Contributor.updateMany,
      findByIdAndUpdate: Contributor.findByIdAndUpdate,
      deleteOne: Contributor.deleteOne,
      deleteMany: Contributor.deleteMany,
      findByIdAndDelete: Contributor.findByIdAndDelete,
    },
  };

  t.after(() => {
    Object.assign(News, originals.News);
    Object.assign(PublicArticle, originals.PublicArticle);
    Object.assign(PushHistory, originals.PushHistory);
    Object.assign(Contributor, originals.Contributor);
  });

  News.findById = (id) => queryResult(records.get(String(id)) || null);
  News.findOne = (query) => queryResult(typeof options.duplicateForQuery === 'function' ? options.duplicateForQuery(query, records) : null);
  News.find = (filter = {}) => {
    newsFindCalls.push(filter);
    if (filter && filter._id && filter._id.$ne) {
      return queryResult([]);
    }
    const groupKey = filter && Array.isArray(filter.$or)
      ? String((filter.$or.find((clause) => clause.translationGroupId)?.translationGroupId)
        || (filter.$or.find((clause) => clause.translationKey)?.translationKey)
        || '')
      : '';
    const docs = groupKey
      ? Array.from(records.values()).filter((doc) => matchesGroup(doc, groupKey))
      : [];
    return queryResult(docs);
  };
  News.findByIdAndUpdate = async (id, update, updateOptions) => {
    const key = String(id);
    const current = records.get(key);
    if (!current) return null;
    const next = applyUpdate(current, update);
    records.set(key, cloneRecord(next));
    const doc = toDocument(next);
    updates.push({ id: key, update, options: updateOptions, doc });
    return doc;
  };

  PublicArticle.findOneAndUpdate = (query, update, updateOptions) => {
    publicSyncs.push({ query, update, options: updateOptions });
    return { lean: async () => ({ _id: `public-${publicSyncs.length}` }) };
  };
  PublicArticle.updateMany = async (query, update, updateOptions) => {
    publicDraftSweeps.push({ query, update, options: updateOptions });
    return { acknowledged: true, modifiedCount: records.size };
  };
  PushHistory.create = async (payload) => {
    pushCreates.push(payload);
    return { _id: `push-${pushCreates.length}` };
  };

  Contributor.findById = (id) => {
    contributorFinds.push(String(id));
    return { lean: async () => (contributorRecord ? cloneRecord(contributorRecord) : null) };
  };
  for (const method of ['updateOne', 'updateMany', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findByIdAndDelete']) {
    Contributor[method] = async (...args) => {
      contributorMutations.push({ method, args });
      return { acknowledged: true, modifiedCount: 0, deletedCount: 0 };
    };
  }

  return {
    records,
    updates,
    publicSyncs,
    publicDraftSweeps,
    pushCreates,
    contributorFinds,
    contributorMutations,
    newsFindCalls,
  };
}

async function requestPutDeleted(id) {
  return request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'deleted' });
}

async function requestPutStatus(id, status) {
  return request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeFounderToken()}`)
    .send({ status });
}

async function requestPostUnpublish(id, body = {}) {
  return request(app)
    .post(`/api/articles/${id}/unpublish`)
    .set('Authorization', `Bearer ${makeFounderToken()}`)
    .send(body);
}

async function requestPostArchive(id) {
  return request(app)
    .post(`/api/articles/${id}/archive`)
    .set('Authorization', `Bearer ${makeFounderToken()}`)
    .send();
}

function assertAllRecordsHaveStatus(stubs, ids, status, workflowStage) {
  for (const id of Object.values(ids)) {
    const record = stubs.records.get(id);
    assert.equal(record.status, status);
    assert.equal(record.workflowStage, workflowStage);
    assert.equal(record.publishedAt, null);
    assert.equal(record.publishAt, null);
    assert.equal(record.scheduledAt, null);
  }
}

async function assertPutDeletesFullGroup(t, clickedLang) {
  const ids = {
    en: '507f1f77bcf86cd79943d001',
    hi: '507f1f77bcf86cd79943d002',
    gu: '507f1f77bcf86cd79943d003',
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { sourceArticleId: null }),
    makeNewsDoc(ids.hi, 'hi', { sourceArticleId: ids.en }),
    makeNewsDoc(ids.gu, 'gu', { sourceArticleId: ids.en }),
  ]);

  const res = await requestPutDeleted(ids[clickedLang]);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Article deleted');
  assert.equal(res.body.deletedCount, 3);
  assert.deepEqual(new Set(res.body.deletedIds), new Set(Object.values(ids)));
  assert.deepEqual(new Set(stubs.updates.map((entry) => entry.id)), new Set(Object.values(ids)));
  for (const id of Object.values(ids)) {
    const record = stubs.records.get(id);
    assert.equal(record.status, 'deleted');
    assert.equal(record.workflowStage, 'REJECTED');
    assert.ok(record.deletedAt, `expected deletedAt for ${id}`);
  }
}

test('PUT status=deleted on an EN+HI+GU story soft-deletes all three language docs', async (t) => {
  await assertPutDeletesFullGroup(t, 'en');
});

test('PUT status=deleted when clicked id is English source deletes the full group', async (t) => {
  await assertPutDeletesFullGroup(t, 'en');
});

test('PUT status=deleted when clicked id is Hindi translation deletes the full group', async (t) => {
  await assertPutDeletesFullGroup(t, 'hi');
});

test('PUT status=deleted when clicked id is Gujarati translation deletes the full group', async (t) => {
  await assertPutDeletesFullGroup(t, 'gu');
});

test('PUT status=deleted on legacy single-language article falls back to one soft-delete with metadata', async (t) => {
  const id = '507f1f77bcf86cd79943d101';
  const stubs = installRouteStubs(t, [
    makeNewsDoc(id, 'en', { translationGroupId: null, translationKey: null, sourceArticleId: null }),
  ]);

  const res = await requestPutDeleted(id);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedCount, 1);
  assert.deepEqual(res.body.deletedIds, [id]);
  assert.equal(stubs.updates.length, 1);
  const update = stubs.updates[0].update;
  assert.equal(update.$set.status, 'deleted');
  assert.ok(update.$set.deletedAt instanceof Date);
  assert.equal(update.$set.workflowStage, 'REJECTED');
  assert.ok(update.$set.workflowUpdatedAt instanceof Date);
  assert.equal(update.$push.workflowHistory.action, 'REJECT');
  assert.equal(update.$push.workflowHistory.toStage, 'REJECTED');
  assert.equal(update.$push.workflowHistory.note, 'Deleted');
});

test('PUT multilingual soft-delete makes corresponding public Article copies non-public', async (t) => {
  const ids = {
    en: '507f1f77bcf86cd79943d201',
    hi: '507f1f77bcf86cd79943d202',
    gu: '507f1f77bcf86cd79943d203',
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { translationGroupId: 'tg-public-delete', translationKey: 'tg-public-delete', sourceArticleId: null }),
    makeNewsDoc(ids.hi, 'hi', { translationGroupId: 'tg-public-delete', translationKey: 'tg-public-delete', sourceArticleId: ids.en }),
    makeNewsDoc(ids.gu, 'gu', { translationGroupId: 'tg-public-delete', translationKey: 'tg-public-delete', sourceArticleId: ids.en }),
  ]);

  const res = await requestPutDeleted(ids.hi);

  assert.equal(res.statusCode, 200);
  assert.equal(stubs.publicSyncs.length, 3);
  for (const sync of stubs.publicSyncs) {
    assert.equal(sync.update.$set.status, 'deleted');
    assert.equal(sync.update.$set.publishedAt, null);
    assert.ok(sync.update.$set.deletedAt);
  }
  assert.equal(stubs.publicDraftSweeps.length, 1);
  assert.deepEqual(stubs.publicDraftSweeps[0].update, { $set: { status: 'draft', publishedAt: null } });
  assert.ok(stubs.publicDraftSweeps[0].query.$or.some((clause) => clause.translationGroupId === 'tg-public-delete'));
});

test('PUT Pulse Dialogue EN+HI+GU soft-delete deletes only article group and preserves contributor record/photo', async (t) => {
  const contributorId = '507f1f77bcf86cd79943da01';
  const contributor = {
    _id: contributorId,
    canonicalName: 'Guest Expert',
    publicDesignation: 'Columnist',
    status: 'active',
    photo: { url: 'https://cdn.example.test/contributor.jpg', publicId: 'contrib-photo-1', alt: 'Guest Expert' },
    shortBio: 'Writes on policy.',
  };
  const otherStoryId = '507f1f77bcf86cd79943d304';
  const ids = {
    en: '507f1f77bcf86cd79943d301',
    hi: '507f1f77bcf86cd79943d302',
    gu: '507f1f77bcf86cd79943d303',
  };
  const pulseDialogue = {
    contributorId,
    dialogueFormat: 'essay',
    showAboutContributor: true,
    bylineSnapshot: { name: 'Guest Expert', designation: 'Columnist', photo: contributor.photo },
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-delete', translationKey: 'tg-pulse-delete', sourceArticleId: null, pulseDialogue }),
    makeNewsDoc(ids.hi, 'hi', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-delete', translationKey: 'tg-pulse-delete', sourceArticleId: ids.en, pulseDialogue }),
    makeNewsDoc(ids.gu, 'gu', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-delete', translationKey: 'tg-pulse-delete', sourceArticleId: ids.en, pulseDialogue }),
    makeNewsDoc(otherStoryId, 'en', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-other', translationKey: 'tg-pulse-other', sourceArticleId: null, pulseDialogue }),
  ], { contributor });
  const beforeContributor = cloneRecord(contributor);

  const res = await requestPutDeleted(ids.gu);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedCount, 3);
  assert.deepEqual(new Set(res.body.deletedIds), new Set(Object.values(ids)));
  assert.equal(stubs.records.get(otherStoryId).status, 'published');
  assert.equal(stubs.contributorMutations.length, 0);
  assert.deepEqual(contributor, beforeContributor);
  assert.deepEqual(contributor.photo, beforeContributor.photo);
  assert.equal(stubs.contributorFinds.length, 3);
});

async function assertPostUnpublishTakesDownFullGroup(t, clickedLang) {
  const ids = {
    en: '507f1f77bcf86cd79943d601',
    hi: '507f1f77bcf86cd79943d602',
    gu: '507f1f77bcf86cd79943d603',
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { translationGroupId: 'tg-unpublish-group', translationKey: 'tg-unpublish-group', sourceArticleId: null, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    makeNewsDoc(ids.hi, 'hi', { translationGroupId: 'tg-unpublish-group', translationKey: 'tg-unpublish-group', sourceArticleId: ids.en, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    makeNewsDoc(ids.gu, 'gu', { translationGroupId: 'tg-unpublish-group', translationKey: 'tg-unpublish-group', sourceArticleId: ids.en, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
  ]);

  const res = await requestPostUnpublish(ids[clickedLang]);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Article unpublished');
  assert.equal(res.body.changedCount, 3);
  assert.deepEqual(new Set(res.body.changedIds), new Set(Object.values(ids)));
  assert.deepEqual(new Set(stubs.updates.map((entry) => entry.id)), new Set(Object.values(ids)));
  assertAllRecordsHaveStatus(stubs, ids, 'draft', 'DRAFT');
  assert.equal(stubs.publicSyncs.length, 3);
  assert.equal(stubs.publicSyncs.every((sync) => sync.update.$set.status === 'draft' && sync.update.$set.publishedAt === null), true);
  assert.equal(stubs.publicDraftSweeps.length, 1);
  assert.ok(stubs.publicDraftSweeps[0].query.$or.some((clause) => clause.translationGroupId === 'tg-unpublish-group'));
}

test('POST unpublish via EN id takes down all EN HI GU language docs', async (t) => {
  await assertPostUnpublishTakesDownFullGroup(t, 'en');
});

test('POST unpublish via HI id takes down all EN HI GU language docs', async (t) => {
  await assertPostUnpublishTakesDownFullGroup(t, 'hi');
});

test('POST unpublish via GU id takes down all EN HI GU language docs', async (t) => {
  await assertPostUnpublishTakesDownFullGroup(t, 'gu');
});

test('PUT status=draft takedown via translated id takes down all public Article copies', async (t) => {
  const ids = {
    en: '507f1f77bcf86cd79943d611',
    hi: '507f1f77bcf86cd79943d612',
    gu: '507f1f77bcf86cd79943d613',
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { translationGroupId: 'tg-put-unpublish', translationKey: 'tg-put-unpublish', sourceArticleId: null, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    makeNewsDoc(ids.hi, 'hi', { translationGroupId: 'tg-put-unpublish', translationKey: 'tg-put-unpublish', sourceArticleId: ids.en, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    makeNewsDoc(ids.gu, 'gu', { translationGroupId: 'tg-put-unpublish', translationKey: 'tg-put-unpublish', sourceArticleId: ids.en, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
  ]);

  const res = await requestPutStatus(ids.gu, 'draft');

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Article unpublished');
  assert.equal(res.body.changedCount, 3);
  assertAllRecordsHaveStatus(stubs, ids, 'draft', 'DRAFT');
  assert.equal(stubs.publicSyncs.length, 3);
  assert.equal(stubs.publicSyncs.every((sync) => sync.update.$set.status === 'draft' && sync.update.$set.publishedAt === null), true);
  assert.equal(stubs.publicDraftSweeps.length, 1);
});

test('POST archive via translated id archives all EN HI GU language docs as non-public', async (t) => {
  const ids = {
    en: '507f1f77bcf86cd79943d621',
    hi: '507f1f77bcf86cd79943d622',
    gu: '507f1f77bcf86cd79943d623',
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { translationGroupId: 'tg-archive-group', translationKey: 'tg-archive-group', sourceArticleId: null, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    makeNewsDoc(ids.hi, 'hi', { translationGroupId: 'tg-archive-group', translationKey: 'tg-archive-group', sourceArticleId: ids.en, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
    makeNewsDoc(ids.gu, 'gu', { translationGroupId: 'tg-archive-group', translationKey: 'tg-archive-group', sourceArticleId: ids.en, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
  ]);

  const res = await requestPostArchive(ids.hi);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Article archived');
  assert.equal(res.body.changedCount, 3);
  assertAllRecordsHaveStatus(stubs, ids, 'archived', 'ARCHIVED');
  assert.equal(stubs.publicSyncs.length, 3);
  assert.equal(stubs.publicSyncs.every((sync) => sync.update.$set.status === 'archived' && sync.update.$set.publishedAt === null), true);
  assert.equal(stubs.publicDraftSweeps.length, 1);
});

test('POST unpublish on legacy single-language article only changes that record', async (t) => {
  const id = '507f1f77bcf86cd79943d631';
  const stubs = installRouteStubs(t, [
    makeNewsDoc(id, 'en', { translationGroupId: null, translationKey: null, sourceArticleId: null, publishedAt: new Date('2026-01-01T00:00:00.000Z') }),
  ]);

  const res = await requestPostUnpublish(id);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changedCount, 1);
  assert.deepEqual(res.body.changedIds, [id]);
  assert.equal(stubs.updates.length, 1);
  assert.equal(stubs.updates[0].id, id);
  assert.equal(stubs.records.get(id).status, 'draft');
  assert.equal(stubs.publicSyncs.length, 1);
});

test('POST Pulse Dialogue unpublish preserves Contributor record and photo asset', async (t) => {
  const contributorId = '507f1f77bcf86cd79943da11';
  const contributor = {
    _id: contributorId,
    canonicalName: 'Pulse Columnist',
    publicDesignation: 'Columnist',
    status: 'active',
    photo: { url: 'https://cdn.example.test/pulse-columnist.jpg', publicId: 'pulse-columnist-photo', alt: 'Pulse Columnist' },
    shortBio: 'Writes essays.',
  };
  const otherStoryId = '507f1f77bcf86cd79943d644';
  const ids = {
    en: '507f1f77bcf86cd79943d641',
    hi: '507f1f77bcf86cd79943d642',
    gu: '507f1f77bcf86cd79943d643',
  };
  const pulseDialogue = {
    contributorId,
    dialogueFormat: 'essay',
    showAboutContributor: true,
    bylineSnapshot: { name: 'Pulse Columnist', designation: 'Columnist', photo: contributor.photo },
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-unpublish', translationKey: 'tg-pulse-unpublish', sourceArticleId: null, pulseDialogue }),
    makeNewsDoc(ids.hi, 'hi', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-unpublish', translationKey: 'tg-pulse-unpublish', sourceArticleId: ids.en, pulseDialogue }),
    makeNewsDoc(ids.gu, 'gu', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-unpublish', translationKey: 'tg-pulse-unpublish', sourceArticleId: ids.en, pulseDialogue }),
    makeNewsDoc(otherStoryId, 'en', { category: 'pulse-dialogue', translationGroupId: 'tg-pulse-other-unpublish', translationKey: 'tg-pulse-other-unpublish', sourceArticleId: null, pulseDialogue }),
  ], { contributor });
  const beforeContributor = cloneRecord(contributor);

  const res = await requestPostUnpublish(ids.gu);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.changedCount, 3);
  assert.equal(stubs.records.get(otherStoryId).status, 'published');
  assert.equal(stubs.contributorMutations.length, 0);
  assert.deepEqual(contributor, beforeContributor);
  assert.deepEqual(contributor.photo, beforeContributor.photo);
  assert.equal(stubs.contributorFinds.length, 3);
});

test('PUT status=draft update now uses group-aware takedown path', async (t) => {
  const id = '507f1f77bcf86cd79943d401';
  const siblingId = '507f1f77bcf86cd79943d402';
  const stubs = installRouteStubs(t, [
    makeNewsDoc(id, 'en', { status: 'published', workflowStage: 'PUBLISHED', sourceArticleId: null }),
    makeNewsDoc(siblingId, 'hi', { status: 'published', workflowStage: 'PUBLISHED', sourceArticleId: id }),
  ]);

  const res = await request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send({ status: 'draft' });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Article unpublished');
  assert.equal(stubs.updates.length, 2);
  assert.deepEqual(new Set(stubs.updates.map((entry) => entry.id)), new Set([id, siblingId]));
  assert.equal(stubs.records.get(id).status, 'draft');
  assert.equal(stubs.records.get(siblingId).status, 'draft');
});

test('DELETE /api/articles/:id still uses the same group-aware soft-delete behavior', async (t) => {
  const ids = {
    en: '507f1f77bcf86cd79943d501',
    hi: '507f1f77bcf86cd79943d502',
    gu: '507f1f77bcf86cd79943d503',
  };
  const stubs = installRouteStubs(t, [
    makeNewsDoc(ids.en, 'en', { translationGroupId: 'tg-delete-regression', translationKey: 'tg-delete-regression', sourceArticleId: null }),
    makeNewsDoc(ids.hi, 'hi', { translationGroupId: 'tg-delete-regression', translationKey: 'tg-delete-regression', sourceArticleId: ids.en }),
    makeNewsDoc(ids.gu, 'gu', { translationGroupId: 'tg-delete-regression', translationKey: 'tg-delete-regression', sourceArticleId: ids.en }),
  ]);

  const res = await request(app)
    .delete(`/api/articles/${ids.en}`)
    .set('Authorization', `Bearer ${makeOpaqueAdminToken()}`)
    .send();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedCount, 3);
  assert.deepEqual(new Set(res.body.deletedIds), new Set(Object.values(ids)));
  assert.deepEqual(new Set(stubs.updates.map((entry) => entry.id)), new Set(Object.values(ids)));
});