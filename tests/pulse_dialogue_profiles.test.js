const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

process.env.NODE_ENV = 'test';

const Contributor = require('../models/Contributor');
const Series = require('../models/PulseDialogueSeries');
const seriesAdminRouter = require('../routes/adminPulseDialogueSeries.routes');
const { normalizePulseDialoguePayload } = require('../services/pulseDialogue.service');
const { buildChildNewsSyncPatch } = require('../services/translationGroupSync.service');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const publicRouter = require('../routes/publicPulseDialogue.routes');
const { attachPublicPulseDialogueContributor } = require('../services/pulseDialogue.service');
const adminRouter = require('../routes/adminPulseDialogueContributors.routes');
const {
  normalizeContributorPayload,
  createWithUniqueDialogueSlug,
  isContributorProfilePublic,
} = require('../services/pulseDialogue.service');

const contributorId = '507f1f77bcf86cd799439a01';
const token = `np.${Buffer.from('admin@newspulse.ai:0').toString('base64')}`;

function makeApp(router, prefix = '/') {
  const app = express();
  app.use(express.json());
  app.use(prefix, router);
  app.use((error, _req, res, _next) => res.status(500).json({ message: error.message }));
  return app;
}

test('profile defaults are opt-in and generated slugs are safe', async () => {
  const doc = new Contributor({ canonicalName: 'Shailesh Rathod' });
  await doc.validate();
  assert.equal(doc.slug, 'shailesh-rathod');
  assert.deepEqual([...doc.slugHistory], ['shailesh-rathod']);
  assert.equal(doc.profileVisible, false);
  doc.canonicalName = 'New Display Name';
  await doc.validate();
  assert.equal(doc.slug, 'shailesh-rathod');
  assert.equal(normalizeContributorPayload({ canonicalName: '  Shailesh / Rathod?! ' }).value.slug, 'shailesh-rathod');
  assert.equal(normalizeContributorPayload({ canonicalName: '!!!' }).value.slug, 'contributor');
  assert.equal(normalizeContributorPayload({ slug: '' }, { partial: true }).ok, false);
  assert.equal(normalizeContributorPayload({ profileVisible: 'false' }, { partial: true }).ok, false);
  assert.equal(Contributor.schema.indexes().some(([keys, options]) => keys.slug === 1 && options.unique), true);
});

test('generated slug collisions retry the unique insert, explicit collisions reject', async () => {
  const used = new Set(['shailesh-rathod']);
  const Model = { async create(payload) {
    if (used.has(payload.slug)) throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { slug: 1 } });
    used.add(payload.slug);
    return payload;
  } };
  const results = await Promise.all([
    createWithUniqueDialogueSlug(Model, { slug: 'shailesh-rathod' }),
    createWithUniqueDialogueSlug(Model, { slug: 'shailesh-rathod' }),
  ]);
  assert.deepEqual(results.map((doc) => doc.slug).sort(), ['shailesh-rathod-2', 'shailesh-rathod-3']);
  await assert.rejects(createWithUniqueDialogueSlug(Model, { slug: 'shailesh-rathod' }, { explicitSlug: true }), /duplicate/);
});

test('active and inactive profiles require visibility; draft and hidden are never public', async () => {
  for (const slug of ['', '../invalid', 'invalid slug', 'long'.repeat(40)]) {
    assert.equal(isContributorProfilePublic({ slug, status: 'active', profileVisible: true }), false);
  }
  for (const status of ['draft', 'active', 'inactive', 'hidden']) {
    const doc = new Contributor({ canonicalName: 'Writer', status });
    await doc.validate();
    for (const profileVisible of [false, true, undefined]) {
      assert.equal(isContributorProfilePublic({ slug: 'writer', status, profileVisible }),
        profileVisible === true && ['active', 'inactive'].includes(status));
    }
  }
});

test('Admin profile edit changes only Contributor fields and preserves established slug', async (context) => {
  let update;
  context.mock.method(Contributor, 'findByIdAndUpdate', async (_id, patch) => {
    update = patch;
    return { _id: contributorId, slug: 'original-name', slugHistory: ['original-name'], ...patch.$set };
  });
  const response = await request(makeApp(adminRouter)).patch(`/${contributorId}`)
    .set('Authorization', `Bearer ${token}`)
    .send({ canonicalName: 'Changed Name', photo: 'https://example.test/new.jpg', profileVisible: true });
  assert.equal(response.status, 200);
  assert.equal(response.body.contributor.slug, 'original-name');
  assert.deepEqual(Object.keys(update.$set).sort(), ['canonicalName', 'photo', 'profileVisible']);
});

test('Series stable identity is optional and shared across translations', async () => {
  const series = new Series({ title: 'Public Ideas' });
  await series.validate();
  assert.equal(series.slug, 'public-ideas');
  const suffixedSlug = `${'long'.repeat(30)}-2`;
  const collision = new Series({ title: 'Long title', slug: suffixedSlug });
  await collision.validate();
  assert.equal(collision.slug, suffixedSlug);
  assert.equal(series.profileVisible, false);
  assert.equal(series.ownerContributorId, null);
  series.title = 'Renamed';
  await series.validate();
  assert.equal(series.slug, 'public-ideas');
  const pulse = { contributorId, dialogueFormat: 'column', series: 'Public Ideas', seriesSlug: series.slug };
  assert.equal(normalizePulseDialoguePayload({ pulseDialogue: pulse }, { category: 'pulse-dialogue' }).value.seriesSlug, 'public-ideas');
  assert.equal(normalizePulseDialoguePayload({ pulseDialogue: { ...pulse, seriesSlug: '../bad' } }, { category: 'pulse-dialogue' }).ok, false);
  for (const language of ['en', 'hi', 'gu']) {
    const patch = buildChildNewsSyncPatch({ _id: contributorId, category: 'pulse-dialogue', language: 'en', pulseDialogue: pulse },
      { language, lang: language });
    assert.equal(patch.pulseDialogue.seriesSlug, 'public-ideas');
    assert.equal(patch.pulseDialogue.contributorId, contributorId);
  }
});

test('Series Admin API requires auth, validates optional owner, and rejects slug edits', async (context) => {
  context.mock.method(Contributor, 'findById', () => ({ lean: async () => ({ _id: contributorId }) }));
  context.mock.method(Series, 'create', async (payload) => ({ _id: contributorId, ...payload }));
  const app = makeApp(seriesAdminRouter);
  assert.equal((await request(app).post('/').send({ title: 'Ideas' })).status, 401);
  const created = await request(app).post('/').set('Authorization', `Bearer ${token}`)
    .send({ title: 'Ideas', ownerContributorId: contributorId });
  assert.equal(created.status, 201);
  assert.equal(created.body.series.slug, 'ideas');
  assert.equal(created.body.series.ownerContributorId, contributorId);
  const edited = await request(app).patch(`/${contributorId}`).set('Authorization', `Bearer ${token}`)
    .send({ slug: 'different' });
  assert.equal(edited.status, 400);
  const invalidOwner = await request(app).post('/').set('Authorization', `Bearer ${token}`)
    .send({ title: 'Ideas', ownerContributorId: 'invalid' });
  assert.equal(invalidOwner.status, 400);
});

function matches(doc, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$expr') return JSON.stringify(doc.slugHistory ?? null) === JSON.stringify(expected.$eq[1].$literal);
    if (key === '$and') return expected.every((clause) => matches(doc, clause));
    if (key === '$or') return expected.some((clause) => matches(doc, clause));
    const actual = key.split('.').reduce((value, field) => value?.[field], doc);
    if (Array.isArray(actual) && typeof expected === 'string') return actual.includes(expected);
    if (expected === null) return actual == null;
    if (expected && typeof expected === 'object') {
      if ('$in' in expected) return Array.isArray(actual) ? actual.some(value => expected.$in.includes(value)) : expected.$in.includes(actual);
      if ('$ne' in expected) return actual !== expected.$ne;
      if ('$exists' in expected) return (actual !== undefined) === expected.$exists;
      if ('$lte' in expected) return actual != null && new Date(actual) <= new Date(expected.$lte);
    }
    return String(actual) === String(expected);
  });
}

function queryResult(docs, single = false) {
  let rows = structuredClone(docs);
  let projection;
  return {
    select(fields) { projection = new Set(['_id', ...fields.split(' ').map((field) => field.split('.')[0])]); return this; },
    sort(order) {
      rows.sort((left, right) => {
        for (const [field, direction] of Object.entries(order)) {
          if (left[field] < right[field]) return -direction;
          if (left[field] > right[field]) return direction;
        }
        return 0;
      });
      return this;
    },
    skip(amount) { rows = rows.slice(amount); return this; },
    limit(amount) { rows = rows.slice(0, amount); return this; },
    async lean() {
      const selected = rows.map((doc) => projection ? Object.fromEntries(Object.entries(doc).filter(([key]) => projection.has(key))) : doc);
      return single ? selected[0] || null : selected;
    },
  };
}

function stubReads(context, Model, docs) {
  context.mock.method(Model, 'find', (filter) => queryResult(docs.filter((doc) => matches(doc, filter))));
  context.mock.method(Model, 'findOne', (filter) => queryResult(docs.filter((doc) => matches(doc, filter)), true));
  context.mock.method(Model, 'countDocuments', async (filter) => docs.filter((doc) => matches(doc, filter)).length);
}

function profile(overrides = {}) {
  return { _id: contributorId, slug: 'shared-writer', canonicalName: 'Shared Writer', status: 'active', profileVisible: true,
    internalEmail: 'private@example.test', internalNotes: 'Private notes', rightsConsent: { notes: 'Private rights' },
    permissions: ['private'], photo: { url: 'https://example.test/new.jpg', publicId: 'private-storage-key' }, ...overrides };
}

function article(index, overrides = {}) {
  return {
    _id: String(index).padStart(24, '0'), title: `Article ${index}`, description: 'Summary', content: '<p>Content</p>',
    slug: `article-${index}`, category: 'pulse-dialogue', status: 'published', language: 'en', lang: 'en', originalLang: 'en',
    publishedAt: new Date(Date.UTC(2020, 0, index)).toISOString(), createdAt: '2020-01-01T00:00:00.000Z',
    translationGroupId: `group-${index}`, internalNotes: 'Private article notes',
    pulseDialogue: { contributorId, dialogueFormat: 'column', series: 'Ideas', seriesSlug: 'ideas', editorNote: 'Editorial note',
      bylineSnapshot: { name: 'Historical Writer', designation: 'Columnist', affiliation: 'Forum',
        photo: { url: 'https://example.test/old.jpg', publicId: 'old', alt: 'Old portrait' } } },
    ...overrides,
  };
}

test('public profiles and discovery allowlist fields and enforce all visibility states', async (context) => {
  const profiles = [profile(), profile({ _id: 'inactive', slug: 'inactive', status: 'inactive', photo: null }),
    profile({ _id: 'hidden', slug: 'hidden', status: 'hidden' }), profile({ _id: 'draft', slug: 'draft', status: 'draft' }),
    profile({ _id: 'invisible', slug: 'invisible', profileVisible: false }), profile({ _id: 'legacy', slug: 'legacy', profileVisible: undefined })];
  stubReads(context, Contributor, profiles);
  stubReads(context, News, [article(1)]);
  const app = makeApp(publicRouter);
  const discovery = await request(app).get('/contributors');
  assert.equal(discovery.status, 200);
  assert.equal(discovery.body.total, 1);
  assert.deepEqual(discovery.body.items.map((item) => item.slug), ['shared-writer']);
  const expectedFields = ['name', 'photoUrl', 'publicDesignation', 'shortBio', 'slug'];
  for (const item of discovery.body.items) assert.deepEqual(Object.keys(item).sort(), expectedFields);
  for (const slug of ['hidden', 'draft', 'invisible', 'legacy', 'missing']) {
    assert.equal((await request(app).get(`/contributors/${slug}`)).status, 404);
    assert.equal((await request(app).get(`/contributors/${slug}/articles`)).status, 404);
  }
  const response = await request(app).get('/contributors/shared-writer');
  assert.equal(response.status, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(response.body.contributor).sort(), ['contributionCount', ...expectedFields]);
  assert.equal(response.body.contributor.contributionCount, 1);
  const inactive = await request(app).get('/contributors/inactive');
  assert.equal(inactive.status, 200);
  assert.equal(inactive.body.contributor.photoUrl, null);
  assert.equal(inactive.body.contributor.shortBio, null);
  assert.equal(inactive.body.contributor.contributionCount, 0);
});

test('contributor archives use canonical visibility, exact association, bounded pagination, and safe public cards', async (context) => {
  const excluded = [
    { status: 'draft' }, { status: 'scheduled' }, { status: 'archived' }, { deletedAt: new Date().toISOString() },
    { locked: true }, { visibility: 'private' }, { isPrivate: true }, { embargoUntil: '2999-01-01' },
    { publishedAt: '2999-01-01' }, { publishAt: '2999-01-01' }, { scheduledAt: '2999-01-01' },
    { workflow: { locked: true } }, { workflow: { embargoUntil: '2999-01-01' } }, { category: 'national' },
    { pulseDialogue: { contributorId: 'another', seriesSlug: 'other' } },
  ];
  const docs = [article(1), article(2), article(3), ...excluded.map((overrides, index) => article(index + 4, overrides))];
  stubReads(context, Contributor, [profile()]);
  stubReads(context, News, docs);
  const app = makeApp(publicRouter);
  const response = await request(app).get('/contributors/shared-writer/articles?page=2&limit=2');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 3);
  assert.equal(response.body.contributor.contributionCount, 3);
  assert.equal(response.body.page, 2);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.totalPages, 2);
  assert.equal(response.body.hasNextPage, false);
  assert.equal(response.body.items[0].slug, 'article-1');
  assert.equal(response.body.items[0].internalNotes, undefined);
  assert.equal(response.body.items[0].pulseDialogue.contributorSlug, 'shared-writer');
  assert.equal(response.body.items[0].pulseDialogue.profileAvailable, true);
  assert.equal(response.body.items[0].pulseDialogue.contributor.internalEmail, undefined);
  assert.equal(response.body.items[0].pulseDialogue.bylineSnapshot.photo.url, 'https://example.test/old.jpg');
  assert.ok(response.body.items[0].canonicalSlug);
  const bounded = await request(app).get('/contributors/shared-writer/articles?limit=999999&page=1');
  assert.equal(bounded.body.limit, 50);
  assert.deepEqual(bounded.body.items.map((item) => item.slug), ['article-3', 'article-2', 'article-1']);
  const beyond = await request(app).get('/contributors/shared-writer/articles?page=999999999999999999999');
  assert.equal(beyond.body.page, 10000);
  assert.deepEqual(beyond.body.items, []);
  assert.equal(beyond.body.total, 3);
  assert.equal((await request(app).get('/contributors/shared-writer/articles?lang=fr')).status, 400);
});

test('EN HI GU archives use the same contributor slug, canonical profile name, photo, and Series identity', async (context) => {
  stubReads(context, Contributor, [profile({ displayNameHi: 'Explicit Hindi Name', displayNameGu: 'Explicit Gujarati Name' })]);
  stubReads(context, News, ['en', 'hi', 'gu'].map((language, index) => article(index + 1,
    { language, lang: language, originalLang: language, translationGroupId: 'one-shared-group' })));
  const app = makeApp(publicRouter);
  for (const lang of ['en', 'hi', 'gu']) {
    const response = await request(app).get(`/contributors/shared-writer/articles?lang=${lang}`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.contributor.name, 'Shared Writer');
    assert.equal(response.body.contributor.slug, 'shared-writer');
    assert.equal(response.body.contributor.photoUrl, 'https://example.test/new.jpg');
    assert.equal(response.body.items[0].language, lang);
    assert.equal(response.body.items[0].pulseDialogue.seriesSlug, 'ideas');
    assert.equal(response.body.items[0].pulseDialogue.contributorSlug, 'shared-writer');
  }
  assert.equal((await request(app).get('/contributors/shared-writer')).body.contributor.contributionCount, 1);
  const defaultArchive = await request(app).get('/contributors/shared-writer/articles');
  assert.equal(defaultArchive.body.total, 1);
  assert.equal(defaultArchive.body.items.length, 1);
  assert.equal(defaultArchive.body.lang, 'gu');
  assert.equal(defaultArchive.body.items[0].language, 'gu');
});

test('Series archives filter and paginate existing Pulse articles with a safe optional owner and empty results', async (context) => {
  const series = [{ _id: 'series', slug: 'ideas', title: 'Ideas', description: 'Public description', profileVisible: true,
    ownerContributorId: contributorId, internalNotes: 'private' },
  { slug: 'empty', title: 'Empty', profileVisible: true }, { slug: 'hidden', title: 'Hidden', profileVisible: false }];
  const profiles = [profile()];
  stubReads(context, Series, series);
  stubReads(context, Contributor, profiles);
  stubReads(context, News, [article(1), article(2), article(3, { status: 'draft' }), article(4, { category: 'national' }),
    article(5, { pulseDialogue: { contributorId, series: 'Ideas' } }), article(6, { visibility: 'private' })]);
  const app = makeApp(publicRouter);
  const response = await request(app).get('/series/ideas/articles?limit=1&page=2');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.series.articleCount, 2);
  assert.equal(response.body.items[0].slug, 'article-1');
  assert.equal(response.body.series.ownerContributor.slug, 'shared-writer');
  assert.equal(response.body.series.ownerContributorId, undefined);
  assert.equal(response.body.series.internalNotes, undefined);
  profiles[0].status = 'hidden';
  assert.equal((await request(app).get('/series/ideas')).body.series.ownerContributor, null);
  assert.equal((await request(app).get('/series/ideas/articles?limit=9999')).body.limit, 50);
  const empty = await request(app).get('/series/empty/articles');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.series.ownerContributor, null);
  assert.deepEqual(empty.body.items, []);
  assert.equal((await request(app).get('/series/hidden')).status, 404);
  assert.equal((await request(app).get('/series/missing/articles')).status, 404);
  const discovery = await request(app).get('/series');
  assert.equal(discovery.body.total, 2);
  assert.deepEqual(Object.keys(discovery.body.items[0]).sort(), ['description', 'slug', 'title']);
});

test('profile edits never write article snapshots; link availability follows live profile state', async (context) => {
  const current = profile({ slugHistory: ['shared-writer'] });
  const stored = article(1);
  const before = structuredClone(stored);
  context.mock.method(News, 'updateMany', () => { throw new Error('Unexpected article write'); });
  context.mock.method(PublicArticle, 'updateMany', () => { throw new Error('Unexpected public article write'); });
  context.mock.method(PublicArticle, 'findOneAndUpdate', () => { throw new Error('Unexpected snapshot sync'); });
  context.mock.method(Contributor, 'findByIdAndUpdate', async (_id, patch) => Object.assign(current, patch.$set));
  context.mock.method(Contributor, 'findById', () => ({ lean: async () => current }));
  const result = await request(makeApp(adminRouter)).patch(`/${contributorId}`).set('Authorization', `Bearer ${token}`)
    .send({ canonicalName: 'New Name', photo: 'https://example.test/changed.jpg' });
  assert.equal(result.status, 200);
  for (const status of ['active', 'inactive', 'hidden', 'draft']) {
    current.status = status;
    const output = structuredClone(stored);
    await attachPublicPulseDialogueContributor(output, 'en');
    assert.deepEqual(output.pulseDialogue.bylineSnapshot, before.pulseDialogue.bylineSnapshot);
    assert.equal(output.pulseDialogue.editorNote, 'Editorial note');
    assert.equal(output.pulseDialogue.profileAvailable, ['active', 'inactive'].includes(status));
    assert.equal(output.pulseDialogue.contributorSlug, ['active', 'inactive'].includes(status) ? 'shared-writer' : null);
  }
  current.status = 'active';
  current.profileVisible = false;
  const invisible = structuredClone(stored);
  await attachPublicPulseDialogueContributor(invisible, 'en');
  assert.equal(invisible.pulseDialogue.profileAvailable, false);
  assert.deepEqual(stored, before);
});

test('Admin contributor creation retries collisions and established slug edits are rejected', async (context) => {
  let creates = 0;
  context.mock.method(Contributor, 'exists', async () => null);
  context.mock.method(Contributor, 'create', async (payload) => {
    creates += 1;
    if (creates === 1) throw Object.assign(new Error('duplicate'), { code: 11000, keyPattern: { slug: 1 } });
    return { _id: contributorId, ...payload };
  });
  context.mock.method(Contributor, 'findByIdAndUpdate', async (_id, patch) => {
    assert.fail('Slug edit must not reach the database');
  });
  const app = makeApp(adminRouter);
  const created = await request(app).post('/').set('Authorization', `Bearer ${token}`).send({ canonicalName: 'Shared Writer' });
  assert.equal(created.status, 201);
  assert.equal(created.body.contributor.slug, 'shared-writer-2');
  const changed = await request(app).patch(`/${contributorId}`).set('Authorization', `Bearer ${token}`).send({ slug: 'New / Slug!' });
  assert.equal(changed.status, 400);
  assert.equal(changed.body.message, 'Use the dedicated contributor slug-change action');
  assert.equal((await request(app).put(`/${contributorId}`).set('Authorization', `Bearer ${token}`).send({ slug: 'shared-writer-2' })).status, 400);
  assert.deepEqual(created.body.contributor.slugHistory, ['shared-writer-2']);
});

test('archive and discovery page sizes are capped at fifty actual results', async (context) => {
  stubReads(context, Contributor, Array.from({ length: 55 }, (_, index) => profile({ _id: String(index), slug: `writer-${index}` })));
  const app = makeApp(publicRouter);
  const discovery = await request(app).get('/contributors?limit=9999');
  assert.equal(discovery.body.items.length, 50);
  assert.equal(discovery.body.total, 55);
  assert.equal(discovery.body.hasNextPage, true);
  stubReads(context, Series, [{ slug: 'ideas', title: 'Ideas', profileVisible: true }]);
  stubReads(context, News, Array.from({ length: 55 }, (_, index) => article(index + 1)));
  const response = await request(app).get('/series/ideas/articles?limit=9999');
  assert.equal(response.body.items.length, 50);
  assert.equal(response.body.total, 55);
  const last = await request(app).get('/series/ideas/articles?limit=50&page=2');
  assert.equal(last.body.items.length, 5);
  assert.equal(last.body.hasNextPage, false);
  const firstIds = new Set(response.body.items.map((item) => item.id));
  assert.equal(last.body.items.some((item) => firstIds.has(item.id)), false);
});

test('production route mounts expose read-only public aliases and keep Series Admin authenticated', async (context) => {
  const app = require('../server');
  stubReads(context, Contributor, [profile()]);
  stubReads(context, News, []);
  for (const prefix of ['/api/public/pulse-dialogue', '/admin-api/public/pulse-dialogue', '/admin-api/api/public/pulse-dialogue']) {
    const response = await request(app).get(`${prefix}/contributors/shared-writer`);
    assert.equal(response.status, 200);
    assert.equal(response.body.contributor.slug, 'shared-writer');
  }
  for (const prefix of ['/api/admin/pulse-dialogue', '/admin-api/admin/pulse-dialogue', '/admin-api/api/admin/pulse-dialogue']) {
    assert.equal((await request(app).post(`${prefix}/series`).send({ title: 'Denied' })).status, 401);
  }
});

test('missing Contributor preserves Phase 1 snapshot and text while disabling stale profile links', async (context) => {
  context.mock.method(Contributor, 'findById', () => ({ lean: async () => null }));
  context.mock.method(Contributor, 'find', () => ({ lean: async () => [] }));
  const { attachPublicPulseDialogueContributorsBatch } = require('../services/pulseDialogue.service');
  for (const batch of [false, true]) {
    const doc = article(1);
    doc.pulseDialogue.contributorDisclosure = 'Existing disclosure';
    doc.pulseDialogue.contributorDisclaimer = 'Existing disclaimer';
    doc.pulseDialogue.contributorSlug = 'stale';
    doc.pulseDialogue.profileAvailable = true;
    const before = structuredClone(doc.pulseDialogue);
    if (batch) await attachPublicPulseDialogueContributorsBatch([doc]);
    else await attachPublicPulseDialogueContributor(doc);
    assert.deepEqual(doc.pulseDialogue, { ...before, contributorSlug: null, profileAvailable: false });
  }
});

test('Series unique-story counts and paginated locale archives never repeat translation groups', async (context) => {
  const docs = ['en', 'hi', 'gu'].flatMap((language, localeIndex) => [1, 2].map((story) => article(story * 3 + localeIndex, {
    language, lang: language, originalLang: language, translationKey: `story-${story}`, translationGroupId: `story-${story}`,
    title: `${language} story ${story}`, publishedAt: `2020-01-0${story}T00:00:00.000Z`,
  })));
  stubReads(context, News, docs);
  stubReads(context, Contributor, [profile()]);
  stubReads(context, Series, [{ slug: 'ideas', title: 'Ideas', profileVisible: true }]);
  const app = makeApp(publicRouter);
  assert.equal((await request(app).get('/series/ideas')).body.series.articleCount, 2);
  assert.equal((await request(app).get('/contributors/shared-writer')).body.contributor.contributionCount, 2);
  for (const base of ['/series/ideas', '/contributors/shared-writer']) {
    for (const lang of ['en', 'hi', 'gu']) {
      const first = await request(app).get(`${base}/articles?lang=${lang}&limit=1`);
      const second = await request(app).get(`${base}/articles?lang=${lang}&limit=1&page=2`);
      assert.equal(first.status, 200);
      assert.equal(first.body.total, 2);
      assert.equal(first.body.totalPages, 2);
      assert.equal(first.body.items[0].title, `${lang} story 2`);
      assert.equal(second.body.items[0].title, `${lang} story 1`);
      assert.equal(first.body.items[0].resolvedLang, lang);
      assert.equal(second.body.items[0].resolvedLang, lang);
      assert.notEqual(first.body.items[0].translationGroupId, second.body.items[0].translationGroupId);
      assert.equal((await request(app).get(`${base}/articles?lang=${lang}`)).body.items.length, 2);
    }
  }
});

test('archives use existing category fallback, ready cached translations, and locale aliases', async (context) => {
  const cached = article(1, {
    translationKey: 'cached-story',
    slugs: { en: 'english-story', hi: 'hindi-story' },
    translations: { hi: { title: 'Hindi cached title', summary: 'Hindi cached summary', content: '<p>Hindi cached body</p>' } },
    translationStatus: { hi: 'ready' },
  });
  const pending = article(2, { translationStatus: { hi: 'pending' }, translations: cached.translations });
  const privateHindi = article(3, { translationKey: 'cached-story', language: 'hi', lang: 'hi', originalLang: 'hi', visibility: 'private' });
  stubReads(context, News, [cached, pending, privateHindi]);
  stubReads(context, Contributor, [profile()]);
  stubReads(context, Series, [{ slug: 'ideas', title: 'Ideas', profileVisible: true }]);
  const app = makeApp(publicRouter);
  for (const base of ['/contributors/shared-writer', '/series/ideas']) {
    const response = await request(app).get(`${base}/articles?language=hi`);
    assert.equal(response.status, 200);
    assert.equal(response.body.total, 2);
    const translated = response.body.items.find((item) => item.translationKey === 'cached-story');
    const fallback = response.body.items.find((item) => item.slug === pending.slug);
    assert.equal(translated.title, 'Hindi cached title');
    assert.equal(translated.resolvedLang, 'hi');
    assert.equal(fallback.title, pending.title);
    assert.equal(fallback.resolvedLang, 'en');
    assert.equal(fallback.requestedLang, 'hi');
    assert.equal((await request(app).get(`${base}/articles`).set('X-Lang', 'en')).body.lang, 'en');
    const defaultLocale = await request(app).get(`${base}/articles`);
    assert.equal(defaultLocale.body.lang, 'gu');
    assert.equal(defaultLocale.body.items.every((item) => item.resolvedLang === 'en'), true);
  }
});

test('group identity falls back to the existing canonical slug and document identity', async (context) => {
  stubReads(context, Contributor, [profile()]);
  stubReads(context, News, [
    article(1, { translationGroupId: null, slug: 'one-en', slugs: { en: 'one' } }),
    article(2, { translationGroupId: null, slug: 'one-hi', slugs: { en: 'one' }, language: 'hi', lang: 'hi', originalLang: 'hi' }),
    article(3, { translationGroupId: null, slug: null }),
  ]);
  const app = makeApp(publicRouter);
  assert.equal((await request(app).get('/contributors/shared-writer')).body.contributor.contributionCount, 2);
  assert.equal((await request(app).get('/contributors/shared-writer/articles?lang=hi')).body.total, 2);
});

test('visibility/status Admin updates invalidate only Pulse Dialogue category caches', async (context) => {
  const cache = require('../lib/cache');
  const prefixes = [];
  context.mock.method(cache, 'safeDeleteByPrefix', async (prefix) => { prefixes.push(prefix); return 1; });
  context.mock.method(cache, 'invalidateArticleCaches', () => assert.fail('Broad invalidation is forbidden'));
  context.mock.method(Contributor, 'findByIdAndUpdate', async (_id, patch) => profile({ ...patch.$set, slugHistory: ['shared-writer'] }));
  const app = makeApp(adminRouter);
  for (const payload of [{ status: 'hidden' }, { profileVisible: false }, { status: 'inactive', profileVisible: true }]) {
    assert.equal((await request(app).patch(`/${contributorId}`).set('Authorization', `Bearer ${token}`).send(payload)).status, 200);
  }
  assert.deepEqual(prefixes, Array(3).fill('np:v1:category:pulse-dialogue:'));
  assert.equal((await request(app).patch(`/${contributorId}`).set('Authorization', `Bearer ${token}`).send({ shortBio: 'Updated bio' })).status, 200);
  assert.equal(prefixes.length, 3);
});

test('Series assignment accepts only existing request fields and null clears both label and identity', () => {
  const parsed = normalizePulseDialoguePayload({ pulseDialogue: { contributorId, series: null, seriesSlug: null } },
    { category: 'pulse-dialogue', partial: true });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.value, { contributorId, series: null, seriesSlug: null });
  assert.equal(normalizePulseDialoguePayload({ pulseDialogue: { series: null, seriesSlug: null } },
    { category: 'pulse-dialogue', partial: true }).ok, false);
});

test('all six documented public JSON response examples match actual route serialization', async (context) => {
  const fs = require('node:fs');
  const path = require('node:path');
  const contract = fs.readFileSync(path.join(__dirname, '../docs/PULSE_DIALOGUE_PHASE2_CONTRACT.md'), 'utf8').replace(/\r\n/g, '\n');
  const contributor = { _id: contributorId, slug: 'writer', canonicalName: 'Writer', status: 'active', profileVisible: true };
  const series = { slug: 'ideas', title: 'Ideas', description: null, profileVisible: true, ownerContributorId: contributorId };
  const docs = ['en', 'hi', 'gu'].map((language, index) => ({
    _id: String(index + 1).padStart(24, '0'), title: `Story ${language}`, description: 'Summary', content: '<p>Body</p>',
    slug: `story-${language}`, slugs: { en: 'story-en', hi: 'story-hi', gu: 'story-gu' },
    category: 'pulse-dialogue', status: 'published', language, lang: language, originalLang: language,
    translationKey: 'story-1', translationGroupId: 'story-1', publishedAt: '2020-01-01T00:00:00.000Z',
    pulseDialogue: { contributorId, dialogueFormat: 'column', series: 'Ideas', seriesSlug: 'ideas',
      bylineSnapshot: { name: 'Writer', designation: null, affiliation: null, photo: null } },
  }));
  stubReads(context, Contributor, [contributor]);
  stubReads(context, Series, [series]);
  stubReads(context, News, docs);
  const app = makeApp(publicRouter);
  for (const url of ['/contributors', '/contributors/writer', '/contributors/writer/articles?lang=en',
    '/series', '/series/ideas', '/series/ideas/articles?lang=en']) {
    const section = contract.split(`### Response: GET ${url}\n`)[1];
    assert.ok(section, `Missing documented response: ${url}`);
    const example = JSON.parse(section.match(/```json\r?\n([\s\S]*?)```/)[1]);
    const response = await request(app).get(url);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, example, url);
  }
});

function stubContributorSlugStore(context, contributors) {
  const originalFlag = process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED;
  process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED = 'true';
  context.after(() => {
    if (originalFlag === undefined) delete process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED;
    else process.env.PULSE_DIALOGUE_CONTRIBUTOR_SLUG_RENAME_ENABLED = originalFlag;
  });
  const { HISTORY_INDEX } = require('../lib/contributorSlugReadiness');
  context.mock.method(Contributor.collection, 'listIndexes', () => ({ toArray: async () => [
    { name: 'slug_1', key: { slug: 1 }, unique: true }, { key: HISTORY_INDEX.key, ...HISTORY_INDEX.options },
  ] }));
  context.mock.method(Contributor.collection, 'findOne', async () => null);
  stubReads(context, Contributor, contributors);
  context.mock.method(Contributor, 'findById', (id) => queryResult(contributors.filter((doc) => doc._id === id), true));
  context.mock.method(Contributor, 'exists', async (filter) => contributors.find((doc) => matches(doc, filter)) || null);
  const assertAvailable = (candidate) => {
    const reserved = new Set([candidate.slug, ...(candidate.slugHistory || [])]);
    if (contributors.some((doc) => doc._id !== candidate._id
      && [doc.slug, ...(doc.slugHistory || [])].some((slug) => reserved.has(slug)))) {
      throw Object.assign(new Error('duplicate reserved slug'), { code: 11000, keyPattern: { slugHistory: 1 } });
    }
  };
  context.mock.method(Contributor, 'findOneAndUpdate', async (filter, patch, options) => {
    assert.equal(options.runValidators, true);
    const current = contributors.find((doc) => matches(doc, filter));
    if (!current) return null;
    const updated = { ...current, ...patch.$set };
    assertAvailable(updated);
    Object.assign(current, updated);
    return structuredClone(current);
  });
  context.mock.method(Contributor, 'create', async (payload) => {
    const doc = { _id: String(contributors.length + 1).padStart(24, '0'), ...payload };
    assertAvailable(doc);
    contributors.push(doc);
    return structuredClone(doc);
  });
}

test('dedicated slug action preserves legacy identity, resolves old URLs, and never rewrites snapshots', async (context) => {
  const contributors = [profile()];
  stubContributorSlugStore(context, contributors);
  const docs = ['en', 'hi', 'gu'].map((language, index) => article(index + 1,
    { language, lang: language, originalLang: language, translationGroupId: 'one-story' }));
  const snapshots = structuredClone(docs);
  stubReads(context, News, docs);
  context.mock.method(News, 'updateMany', () => assert.fail('No News writes allowed'));
  context.mock.method(PublicArticle, 'findOneAndUpdate', () => assert.fail('No snapshot sync allowed'));
  const invalidations = [];
  context.mock.method(require('../lib/cache'), 'safeDeleteByPrefix', async (prefix) => invalidations.push(prefix));
  const admin = makeApp(adminRouter);
  const endpoint = `/${contributorId}/slug`;
  assert.equal((await request(admin).patch(endpoint).send({ slug: 'denied' })).status, 401);
  for (const payload of [{}, { slug: null }, { slug: {} }, { slug: '!!!' }, { slug: 'new', canonicalName: 'Accidental edit' }]) {
    assert.equal((await request(admin).patch(endpoint).set('Authorization', `Bearer ${token}`).send(payload)).status, 400);
  }
  const changed = await request(admin).patch(endpoint).set('Authorization', `Bearer ${token}`)
    .send({ slug: 'Shared Writer Journalist!' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.contributor.slug, 'shared-writer-journalist');
  assert.deepEqual(changed.body.contributor.slugHistory, ['shared-writer', 'shared-writer-journalist']);
  assert.equal(changed.body.contributor.canonicalName, 'Shared Writer');
  assert.deepEqual(invalidations, ['np:v1:category:pulse-dialogue:']);
  const app = makeApp(publicRouter);
  const old = await request(app).get('/contributors/shared-writer');
  assert.equal(old.status, 200);
  assert.equal(old.headers.location, undefined);
  assert.equal(old.body.contributor.slug, 'shared-writer-journalist');
  assert.equal(old.body.contributor.contributionCount, 1);
  assert.equal(old.body.requestedSlug, 'shared-writer');
  assert.equal(old.body.canonicalSlug, 'shared-writer-journalist');
  assert.equal(old.body.redirectRequired, true);
  assert.equal(old.body.contributor.slugHistory, undefined);
  const contract = require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../docs/PULSE_DIALOGUE_PHASE2_CONTRACT.md'), 'utf8').replace(/\r\n/g, '\n');
  const aliasExample = contract.split('### Old-Slug Profile Response')[1].match(/```json\r?\n([\s\S]*?)```/)[1];
  assert.deepEqual(old.body, JSON.parse(aliasExample));
  const canonical = await request(app).get('/contributors/shared-writer-journalist');
  assert.deepEqual(canonical.body.contributor, old.body.contributor);
  assert.equal(canonical.body.redirectRequired, undefined);
  for (const lang of ['en', 'hi', 'gu']) {
    const archive = await request(app).get(`/contributors/shared-writer/articles?lang=${lang}`);
    assert.equal(archive.status, 200);
    assert.equal(archive.body.redirectRequired, true);
    assert.equal(archive.body.canonicalSlug, 'shared-writer-journalist');
    assert.equal(archive.body.total, 1);
    assert.equal(archive.body.items.length, 1);
    assert.equal(archive.body.items[0].resolvedLang, lang);
    assert.equal(archive.body.items[0].pulseDialogue.contributorSlug, 'shared-writer-journalist');
    assert.deepEqual(archive.body.items[0].pulseDialogue.bylineSnapshot, snapshots[0].pulseDialogue.bylineSnapshot);
  }
  for (const state of [{ status: 'inactive', profileVisible: true }, { status: 'hidden' }, { status: 'draft' }, { status: 'active', profileVisible: false }]) {
    Object.assign(contributors[0], state);
    const reachable = state.status === 'inactive';
    assert.equal((await request(app).get('/contributors')).body.items.length, 0);
    assert.equal((await request(app).get('/contributors/shared-writer')).status, reachable ? 200 : 404);
    assert.equal((await request(app).get('/contributors/shared-writer/articles')).status, reachable ? 200 : 404);
  }
  assert.deepEqual(docs, snapshots);
});

test('current and historical slugs cannot be claimed by another contributor through creation or renaming', async (context) => {
  const otherId = '507f1f77bcf86cd799439a02';
  const contributors = [profile(), profile({ _id: otherId, slug: 'other-writer' })];
  stubContributorSlugStore(context, contributors);
  const app = makeApp(adminRouter);
  const rename = (id, slug) => request(app).patch(`/${id}/slug`).set('Authorization', `Bearer ${token}`).send({ slug });
  assert.equal((await rename(contributorId, 'journalist')).status, 200);
  assert.equal((await rename(contributorId, 'journalist-new')).status, 200);
  assert.deepEqual(contributors[0].slugHistory, ['shared-writer', 'journalist', 'journalist-new']);
  for (const slug of contributors[0].slugHistory) {
    assert.equal((await rename(otherId, slug)).status, 409);
    assert.equal((await request(app).post('/').set('Authorization', `Bearer ${token}`)
      .send({ canonicalName: 'Impersonator', slug })).status, 409);
  }
  assert.equal((await rename(contributorId, 'other-writer')).status, 409);
  const generated = await request(app).post('/').set('Authorization', `Bearer ${token}`).send({ canonicalName: 'Shared Writer' });
  assert.equal(generated.status, 201);
  assert.equal(generated.body.contributor.slug, 'shared-writer-2');
  assert.deepEqual(generated.body.contributor.slugHistory, ['shared-writer-2']);
  assert.equal((await rename(contributorId, 'shared-writer')).status, 200);
  assert.deepEqual(contributors[0].slugHistory, ['shared-writer', 'journalist', 'journalist-new']);
  assert.equal((await rename(otherId, 'journalist-new')).status, 409);
  assert.equal((await rename('507f1f77bcf86cd799439fff', 'missing')).status, 404);
  assert.equal((await rename('invalid', 'missing')).status, 400);
  const index = Contributor.schema.indexes().find(([keys]) => keys.slugHistory === 1);
  assert.equal(index[1].unique, true);
  assert.deepEqual(index[1].partialFilterExpression, { 'slugHistory.0': { $exists: true } });
});

test('concurrent slug updates preserve reservations and reject stale same-contributor edits', async (context) => {
  const otherId = '507f1f77bcf86cd799439a02';
  const contributors = [profile(), profile({ _id: otherId, slug: 'other-writer' })];
  stubContributorSlugStore(context, contributors);
  const app = makeApp(adminRouter);
  const rename = (id, slug) => request(app).patch(`/${id}/slug`).set('Authorization', `Bearer ${token}`).send({ slug });
  const results = await Promise.all([rename(contributorId, 'contested'), rename(otherId, 'contested')]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  context.mock.method(Contributor, 'exists', async () => null);
  context.mock.method(Contributor, 'findOneAndUpdate', async () => {
    throw Object.assign(new Error('unique index race'), { code: 11000, keyPattern: { slugHistory: 1 } });
  });
  assert.equal((await rename(contributorId, 'race')).status, 409);
  context.mock.method(Contributor, 'findOneAndUpdate', async () => null);
  const stale = await rename(contributorId, 'stale');
  assert.equal(stale.status, 409);
  assert.match(stale.body.message, /reload and retry/);
});

test('enabled slug action normalizes old/current/new reservations and exposes only a capability boolean', async (context) => {
  const contributors = [profile({ slugHistory: [' SHARED-WRITER ', 'PAST%2DNAME', 'past-name', null, 123] })];
  stubContributorSlugStore(context, contributors);
  const app = makeApp(adminRouter);
  const capability = await request(app).get('/capabilities').set('Authorization', `Bearer ${token}`);
  assert.deepEqual(capability.body.capabilities, { slugRename: true });
  const changed = await request(app).patch(`/${contributorId}/slug`).set('Authorization', `Bearer ${token}`)
    .send({ slug: ' NEW%2DName ' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.contributor.slug, 'new-name');
  assert.deepEqual(changed.body.contributor.slugHistory, ['shared-writer', 'past-name', 'new-name']);
});