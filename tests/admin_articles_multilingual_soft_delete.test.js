require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-test-jwt-key';

const app = require('../server');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const Contributor = require('../models/Contributor');
const { installEditorialFixture } = require('./helpers/editorialLifecycleFixture');

let fixture;

function makeFounderToken() {
  return fixture.token('founder');
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
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
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

function cloneRecord(record) {
  return structuredClone(Object.fromEntries(Object.entries(record).filter(([, value]) => typeof value !== 'function')));
}

function installRouteStubs(t, seedDocs, options = {}) {
  const state = fixture = installEditorialFixture(t);
  state.rows.News.push(...seedDocs.map(cloneRecord));
  state.rows.Article.push(...seedDocs.map(doc => ({
    ...cloneRecord(doc), _id: doc._id.replace(/^5/, '6'), sourceNewsId: doc._id, summary: doc.description,
  })));
  const beforeRecords = new Map(seedDocs.map(doc => [String(doc._id), cloneRecord(doc)]));
  const updates = [];
  const publicUpdates = [];
  const contributorMutations = [];
  const contributorFinds = [];
  const invalidations = [];
  t.after(require('../lib/cache').onArticleCachesInvalidated((event) => {
    invalidations.push(event);
    return new Promise(() => {});
  }));
  const contributorRecord = options.contributor || null;

  for (const method of ['findOneAndUpdate', 'findByIdAndUpdate']) {
    const write = News[method];
    t.mock.method(News, method, (filter, update, updateOptions) => {
      updates.push({ id: String(method === 'findOneAndUpdate' ? filter._id : filter), update, options: updateOptions });
      return write(filter, update, updateOptions);
    });
  }
  const updateCopies = PublicArticle.updateMany;
  t.mock.method(PublicArticle, 'updateMany', (query, update, updateOptions) => {
    publicUpdates.push({ query, update, options: updateOptions });
    return updateCopies(query, update, updateOptions);
  });
  t.mock.method(Contributor, 'findById', id => {
    contributorFinds.push(String(id));
    return { lean: async () => (contributorRecord ? cloneRecord(contributorRecord) : null) };
  });
  for (const method of ['updateOne', 'updateMany', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findByIdAndDelete']) {
    t.mock.method(Contributor, method, async (...args) => {
      contributorMutations.push({ method, args });
      return { acknowledged: true, modifiedCount: 0, deletedCount: 0 };
    });
  }

  return {
    state, beforeRecords,
    get records() { return new Map(state.rows.News.map(doc => [String(doc._id), doc])); },
    updates,
    publicUpdates,
    contributorFinds,
    contributorMutations,
    invalidations,
  };
}

async function requestPutDeleted(id) {
  return request(app)
    .put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeFounderToken()}`)
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
    assert.deepEqual(record.publishedAt, stubs.beforeRecords.get(id).publishedAt);
    assert.equal(record.publishAt, null);
    assert.equal(record.scheduledAt, null);
  }
}

function assertPublicCopiesHaveStatus(stubs, ids, status) {
  const copies = stubs.state.rows.Article.filter(copy => Object.values(ids).includes(copy.sourceNewsId));
  assert.equal(copies.length, Object.values(ids).length);
  for (const copy of copies) {
    assert.equal(copy.status, status);
    assert.deepEqual(copy.publishedAt, stubs.beforeRecords.get(copy.sourceNewsId).publishedAt);
    if (status === 'deleted') assert.ok(copy.deletedAt instanceof Date);
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
  assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
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
  assert.equal(update.$push.workflowHistory.note, null);
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
  assertPublicCopiesHaveStatus(stubs, ids, 'deleted');
  assert.equal(stubs.publicUpdates.length, 1);
  assert.equal(stubs.publicUpdates[0].update.$set.status, 'deleted');
  assert.match(JSON.stringify(stubs.publicUpdates[0].query), /tg-public-delete/);
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
  assert.equal(stubs.contributorFinds.length, 0);
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
  assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
  assert.equal(res.body.changedCount, 3);
  assert.deepEqual(new Set(res.body.changedIds), new Set(Object.values(ids)));
  assert.deepEqual(new Set(stubs.updates.map((entry) => entry.id)), new Set(Object.values(ids)));
  assertAllRecordsHaveStatus(stubs, ids, 'draft', 'DRAFT');
  assertPublicCopiesHaveStatus(stubs, ids, 'draft');
  assert.equal(stubs.publicUpdates.length, 1);
  assert.match(JSON.stringify(stubs.publicUpdates[0].query), /tg-unpublish-group/);
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
  assertPublicCopiesHaveStatus(stubs, ids, 'draft');
  assert.equal(stubs.publicUpdates.length, 1);
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
  assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
  assert.equal(res.body.changedCount, 3);
  assertAllRecordsHaveStatus(stubs, ids, 'archived', 'ARCHIVED');
  assertPublicCopiesHaveStatus(stubs, ids, 'archived');
  assert.equal(stubs.publicUpdates.length, 1);
});

for (const status of ['draft', 'archived', 'scheduled']) {
  test(`PUT published article with content and status=${status} invalidates withdrawn LKG`, async (t) => {
    const id = '507f1f77bcf86cd79943d701';
    const stubs = installRouteStubs(t, [makeNewsDoc(id, 'en', { translationGroupId: null, translationKey: null, sourceArticleId: null })]);
    const response = await request(app).put(`/api/articles/${id}`)
      .set('Authorization', `Bearer ${makeFounderToken()}`)
      .send({ status, title: 'Updated title', ...(status === 'scheduled' ? { scheduledAt: '2099-01-01T00:00:00.000Z' } : {}) });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
    assertPublicCopiesHaveStatus(stubs, [id], status);
    assert.equal(stubs.records.get(id).title, 'Updated title');
    assert.equal(stubs.state.rows.Article[0].title, 'Updated title');
  });
}

test('ordinary published article edit invalidates cached content after committing the updated copy', async (t) => {
  const id = '507f1f77bcf86cd79943d702';
  const stubs = installRouteStubs(t, [makeNewsDoc(id, 'en', { translationGroupId: null, translationKey: null, sourceArticleId: null })]);
  const response = await request(app).put(`/api/articles/${id}`)
    .set('Authorization', `Bearer ${makeFounderToken()}`)
    .send({ title: 'Updated public headline' });
  assert.equal(response.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stubs.records.get(id).status, 'published');
  assert.equal(stubs.state.rows.Article[0].title, 'Updated public headline');
  assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
});

test('rescheduling a published article invalidates withdrawn LKG', async (t) => {
  const id = '507f1f77bcf86cd79943d706';
  const doc = makeNewsDoc(id, 'en', { translationGroupId: null, translationKey: null, sourceArticleId: null });
  const stubs = installRouteStubs(t, [doc]);
  const response = await request(app).post(`/api/articles/${id}/schedule`)
    .set('Authorization', `Bearer ${makeFounderToken()}`)
    .send({ scheduledAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(response.statusCode, 200);
  assert.equal(stubs.records.get(id).status, 'scheduled');
  assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
});

test('permanent deletion refuses a published article without invalidating public content', async (t) => {
  const id = '507f1f77bcf86cd79943d703';
  const doc = makeNewsDoc(id, 'en');
  const stubs = installRouteStubs(t, [doc]);
  const before = structuredClone(stubs.state.rows);
  const response = await request(app).delete(`/api/articles/${id}/permanent`)
    .set('Authorization', `Bearer ${makeFounderToken()}`);
  assert.equal(response.statusCode, 409);
  assert.deepEqual(stubs.state.rows, before);
  assert.deepEqual(stubs.invalidations, []);
});

for (const path of ['drafts/:id/delete', 'drafts/:id/restore', 'workflow/:id/lock', 'workflow/:id/embargo']) {
  test(`legacy ${path} invalidates LKG when removing public visibility`, async (t) => {
    const id = '507f1f77bcf86cd79943d704';
    const doc = makeNewsDoc(id, 'en', {
      translationGroupId: null, translationKey: null, sourceArticleId: null,
      ...(path === 'drafts/:id/restore' ? { status: 'deleted', deletedFromStatus: 'draft', deletedAt: new Date() } : {}),
    });
    const stubs = installRouteStubs(t, [doc]);
    const response = await request(app).post('/api/admin/' + path.replace(':id', id))
      .set('Authorization', `Bearer ${makeFounderToken()}`)
      .send({ embargoUntil: '2099-01-01T00:00:00.000Z' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(stubs.invalidations, [{ publicVisibilityRemoved: true }]);
  });
}

test('workflow stage moving published News to draft invalidates LKG', async (t) => {
  const { installEditorialFixture } = require('./helpers/editorialLifecycleFixture');
  const state = installEditorialFixture(t);
  const id = '507f1f77bcf86cd79943d705';
  state.rows.News.push(makeNewsDoc(id, 'en'));
  const invalidations = [];
  t.after(require('../lib/cache').onArticleCachesInvalidated(event => { invalidations.push(event); }));
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await require('../src/controllers/admin/workflow.controller').patchWorkflowStage({
    params: { id }, body: { action: 'set', toStage: 'draft' }, admin: { role: 'founder' }, headers: {},
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(state.rows.News[0].status, 'draft');
  assert.deepEqual(invalidations, [{ publicVisibilityRemoved: true }]);
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
  assertPublicCopiesHaveStatus(stubs, [id], 'draft');
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
  assert.equal(stubs.contributorFinds.length, 0);
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
    .set('Authorization', `Bearer ${makeFounderToken()}`)
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
    .set('Authorization', `Bearer ${makeFounderToken()}`)
    .send();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deletedCount, 3);
  assert.deepEqual(new Set(res.body.deletedIds), new Set(Object.values(ids)));
  assert.deepEqual(new Set(stubs.updates.map((entry) => entry.id)), new Set(Object.values(ids)));
});