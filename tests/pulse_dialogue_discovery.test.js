const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
const News = require('../models/News');
const Contributor = require('../models/Contributor');
const Series = require('../models/PulseDialogueSeries');
const Curation = require('../models/PulseDialogueCuration');
const Event = require('../models/ArticleAnalyticsEvent');
const Dedup = require('../models/ArticleAnalyticsDedup');
const discovery = require('../services/pulseDialogueDiscovery.service');
const curation = require('../services/pulseDialogueCuration.service');
const { matches, runPipeline, stubAggregate } = require('./helpers/pulseDialogueAggregate');

const objectId = number => new mongoose.Types.ObjectId(number.toString(16).padStart(24, '0'));
const writerId = objectId(1000);
const otherWriterId = objectId(1001);

function story(number, overrides = {}) {
  return { _id: objectId(number), title: `Story ${number}`, description: 'Description', content: '<p>Private full article body</p>',
    slug: `story-${number}`, category: 'pulse-dialogue', status: 'published', lang: 'en', language: 'en', originalLang: 'en',
    translationKey: `group-${number}`, translationGroupId: `group-${number}`,
    publishedAt: new Date('2020-01-01'), createdAt: new Date('2020-01-01'),
    pulseDialogue: { contributorId: writerId, dialogueFormat: 'essay', series: 'Ideas', seriesSlug: 'ideas',
      bylineSnapshot: { name: 'Historical Writer' }, editorNote: 'Existing note' }, ...overrides };
}

function writer(overrides = {}) {
  return { _id: writerId, slug: 'writer', canonicalName: 'Writer', status: 'active', profileVisible: true,
    internalEmail: 'private@example.test', ...overrides };
}

function query(rows, single = false) {
  let values = rows.slice();
  return { select(fields) {
    const allowed = new Set(['_id', ...fields.split(' ').map(field => field.split('.')[0])]);
    values = values.map(doc => Object.fromEntries(Object.entries(doc).filter(([key]) => allowed.has(key))));
    return this;
  }, maxTimeMS(value) { assert.equal(value, 2500); return this; }, limit(value) { values = values.slice(0, value); return this; },
  skip(value) { values = values.slice(value); return this; }, sort(order) { values = runPipeline(values, [{ $sort: order }]); return this; },
  lean: async () => single ? values[0] || null : values };
}

function reads(context, Model, docs) {
  context.mock.method(Model, 'find', filter => query(docs.filter(doc => matches(doc, filter))));
  context.mock.method(Model, 'findOne', filter => query(docs.filter(doc => matches(doc, filter)), true));
  context.mock.method(Model, 'countDocuments', async filter => docs.filter(doc => matches(doc, filter)).length);
}

function setup(context, docs = [], profiles = [writer()]) {
  const calls = [];
  stubAggregate(context, News, docs, calls);
  reads(context, News, docs);
  reads(context, Contributor, profiles);
  reads(context, Series, [{ _id: objectId(2000), slug: 'ideas', title: 'Ideas', profileVisible: true }]);
  let configuration = { featuredDialogue: [], featuredVoices: [], updatedAt: null };
  context.mock.method(Curation, 'findById', () => query([configuration], true));
  context.mock.method(Curation, 'findByIdAndUpdate', async (_id, update, options) => {
    assert.equal(options.runValidators, true);
    configuration = { ...configuration, ...update.$set };
    return configuration;
  });
  const app = express();
  app.use(express.json());
  app.use('/api/public/pulse-dialogue', require('../routes/publicPulseDialogue.routes'));
  app.use('/api/admin/pulse-dialogue/curation', require('../routes/adminPulseDialogueCuration.routes'));
  app.use('/api/analytics', require('../routes/articleAnalytics.routes'));
  return { app, calls, configure(value) { configuration = { ...configuration, ...value }; } };
}

test('Phase 3 articles enforce every public gate and remain Pulse-only across translation siblings', async context => {
  const exclusions = [{ category: 'national' }, { category: 'regional' }, { status: 'draft' }, { status: 'archived' },
    { status: 'scheduled' }, { deletedAt: new Date() }, { locked: true }, { visibility: 'private' }, { isPrivate: true },
    { embargoUntil: new Date('2999-01-01') }, { publishedAt: new Date('2999-01-01') }, { publishAt: new Date('2999-01-01') },
    { scheduledAt: new Date('2999-01-01') }, { workflow: { locked: true } }, { workflow: { embargoUntil: new Date('2999-01-01') } }];
  const docs = [story(1), ...exclusions.map((change, index) => story(index + 2, change)),
    story(40, { category: 'national', language: 'hi', lang: 'hi', originalLang: 'hi', translationKey: 'group-1' })];
  const { app } = setup(context, docs);
  const response = await request(app).get('/api/public/pulse-dialogue/articles?lang=hi&q=Story');
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items.length, 1);
  assert.equal(response.body.items[0].category, 'pulse-dialogue');
  assert.equal(response.body.items[0].resolvedLang, 'en');
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('contributor, canonical Series and formats are ANDed; selected format values are ORed', async context => {
  const pulse = story(1).pulseDialogue;
  const docs = [story(1), story(2, { pulseDialogue: { ...pulse, dialogueFormat: 'literary_essay' } }),
    story(3, { pulseDialogue: { ...pulse, dialogueFormat: 'column' } }),
    story(4, { pulseDialogue: { ...pulse, seriesSlug: 'other' } }),
    story(5, { pulseDialogue: { ...pulse, contributorId: otherWriterId } })];
  const { app } = setup(context, docs, [writer(), writer({ _id: otherWriterId, slug: 'other' })]);
  for (const [params, total] of [['contributor=writer', 4], ['seriesSlug=ideas', 4], ['dialogueFormat=essay', 3],
    ['dialogueFormat=essay,literary_essay', 4], ['contributor=writer&seriesSlug=ideas&dialogueFormat=essay,literary_essay', 2]]) {
    const response = await request(app).get(`/api/public/pulse-dialogue/articles?${params}`);
    assert.equal(response.status, 200, params);
    assert.equal(response.body.total, total, params);
  }
  for (const params of ['contributor=missing', 'seriesSlug=missing']) {
    assert.equal((await request(app).get(`/api/public/pulse-dialogue/articles?${params}`)).status, 400);
  }
});

test('strict Phase 3 input validation rejects invalid scalars, bounds, locales and formats', async context => {
  const { app } = setup(context);
  const invalid = ['page=0', 'page=-1', 'page=1.5', 'page=1001', 'page=abc', 'page=1&page=2', 'limit=0', 'limit=25',
    'lang=fr', 'lang=en-US', 'sort=popular', 'dialogueFormat=unknown', 'dialogueFormat=essay,', 'dialogueFormat=essay,essay',
    'contributor=bad%20slug', 'seriesSlug=../bad', 'q[x]=bad', `q=${'a'.repeat(81)}`, 'category=national'];
  for (const params of invalid) {
    const response = await request(app).get(`/api/public/pulse-dialogue/articles?${params}`);
    assert.equal(response.status, 400, params);
  }
  const response = await request(app).get('/api/public/pulse-dialogue/articles');
  assert.deepEqual(response.body, { ok: true, items: [], lang: 'gu', total: 0, count: 0, page: 1, limit: 12, totalPages: 0, hasNextPage: false });
});

test('article search escapes literals, trims input, and searches only title, summary and description', async context => {
  const { app } = setup(context, [story(1, { title: 'Literal [query]' }), story(2, { summary: 'Literal [query]' }),
    story(3, { description: 'Literal [query]' }), story(4, { content: '<p>Literal [query]</p>' }),
    story(5, { title: 'Literal [query]', status: 'draft' })]);
  const response = await request(app).get('/api/public/pulse-dialogue/articles').query({ q: '  [query]  ' });
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 3);
  assert.equal((await request(app).get('/api/public/pulse-dialogue/articles?q=.*')).body.total, 0);
});

test('unique-story pagination is stable newest/oldest and hydrates only the compact requested page', async context => {
  const docs = Array.from({ length: 30 }, (_, index) => story(index + 1));
  docs.push(story(100, { translationKey: 'group-1', translationGroupId: 'group-1', language: 'hi', originalLang: 'hi', lang: 'hi' }));
  const { app, calls } = setup(context, docs);
  const newest = await request(app).get('/api/public/pulse-dialogue/articles?lang=en&limit=2');
  assert.equal(newest.body.total, 30);
  assert.equal(newest.body.totalPages, 15);
  assert.deepEqual(newest.body.items.map(item => item.translationKey), ['group-30', 'group-29']);
  const oldest = await request(app).get('/api/public/pulse-dialogue/articles?lang=en&limit=2&sort=oldest');
  assert.deepEqual(oldest.body.items.map(item => item.translationKey), ['group-1', 'group-2']);
  const second = await request(app).get('/api/public/pulse-dialogue/articles?lang=en&limit=2&page=2&sort=oldest');
  assert.deepEqual(second.body.items.map(item => item.translationKey), ['group-3', 'group-4']);
  for (const item of [...newest.body.items, ...oldest.body.items]) {
    assert.equal(item.content, undefined);
    assert.equal(item.translations, undefined);
    assert.equal(item._storyKey, undefined);
    assert.equal(item.pulseDialogue.contributor.internalEmail, undefined);
    assert.equal(item.pulseDialogue.seriesSlug, 'ideas');
    assert.equal(item.pulseDialogue.editorNote, 'Existing note');
  }
  assert.equal(calls.length, 6);
  for (const pipeline of calls.filter(stages => stages.some(stage => stage.$replaceRoot))) {
    assert.equal(pipeline.find(stage => stage.$limit).$limit, 2);
    assert.notEqual(pipeline.at(-1).$project.content, 1);
    assert.ok(pipeline.find(stage => stage.$group));
  }
});

test('EN HI GU editions and ready cached translations resolve without duplicated stories', async context => {
  const docs = ['en', 'hi', 'gu'].map((lang, index) => story(index + 1, { title: `${lang} edition`, language: lang, lang,
    originalLang: lang, translationKey: 'same-story', translationGroupId: 'same-story' }));
  docs.push(story(4, { translations: { hi: { title: 'Cached Hindi', summary: 'Summary', content: '<p>Body</p>' } },
    translationStatus: { hi: 'ready' } }));
  const { app } = setup(context, docs);
  for (const lang of ['en', 'hi', 'gu']) {
    const response = await request(app).get(`/api/public/pulse-dialogue/articles?lang=${lang}`);
    assert.equal(response.body.total, 2);
    assert.equal(response.body.count, 2);
    assert.equal(response.body.items.find(item => item.translationKey === 'same-story').title, `${lang} edition`);
    if (lang === 'hi') assert.equal(response.body.items.find(item => item.translationKey === 'group-4').title, 'Cached Hindi');
  }
});

test('curation preserves ordered references, rejects duplicates and ineligible targets, and declares no indexes', async context => {
  const profiles = [writer(), writer({ _id: otherWriterId, slug: 'other' }), writer({ _id: objectId(1002), slug: 'inactive', status: 'inactive' })];
  setup(context, [story(1), story(2), story(3, { status: 'draft' }), story(4, { category: 'national' }),
    story(5, { translationKey: 'group-1' })], profiles);
  const ids = [String(objectId(2)), String(objectId(1))];
  const configuration = await curation.setList('featuredDialogue', { articleIds: ids });
  assert.deepEqual(configuration.featuredDialogue.map(item => item.id), ids);
  for (const selected of [[ids[0], ids[0]], Array(7).fill(ids[0]), [String(objectId(3))], [String(objectId(4))],
    [String(objectId(1)), String(objectId(5))], ['invalid']]) {
    await assert.rejects(curation.setList('featuredDialogue', { articleIds: selected }), error => error.statusCode === 400);
  }
  await assert.rejects(curation.setList('featuredVoices', { contributorIds: [String(objectId(1002))] }));
  const voices = await curation.setList('featuredVoices', { contributorIds: [String(otherWriterId), String(writerId)] });
  assert.deepEqual(voices.featuredVoices.map(item => item.slug), ['other', 'writer']);
  assert.equal(voices.featuredVoices[0].internalEmail, undefined);
  assert.equal(Curation.schema.options.autoIndex, false);
  assert.equal(Curation.schema.options.autoCreate, false);
  assert.deepEqual(Curation.schema.indexes(), []);
});

test('discovery batches all previews, preserves curated order, and omits unavailable configured references', async context => {
  const formats = ['column', 'guest_column', 'essay', 'literary_essay', 'culture_ideas', 'conversation', 'interview',
    'viewpoint', 'expert_perspective', 'open_letter'];
  const docs = formats.map((dialogueFormat, index) => story(index + 1, { pulseDialogue: { ...story(1).pulseDialogue, dialogueFormat } }));
  const profiles = [writer(), writer({ _id: otherWriterId, slug: 'other' }),
    ...['inactive', 'hidden', 'draft'].map((status, index) => writer({ _id: objectId(1002 + index), slug: status, status })),
    writer({ _id: objectId(1005), slug: 'invisible', profileVisible: false })];
  const { app, calls, configure } = setup(context, docs, profiles);
  configure({ featuredDialogue: [objectId(3), objectId(1), objectId(99)],
    featuredVoices: [otherWriterId, writerId, ...profiles.slice(2).map(profile => profile._id)] });
  const response = await request(app).get('/api/public/pulse-dialogue/discovery?lang=en');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.featuredDialogue.map(item => item.translationKey), ['group-3', 'group-1']);
  assert.deepEqual(response.body.featuredVoices.map(item => item.slug), ['other', 'writer']);
  for (const [key, values] of Object.entries(discovery.FORMAT_GROUPS)) {
    assert.ok(response.body.formatGroups[key].length > 0);
    assert.ok(response.body.formatGroups[key].length <= 4);
    assert.ok(response.body.formatGroups[key].every(item => values.includes(item.pulseDialogue.dialogueFormat) && item.content === undefined));
  }
  assert.equal(calls.length, 2);
  assert.equal(Object.keys(calls[0].at(-1).$facet).length, 5);
  docs[2].status = 'draft';
  profiles[0].profileVisible = false;
  const changed = await request(app).get('/api/public/pulse-dialogue/discovery?lang=en');
  assert.deepEqual(changed.body.featuredDialogue.map(item => item.translationKey), ['group-1']);
  assert.deepEqual(changed.body.featuredVoices.map(item => item.slug), ['other']);
  assert.equal((await curation.getConfiguration()).featuredDialogue.length, 3);
});

test('empty discovery is safe and Founder curation endpoints require authenticated editorial policy', async context => {
  const { app } = setup(context);
  const response = await request(app).get('/api/public/pulse-dialogue/discovery?lang=gu');
  assert.deepEqual(response.body, { ok: true, lang: 'gu', featuredDialogue: [], featuredVoices: [],
    formatGroups: { columns: [], essays: [], culture: [], conversations: [] } });
  assert.equal((await request(app).get('/api/public/pulse-dialogue/discovery?lang=fr')).status, 400);
  assert.equal((await request(app).get('/api/admin/pulse-dialogue/curation')).status, 401);
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'isolated-curation-test-secret';
  context.after(() => { if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous; });
  for (const role of ['founder', 'reporter', 'admin', 'editor']) {
    const token = jwt.sign({ sub: String(writerId), role }, process.env.JWT_SECRET);
    const result = await request(app).get('/api/admin/pulse-dialogue/curation').set('Authorization', `Bearer ${token}`);
    assert.equal(result.status, role === 'founder' ? 200 : 403, role);
  }
});

test('discovery analytics validates targets, stores only allowed events, deduplicates and fails independently', async context => {
  const { app } = setup(context, [story(1)]);
  const state = mongoose.connection.readyState;
  const localhost = process.env.ANALYTICS_ALLOW_LOCALHOST;
  mongoose.connection.readyState = 1;
  process.env.ANALYTICS_ALLOW_LOCALHOST = 'true';
  context.after(() => { mongoose.connection.readyState = state;
    if (localhost === undefined) delete process.env.ANALYTICS_ALLOW_LOCALHOST; else process.env.ANALYTICS_ALLOW_LOCALHOST = localhost; });
  const events = [];
  context.mock.method(Dedup, 'updateOne', async () => ({ modifiedCount: 1 }));
  context.mock.method(Event, 'create', async value => { events.push(value); return value; });
  for (const event of Event.DISCOVERY_EVENT_TYPES) {
    const target = event === 'featured_dialogue_click' ? { articleId: String(objectId(1)) }
      : event === 'series_click' ? { seriesSlug: 'ideas' } : { contributorSlug: 'writer' };
    const response = await request(app).post('/api/analytics/discovery').send({ event, lang: 'en', visitorId: 'visitor', sessionId: 'session', ...target });
    assert.equal(response.status, 200);
    assert.equal(response.body.skipped, false);
  }
  assert.equal(events.length, 4);
  assert.ok(events.every(event => event.visitorId !== 'visitor' && event.targetId));
  for (const payload of [{ event: 'view' }, { event: 'series_click', seriesSlug: 'missing', visitorId: 'visitor', sessionId: 'session' },
    { event: 'series_click', seriesSlug: 'ideas', visitorId: 'x'.repeat(129), sessionId: 'session' }]) {
    assert.equal((await request(app).post('/api/analytics/discovery').send(payload)).status, 400);
  }
  const payload = { event: 'series_click', seriesSlug: 'ideas', visitorId: 'visitor', sessionId: 'session' };
  context.mock.method(Dedup, 'updateOne', async () => ({ modifiedCount: 0 }));
  context.mock.method(Dedup, 'create', async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); });
  assert.equal((await request(app).post('/api/analytics/discovery').send(payload)).body.reason, 'cooldown');
  context.mock.method(Dedup, 'updateOne', async () => { throw new Error('Unavailable'); });
  const failed = await request(app).post('/api/analytics/discovery').send(payload);
  assert.deepEqual(failed.body, { ok: true, skipped: true, reason: 'unavailable' });
  assert.equal((await request(app).get('/api/public/pulse-dialogue/articles?lang=en')).status, 200);
});

test('discovery enforces actual six/four caps and never duplicates translated previews', async context => {
  const docs = Object.values(discovery.FORMAT_GROUPS).flatMap((formats, groupIndex) => Array.from({ length: 8 }, (_, index) =>
    story(groupIndex * 20 + index + 1, { pulseDialogue: { ...story(1).pulseDialogue, dialogueFormat: formats[0] } })));
  docs.push({ ...docs[0], _id: objectId(500), lang: 'hi', language: 'hi', originalLang: 'hi' });
  const profiles = Array.from({ length: 6 }, (_, index) => writer({ _id: objectId(1000 + index), slug: `writer-${index}` }));
  const { app, configure } = setup(context, docs, profiles);
  const ids = docs.slice(0, 6).map(doc => doc._id);
  const configured = await curation.setList('featuredDialogue', { articleIds: ids.map(String) });
  assert.equal(configured.featuredDialogue.length, 6);
  configure({ featuredVoices: profiles.map(profile => profile._id) });
  const response = await request(app).get('/api/public/pulse-dialogue/discovery?lang=hi');
  assert.equal(response.body.featuredDialogue.length, 6);
  assert.equal(response.body.featuredVoices.length, 6);
  for (const cards of Object.values(response.body.formatGroups)) {
    assert.equal(cards.length, 4);
    assert.equal(new Set(cards.map(card => card.translationKey)).size, 4);
  }
  const latest = await request(app).get('/api/public/pulse-dialogue/articles?lang=hi&limit=24');
  assert.equal(latest.body.count, 24);
  assert.equal(latest.body.total, 32);
});

test('persisted editor access can curate and loss of publishing rights denies curation', async context => {
  const { app } = setup(context, [story(1)]);
  const User = require('../models/User');
  const Role = require('../models/Role');
  const previous = { state: mongoose.connection.readyState, db: mongoose.connection.db, secret: process.env.JWT_SECRET };
  mongoose.connection.readyState = 1;
  mongoose.connection.db = {};
  process.env.JWT_SECRET = 'isolated-editor-test-secret';
  context.after(() => { mongoose.connection.readyState = previous.state; mongoose.connection.db = previous.db;
    if (previous.secret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.secret; });
  const user = { _id: writerId, role: 'editor', status: 'active', accountStatus: 'active', noExpiry: true,
    tokenVersion: 0, moduleAccessOverride: ['manage_news'], specialRightsOverride: [] };
  context.mock.method(User, 'findById', async () => user);
  context.mock.method(require('../models/SiteSettings'), 'findOne', async () => ({
    adminModulePolicy: { version: 1, modulePolicies: { manageNews: 'available' } },
  }));
  context.mock.method(require('../models/AuditLog'), 'create', async () => ({}));
  let rights = ['news_publish'];
  context.mock.method(Role, 'findOne', () => ({ lean: async () => ({ specialRights: rights }) }));
  const token = jwt.sign({ sub: String(writerId), role: 'editor', tokenVersion: 0 }, process.env.JWT_SECRET);
  const response = await request(app).put('/api/admin/pulse-dialogue/curation/featured-dialogue')
    .set('Authorization', `Bearer ${token}`).send({ articleIds: [String(objectId(1))] });
  assert.equal(response.status, 200);
  assert.equal(response.body.configuration.featuredDialogue[0].id, String(objectId(1)));
  rights = [];
  assert.equal((await request(app).get('/api/admin/pulse-dialogue/curation').set('Authorization', `Bearer ${token}`)).status, 403);
});

test('Phase 3 database deadline failures return safe unavailable responses', async context => {
  const { app } = setup(context);
  context.mock.method(News, 'aggregate', () => ({ option() { return this; }, exec: async () => { throw Object.assign(new Error('private database detail'), { code: 50 }); } }));
  for (const endpoint of ['articles', 'discovery']) {
    const response = await request(app).get(`/api/public/pulse-dialogue/${endpoint}`);
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { ok: false, message: 'Unable to load Pulse Dialogue' });
  }
});