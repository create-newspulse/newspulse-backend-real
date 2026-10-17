require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const topics = require('../services/editorialTopics.service');
const stories = require('../services/editorialTopicStories.service');

const NOW = new Date('2026-10-10T12:00:00.000Z');
const TAG = 'topic:navratri-2026';
const OTHER_TAG = 'topic:gujarat-festivals';
const TOPIC_ID = '707f1f77bcf86cd79943a001';
const OTHER_TOPIC_ID = '707f1f77bcf86cd79943a002';
const BASE = '/api/admin/topics';
const ALIASES = [BASE, '/admin-api/admin/topics', '/admin-api/api/admin/topics'];
const objectId = number => number.toString(16).padStart(24, '0');

function install(context, options = {}) {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state, options);
  Object.assign(state, { ids, publication });
  Object.assign(state.rows.EditorialTopic[0], {
    articleTags: [TAG], pinnedArticleId: null, __v: 0,
    name: { en: 'Navratri 2026', hi: 'HI Navratri 2026', gu: 'GU Navratri 2026' },
  });
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    doc.tags = ['ordinary', `edition:${doc.language}`];
    doc.category = 'regional';
    doc.seo = { metaTitle: 'Unrelated SEO title', metaDescription: 'SEO remains independent', canonicalUrl: 'https://example.test/original' };
  }
  const find = models.News.find;
  context.mock.method(models.News, 'find', (...args) => {
    args[0] = new mongoose.Query().cast(models.News, args[0]);
    const query = find(...args);
    const lean = query.lean.bind(query);
    query.lean = async () => (await lean()).map(row => ({
      ...row, _id: new mongoose.Types.ObjectId(row._id),
      ...(row.sourceArticleId ? { sourceArticleId: new mongoose.Types.ObjectId(row.sourceArticleId) } : {}),
    }));
    return query;
  });
  state.attach = (selected = [ids[0]], topicId = TOPIC_ID, role = 'founder', base = BASE) =>
    state.request('post', `${base}/${topicId}/stories/attach`, { storyIds: selected }, role);
  state.detach = (selected = [ids[0]], topicId = TOPIC_ID, role = 'founder', base = BASE) =>
    state.request('post', `${base}/${topicId}/stories/detach`, { storyIds: selected }, role);
  state.archive = (lang = 'en', query = {}) => topics.listTopicStories('navratri-2026', { lang, ...query }, NOW);
  return state;
}

function addOtherTopic(state, overrides = {}) {
  const topic = {
    ...state.rows.EditorialTopic[0], _id: OTHER_TOPIC_ID, slug: 'gujarat-festivals',
    name: { en: 'Gujarat Festivals', hi: 'HI Festivals', gu: 'GU Festivals' },
    articleTags: [OTHER_TAG], pinnedArticleId: null, ...overrides,
  };
  state.rows.EditorialTopic.push(topic);
  return topic;
}

function addStory(state, number, overrides = {}) {
  const id = objectId(10000 + number);
  const doc = {
    _id: id, sourceArticleId: id, translationGroupId: `group-${number}`, translationKey: `group-${number}`,
    slug: `story-${number}`, slugs: { en: `story-${number}` }, title: `Story ${number}`,
    description: 'Ordinary summary', content: '<p>Ordinary content</p>', category: 'national', tags: [],
    lang: 'en', language: 'en', originalLang: 'en', status: 'published', deletedAt: null,
    publishedAt: new Date(Date.UTC(2026, 0, 1, 0, number)), createdAt: new Date('2025-01-01'),
    translations: {}, translationStatus: {}, ...overrides,
  };
  state.rows.News.push(doc);
  return doc;
}

function assertTags(state, tags) {
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    for (const tag of tags) assert.ok(doc.tags.includes(tag), `${doc._id} missing ${tag}`);
  }
}

function enableEditorialAccess(context, { right = true, policy = 'available', module = 'enabled', user = {} } = {}) {
  const oldDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = oldDb; });
  context.mock.method(SiteSettings, 'findOne', async () => ({
    adminModulePolicy: { modulePolicies: { manageNews: policy }, version: 1 },
  }));
  context.mock.method(SiteSettings, 'create', () => assert.fail('No access-policy seeding in topic tests'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('No access-policy upgrades in topic tests'));
  context.mock.method(Role, 'findOne', () => ({ lean: async () => null }));
  const find = User.findById;
  context.mock.method(User, 'findById', id => {
    const query = find(id);
    const lean = query.lean.bind(query);
    query.lean = async () => {
      const account = await lean();
      return account ? { ...account, moduleAccessStates: { manageNews: module },
        specialRightsOverride: right ? ['news_edit'] : [], ...user } : null;
    };
    return query;
  });
}

test('zero topics is a successful empty membership, not metadata discovery or category membership', async context => {
  const state = install(context);
  state.rows.News[0].title = 'Navratri 2026';
  state.rows.News[0].seo.metaTitle = TAG;
  const attached = await state.request('get', `${BASE}/${TOPIC_ID}/stories`);
  assert.equal(attached.statusCode, 200);
  assert.equal(attached.body.total, 0);
  assert.deepEqual(attached.body.items, []);
  assert.equal((await state.archive()).total, 0);
  const available = await state.request('get', `${BASE}/available?storyId=${state.ids[2]}&lang=en`);
  assert.equal(available.statusCode, 200);
  assert.equal(available.body.items[0].attached, false);
  assert.equal(available.body.items[0].membershipConsistent, true);
});

test('attach through GU updates one logical story and owned copies without rewriting any other metadata', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  const response = await state.attach([state.ids[2]]);
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.changedVariants, 3);
  assert.equal(response.body.committed, true);
  const row = response.body.items[0];
  assert.equal(row.logicalStoryId, state.ids[0]);
  assert.equal(row.articleId, state.ids[2]);
  assert.deepEqual(row.availableLanguages, ['en', 'hi', 'gu']);
  assert.equal(row.category, 'regional');
  assert.equal(row.status, 'published');
  assert.equal(row.membershipConsistent, true);
  for (const name of ['News', 'Article']) for (let index = 0; index < state.rows[name].length; index += 1) {
    const expected = before[name][index];
    expected.tags.push(TAG);
    if (name === 'News') expected.syncVersion += 1;
    assert.deepEqual(state.rows[name][index], expected);
  }
  assert.equal(state.rows.TranslationJob.length, 0);
  assert.ok(state.invalidations[0].paths.includes('/topic/navratri-2026'));
  const writes = state.calls.filter(call => ['updateOne', 'updateMany'].includes(call.method));
  assert.ok(writes.every(call => call.options.session === state.transactions[0]));
  assert.ok(writes.every(call => call.options.timestamps === false));
  for (const lang of ['gu', 'hi', 'en']) assert.equal((await state.archive(lang)).total, 1);
});

test('duplicate selections and repeated attaches are idempotent and do not deduplicate unrelated tags', async context => {
  const state = install(context);
  state.rows.News[0].tags.push('ordinary');
  assert.equal((await state.attach([state.ids[0], state.ids[0], state.ids[1]])).body.count, 1);
  const again = await state.attach();
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.changedVariants, 0);
  for (const doc of [...state.rows.News, ...state.rows.Article]) assert.equal(doc.tags.filter(tag => tag === TAG).length, 1);
  assert.equal(state.rows.News[0].tags.filter(tag => tag === 'ordinary').length, 2);
});

test('multiple topics survive detaching one; normal tags, SEO and each real category remain unchanged', async context => {
  const state = install(context);
  addOtherTopic(state);
  const tech = addStory(state, 1, { category: 'tech', tags: ['science'] });
  const gadgets = addStory(state, 2, { category: 'tech-gadgets', tags: ['devices'] });
  const ids = [state.ids[1], tech._id, gadgets._id];
  assert.equal((await state.attach(ids)).statusCode, 200);
  assert.equal((await state.attach(ids, OTHER_TOPIC_ID)).statusCode, 200);
  const detached = await state.detach(ids);
  assert.equal(detached.statusCode, 200, detached.text);
  assert.equal(detached.body.count, 3);
  assertTags(state, [OTHER_TAG]);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => !doc.tags.includes(TAG)));
  assert.deepEqual(state.rows.News.find(doc => doc._id === tech._id).tags, ['science', OTHER_TAG]);
  assert.deepEqual(state.rows.News.find(doc => doc._id === gadgets._id).tags, ['devices', OTHER_TAG]);
  assert.equal(state.rows.News.find(doc => doc._id === tech._id).category, 'tech');
  assert.equal(state.rows.News.find(doc => doc._id === gadgets._id).category, 'tech-gadgets');
  assert.equal((await state.detach(ids)).body.changedVariants, 0);
});

for (const linkage of ['source', 'key', 'cross']) {
  test(`logical story membership reuses ${linkage} identity rather than locale or slug`, async context => {
    const state = install(context);
    for (const [index, doc] of state.rows.News.entries()) {
      if (linkage === 'source') { delete doc.translationKey; delete doc.translationGroupId; }
      if (linkage === 'key') { delete doc.sourceArticleId; delete doc.translationGroupId; }
      if (linkage === 'cross') {
        delete doc.sourceArticleId;
        doc.translationGroupId = index % 2 ? 'first-key' : 'second-key';
        doc.translationKey = index % 2 ? 'second-key' : 'first-key';
      }
    }
    assert.equal((await state.attach([state.ids[1]])).body.count, 1);
    const attached = await state.request('get', `${BASE}/${TOPIC_ID}/stories?lang=hi`);
    assert.equal(attached.statusCode, 200, attached.text);
    assert.equal(attached.body.total, 1);
    assert.deepEqual(attached.body.items[0].variantIds, state.ids);
    assert.equal(attached.body.items[0].articleId, state.ids[1]);
  });
}

test('equal slugs on unrelated stories do not merge Admin membership', async context => {
  const state = install(context);
  const first = addStory(state, 1, { translationKey: null, translationGroupId: null, sourceArticleId: null, slug: 'same' });
  const second = addStory(state, 2, { translationKey: null, translationGroupId: null, sourceArticleId: null, slug: 'same' });
  assert.equal((await state.attach([first._id])).body.count, 1);
  assert.equal(state.rows.News.find(doc => doc._id === second._id).tags.includes(TAG), false);
});

test('available topics includes active, archived, upcoming and inactive states with stable selection metadata', async context => {
  const state = install(context);
  addOtherTopic(state, { expiresAt: new Date('2020-02-01') });
  state.rows.EditorialTopic.push({ ...state.rows.EditorialTopic[0], _id: objectId(43), slug: 'inactive', active: false });
  state.rows.EditorialTopic.push({ ...state.rows.EditorialTopic[0], _id: objectId(44), slug: 'upcoming', startsAt: new Date('2099-01-01') });
  const result = await stories.listAvailableTopics({ lang: 'en', limit: '2' }, NOW);
  assert.equal(result.total, 4);
  assert.equal(result.hasNextPage, true);
  const all = await stories.listAvailableTopics({ lang: 'hi' }, NOW);
  assert.deepEqual(new Set(all.items.map(item => item.promotionState)), new Set(['active', 'archived', 'upcoming', 'inactive']));
  assert.ok(all.items.every(item => item.id && item.title && item.slug));
  assert.ok(all.items.every(item => !Object.hasOwn(item, 'createdBy') && !Object.hasOwn(item, 'updatedBy')));
  assert.equal(all.items.find(item => item.id === OTHER_TOPIC_ID).membershipTag, OTHER_TAG);
  assert.equal(all.items.find(item => item.id === TOPIC_ID).assignmentSupported, false, 'shared tag is not offered for new assignment');
});

for (const [field, value] of [
  ['title', 'Unique Headline'], ['slug', 'unique-route'], ['category', 'tech-gadgets'], ['tags', ['unique-tag']],
  ['keywords', ['unique-keyword']], ['seo', { metaKeywords: 'legacy-keyword', metaTitle: 'Unique SEO' }],
  ['translations', { hi: { title: 'Localized heading' } }],
]) {
  test(`bounded Admin search uses existing ${field} metadata without making it membership`, async context => {
    const state = install(context);
    const doc = addStory(state, 1, { [field]: value });
    const q = field === 'seo' ? 'legacy-keyword' : field === 'translations' ? 'Localized heading'
      : Array.isArray(value) ? value[0] : value;
    const response = await state.request('get', `${BASE}/${TOPIC_ID}/stories/search?q=${encodeURIComponent(q)}&lang=en`);
    assert.equal(response.statusCode, 200, response.text);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.items[0].logicalStoryId, doc._id);
    assert.equal(response.body.items[0].attached, false);
    assert.equal((await state.archive()).total, 0);
  });
}

test('search treats metacharacters and dollar-prefixed text literally', async context => {
  const state = install(context);
  const doc = addStory(state, 1, { title: '$price.*literal' });
  const response = await state.request('get', `${BASE}/${TOPIC_ID}/stories/search?q=${encodeURIComponent('$price.*')}`);
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.total, 1);
  assert.equal(response.body.items[0].logicalStoryId, doc._id);
});

test('candidate discovery returns localized/content evidence and never auto-attaches, writes or generates translations', async context => {
  const state = install(context);
  state.rows.EditorialTopic[0].name = { en: 'Navratri 2026', hi: 'Navratri 2026', gu: 'Navratri 2026' };
  const first = addStory(state, 1, { description: 'Navratri celebrations are returning' });
  const second = addStory(state, 2, { translations: { gu: { content: 'Navratri community celebrations' } } });
  addStory(state, 3, { title: 'Navratri attached story', tags: [TAG] });
  const before = structuredClone(state.rows);
  const response = await state.request('get', `${BASE}/${TOPIC_ID}/candidates?lang=en&limit=1`);
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.suggestionOnly, true);
  assert.equal(response.body.total, 2);
  assert.equal(response.body.hasNextPage, true);
  assert.equal(response.body.items[0].logicalStoryId, second._id);
  assert.ok(response.body.items[0].matchReasons.some(reason => reason.field === 'translations.gu.content' && reason.term === 'navratri'));
  const page2 = await state.request('get', `${BASE}/${TOPIC_ID}/candidates?lang=en&limit=1&page=2`);
  assert.equal(page2.body.items[0].logicalStoryId, first._id);
  assert.ok(page2.body.items[0].matchReasons.some(reason => reason.field === 'description'));
  assert.deepEqual(state.rows, before);
  assert.equal(state.invalidations.length, 0);
});

test('discovery excludes a logical story already attached through a different edition', async context => {
  const state = install(context);
  state.rows.News[0].title = 'Navratri related story';
  state.rows.News[2].tags.push(TAG);
  const response = await state.request('get', `${BASE}/${TOPIC_ID}/candidates`);
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.total, 0);
  const attached = await state.request('get', `${BASE}/${TOPIC_ID}/stories`);
  assert.equal(attached.body.total, 1);
  assert.equal(attached.body.items[0].membershipConsistent, false);
  assert.equal((await state.attach()).body.changedVariants, 2);
});

test('discovery and search honor exact text/content bounds rather than reading unlimited bodies', async context => {
  const state = install(context);
  const within = addStory(state, 1, { content: 'x'.repeat(stories.CONTENT_LIMIT - 8) + 'Navratri' });
  addStory(state, 2, { content: 'x'.repeat(stories.CONTENT_LIMIT) + 'Navratri' });
  const response = await state.request('get', `${BASE}/${TOPIC_ID}/candidates?q=Navratri`);
  assert.equal(response.statusCode, 200, response.text);
  assert.deepEqual(response.body.items.map(item => item.logicalStoryId), [within._id]);
  addStory(state, 3, { title: 'x'.repeat(stories.TEXT_LIMIT) + 'BeyondBound' });
  const search = await state.request('get', `${BASE}/${TOPIC_ID}/stories/search?q=BeyondBound`);
  assert.equal(search.body.total, 0);
});

for (const [label, patch] of [
  ['Draft', { status: 'draft' }], ['Scheduled', { status: 'scheduled', scheduledAt: new Date('2099-01-01') }],
  ['Unpublished', { status: 'draft', publishedAt: new Date('2020-01-01') }],
  ['Soft Deleted', { status: 'deleted', deletedAt: new Date('2020-01-01') }],
  ['future publication', { publishedAt: new Date('2099-01-01') }],
  ['future schedule on published record', { scheduledAt: new Date('2099-01-01') }],
  ['private', { visibility: 'private' }], ['locked', { locked: true }],
  ['embargoed', { workflow: { embargoUntil: new Date('2099-01-01') } }],
]) {
  test(`${label} stays attached in Admin but is excluded from public topic reads`, async context => {
    const state = install(context);
    for (const doc of state.rows.News) Object.assign(doc, patch);
    assert.equal((await state.attach()).statusCode, 200);
    assert.equal((await state.request('get', `${BASE}/${TOPIC_ID}/stories`)).body.total, 1);
    assert.equal((await state.archive()).total, 0);
    assertTags(state, [TAG]);
  });
}

test('draft save, publish, edit, unpublish, republish, soft delete and restore retain membership and chronology', async context => {
  const state = install(context, { status: 'draft', copies: false });
  assert.equal((await state.attach()).statusCode, 200);
  assert.equal(state.rows.Article.length, 0, 'membership does not create public copies');
  const steps = [
    ['patch', `/api/articles/${state.ids[0]}`, { description: 'Updated source summary' }, false],
    ['post', `/api/articles/${state.ids[1]}/publish`, {}, true],
    ['patch', `/api/articles/${state.ids[0]}`, { title: 'Updated source headline' }, true],
    ['post', `/api/articles/${state.ids[2]}/unpublish`, {}, false],
    ['post', `/api/articles/${state.ids[0]}/publish`, {}, true],
    ['delete', `/api/articles/${state.ids[1]}`, undefined, false],
    ['post', `/api/articles/${state.ids[2]}/restore`, {}, true],
  ];
  let firstPublication;
  for (const [method, path, body, visible] of steps) {
    const result = await state.request(method, path, body);
    assert.equal(result.statusCode, 200, `${path}: ${result.text}`);
    assertTags(state, [TAG]);
    const page = await topics.listTopicStories('navratri-2026', { lang: 'en' });
    assert.equal(page.total, visible ? 1 : 0, path);
    if (visible) {
      firstPublication ||= new Date(state.rows.News[0].publishedAt).toISOString();
      assert.equal(new Date(state.rows.News[0].publishedAt).toISOString(), firstPublication);
    }
  }
});

test('translation updates copy current memberships without requiring independent locale assignments', async context => {
  const state = install(context);
  assert.equal((await state.attach()).statusCode, 200);
  const { syncTranslationGroupFromMaster } = require('../services/translationGroupSync.service');
  const source = state.rows.News[0];
  source.translations.hi = { title: 'Updated Hindi title', summary: 'Updated Hindi summary', content: '<p>Hindi body</p>' };
  source.translationStatus.hi = 'ready';
  const result = await syncTranslationGroupFromMaster(source, { invalidate: false });
  assert.equal(result.ok, true);
  assertTags(state, [TAG]);
});

test('expiry stops promotion only, Active OFF hides the archive without deleting topic or membership', async context => {
  const state = install(context);
  assert.equal((await state.attach()).statusCode, 200);
  const topic = state.rows.EditorialTopic[0];
  topic.expiresAt = NOW;
  const before = structuredClone(state.rows);
  assert.equal((await topics.listPublicTopics({ lang: 'en' }, NOW)).items.length, 0);
  assert.equal((await state.archive()).total, 1);
  assert.deepEqual(state.rows, before);
  topic.active = false;
  await assert.rejects(state.archive(), error => error.statusCode === 404);
  assert.equal((await state.request('get', `${BASE}/${TOPIC_ID}/stories`)).body.total, 1);
  assertTags(state, [TAG]);
  topic.active = true;
  assert.equal((await state.archive()).total, 1);
});

test('public archive is paginated beyond 12, newest-first across real categories, with unchanged card identities', async context => {
  const state = install(context);
  const seeded = Array.from({ length: 29 }, (_, index) => addStory(state, index + 1, {
    category: index % 2 ? 'tech' : 'tech-gadgets',
  }));
  assert.equal((await state.attach(seeded.map(doc => doc._id))).statusCode, 200);
  const pages = await Promise.all([1, 2, 3].map(page => state.archive('en', { page: String(page), limit: '12' })));
  assert.deepEqual(pages.map(page => page.count), [12, 12, 5]);
  assert.ok(pages.every(page => page.total === 29 && page.totalPages === 3));
  const items = pages.flatMap(page => page.items);
  assert.deepEqual(items.map(item => item.id), [...seeded].reverse().map(doc => doc._id));
  assert.deepEqual(new Set(items.map(item => item.category)), new Set(['tech', 'tech-gadgets']));
  for (const item of items) assert.equal(item.slug, seeded.find(doc => doc._id === item.id).slug);
});

test('pin remains separate presentation priority, never membership, and revalidates after detach/reattach', async context => {
  const state = install(context);
  state.rows.EditorialTopic[0].pinnedArticleId = state.ids[0];
  assert.equal((await topics.getPublicTopic('navratri-2026', { lang: 'en' }, NOW)).pinnedArticle, null);
  assert.equal((await state.attach()).statusCode, 200);
  for (const lang of ['en', 'hi', 'gu']) {
    assert.ok((await topics.getPublicTopic('navratri-2026', { lang }, NOW)).pinnedArticle);
    assert.equal((await state.archive(lang)).total, 0);
  }
  const admin = await state.request('get', `${BASE}/${TOPIC_ID}/stories`);
  assert.equal(admin.body.items[0].pinned, true);
  assert.equal(admin.body.total, 1);
  assert.equal((await state.detach()).statusCode, 200);
  assert.equal(state.rows.EditorialTopic[0].pinnedArticleId, state.ids[0]);
  assert.equal((await topics.getPublicTopic('navratri-2026', { lang: 'en' }, NOW)).pinnedArticle, null);
  assert.equal((await state.attach()).statusCode, 200);
  assert.ok((await topics.getPublicTopic('navratri-2026', { lang: 'en' }, NOW)).pinnedArticle);
});

for (const base of ALIASES) {
  test(`membership aliases enforce signed authentication and preserve Founder-only topic configuration: ${base}`, async context => {
    const state = install(context);
    const before = structuredClone(state.rows);
    assert.equal((await state.attach(undefined, TOPIC_ID, null, base)).statusCode, 401);
    assert.equal((await state.detach(undefined, TOPIC_ID, null, base)).statusCode, 401);
    assert.equal((await state.attach(undefined, TOPIC_ID, 'admin', base)).statusCode, 403);
    assert.equal((await state.detach(undefined, TOPIC_ID, 'editor', base)).statusCode, 403);
    assert.deepEqual(state.rows.News, before.News);
    assert.equal((await state.attach(undefined, TOPIC_ID, 'founder', base)).statusCode, 200);
  });
}

for (const role of ['admin', 'editor']) {
  test(`Founder-granted manage_news and news_edit permit ${role} membership, but not configuration or pin edits`, async context => {
    const state = install(context);
    enableEditorialAccess(context);
    assert.equal((await state.request('get', `${BASE}/available`, undefined, role)).statusCode, 200);
    assert.equal((await state.attach(undefined, TOPIC_ID, role)).statusCode, 200);
    assert.equal((await state.detach(undefined, TOPIC_ID, role)).statusCode, 200);
    assert.equal((await state.request('get', BASE, undefined, role)).statusCode, 403);
    assert.equal((await state.request('patch', `${BASE}/${TOPIC_ID}`, { pinnedArticleId: state.ids[0] }, role)).statusCode, 403);
  });
}

for (const denied of [
  { right: false }, { module: 'disabled' }, { policy: 'hidden' }, { policy: 'staff_locked' },
  { policy: 'founder_only' }, { user: { accountStatus: 'suspended', status: 'suspended' } },
]) {
  test(`existing access controls reject attach and detach: ${JSON.stringify(denied)}`, async context => {
    const state = install(context);
    enableEditorialAccess(context, denied);
    const before = structuredClone(state.rows.News);
    assert.equal((await state.attach(undefined, TOPIC_ID, 'editor')).statusCode, 403);
    assert.equal((await state.detach(undefined, TOPIC_ID, 'editor')).statusCode, 403);
    assert.deepEqual(state.rows.News, before);
  });
}

test('legacy exact topic:slug values keep binary membership compatibility', async context => {
  const state = install(context);
  state.rows.News[0].tags.push(TAG);
  const unrelated = addStory(state, 1, { tags: [TAG.toUpperCase(), `prefix-${TAG}`] });
  assert.equal((await state.archive()).total, 1);
  assert.equal((await state.request('get', `${BASE}/${TOPIC_ID}/stories`)).body.total, 1);
  assert.equal((await state.attach([state.ids[1]])).statusCode, 200);
  assert.equal(state.rows.News.find(doc => doc._id === unrelated._id).tags.includes(TAG), false);
});

for (const unsafe of ['ordinary', 'shared', 'mixed']) {
  test(`unsafe ${unsafe} tag changes fail atomically while legacy archive reads remain compatible`, async context => {
    const state = install(context);
    const topic = state.rows.EditorialTopic[0];
    if (unsafe === 'ordinary') topic.articleTags = ['ordinary'];
    if (unsafe === 'shared') addOtherTopic(state, { articleTags: [TAG] });
    if (unsafe === 'mixed') topic.articleTags = [TAG, 'ordinary'];
    for (const doc of state.rows.News) doc.tags.push(TAG);
    const before = structuredClone(state.rows);
    assert.equal((await state.archive()).total, 1);
    const response = await state.detach();
    assert.equal(response.statusCode, 409, response.text);
    assert.equal(response.body.code, 'UNSAFE_TOPIC_TAGS');
    assert.deepEqual(state.rows, before);
    if (unsafe !== 'mixed') {
      assert.equal((await state.attach()).statusCode, 409);
      assert.deepEqual(state.rows, before);
    }
  });
}

test('attach chooses a unique configured topic tag and detach removes all safe aliases of only that topic', async context => {
  const state = install(context);
  state.rows.EditorialTopic[0].articleTags = [TAG, 'topic:navratri-alias'];
  addOtherTopic(state, { articleTags: [TAG] });
  assert.equal((await state.attach()).statusCode, 200);
  assertTags(state, ['topic:navratri-alias']);
  assert.equal(state.rows.News.some(doc => doc.tags.includes(TAG)), false);
  assert.equal((await state.detach()).statusCode, 200);
  assert.equal(state.rows.News.some(doc => doc.tags.includes('topic:navratri-alias')), false);
});

test('malformed or missing logical identities, empty/oversized batches and extra fields cannot write', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  for (const body of [
    {}, { storyIds: [] }, { storyIds: ['bad-id'] }, { storyIds: [{ $ne: null }] },
    { storyIds: '507f1f77bcf86cd79943a001' }, { storyIds: [state.ids[0]], category: 'tech' },
    { storyIds: Array.from({ length: stories.MAX_STORY_IDS + 1 }, () => state.ids[0]) },
  ]) {
    const result = await state.request('post', `${BASE}/${TOPIC_ID}/stories/attach`, body);
    assert.equal(result.statusCode, 400, result.text);
  }
  assert.equal((await state.attach([state.ids[0], objectId(999)])).statusCode, 404);
  assert.equal((await state.attach([state.rows.Article[0]._id])).statusCode, 404, 'compatibility copy IDs are not CMS story IDs');
  assert.deepEqual(state.rows, before);
});

test('a maximum-size batch attaches 50 independent logical stories without a hidden page-sized cap', async context => {
  const state = install(context);
  const selected = Array.from({ length: stories.MAX_STORY_IDS }, (_, index) => addStory(state, index + 1));
  const response = await state.attach(selected.map(doc => doc._id));
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.count, stories.MAX_STORY_IDS);
  assert.equal(response.body.changedVariants, stories.MAX_STORY_IDS);
});

test('Admin logical expansion fails explicitly at the document budget instead of returning partial totals', async context => {
  const state = install(context);
  const docs = Array.from({ length: stories.MAX_DOCUMENTS + 1 }, (_, index) => ({
    _id: new mongoose.Types.ObjectId(objectId(index + 1)), status: 'draft', tags: [TAG],
  }));
  let bound;
  context.mock.method(models.News, 'find', () => ({
    select() { return this; }, maxTimeMS(value) { assert.equal(value, 2500); return this; },
    collation(value) { assert.deepEqual(value, { locale: 'simple' }); return this; },
    limit(value) { bound = value; return this; }, lean: async () => docs,
  }));
  const response = await state.request('get', `${BASE}/${TOPIC_ID}/stories`);
  assert.equal(response.statusCode, 503, response.text);
  assert.equal(response.body.code, 'ARTICLE_LOGICAL_QUERY_TOO_LARGE');
  assert.equal(response.body.items, undefined);
  assert.equal(bound, stories.MAX_DOCUMENTS + 1);
  assert.equal(state.invalidations.length, 0);
});

test('overlapping inconsistent translation/source identities fail closed instead of inventing a larger story', async context => {
  const state = install(context);
  addStory(state, 1, { translationKey: 'story-test-group', translationGroupId: 'alien-key' });
  addStory(state, 2, { translationKey: 'alien-key', translationGroupId: 'alien-key' });
  const before = structuredClone(state.rows);
  const response = await state.attach();
  assert.equal(response.statusCode, 409, response.text);
  assert.equal(response.body.code, 'ARTICLE_LOGICAL_IDENTITY_CONFLICT');
  assert.deepEqual(state.rows, before);
});

test('query validation rejects unknown fields, invalid pagination, language and malformed search without writes', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  for (const path of [
    `${BASE}/available?lang=fr`, `${BASE}/available?storyId=bad`,
    `${BASE}/${TOPIC_ID}/stories?limit=51`, `${BASE}/${TOPIC_ID}/stories?page=0`,
    `${BASE}/${TOPIC_ID}/stories?includePrivate=true`, `${BASE}/${TOPIC_ID}/stories?q=anything`,
    `${BASE}/${TOPIC_ID}/stories/search`, `${BASE}/${TOPIC_ID}/stories/search?q=a`,
    `${BASE}/${TOPIC_ID}/stories/search?q=${'x'.repeat(121)}`, `${BASE}/${TOPIC_ID}/candidates?q[$ne]=x`,
  ]) assert.equal((await state.request('get', path)).statusCode, 400, path);
  assert.deepEqual(state.rows, before);
});

test('a partially applied edition update rolls back every edition, copy and topic guard', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  const update = models.News.updateMany;
  context.mock.method(models.News, 'updateMany', async (_filter, patch, options) => {
    await update({ _id: state.ids[0] }, patch, options);
    throw Object.assign(new Error('Synthetic partial database failure'), { name: 'MongoNetworkError' });
  });
  const response = await state.attach();
  assert.equal(response.statusCode, 503, response.text);
  assert.deepEqual(state.rows, before);
  assert.equal(state.transactions[0].aborted, true);
  assert.equal(state.invalidations.length, 0);
});

test('failed compatibility-copy update rolls back membership rather than leaving GU/HI/EN partly attached', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  state.failures['Article.updateMany'] = { name: 'MongoNetworkError' };
  const response = await state.attach();
  assert.equal(response.statusCode, 503);
  assert.deepEqual(state.rows, before);
  assert.equal(state.invalidations.length, 0);
});

test('unacknowledged or incomplete writes cannot report success', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  context.mock.method(models.News, 'updateMany', async () => ({ acknowledged: true, matchedCount: 2 }));
  const response = await state.attach();
  assert.equal(response.statusCode, 409, response.text);
  assert.deepEqual(state.rows, before);
});

test('lack of transaction support fails before membership writes', async context => {
  const state = install(context);
  const before = structuredClone(state.rows);
  context.mock.method(mongoose, 'startSession', async () => ({
    withTransaction: async () => { throw Object.assign(new Error('Transaction support unavailable'), { code: 20 }); },
    endSession: async () => {},
  }));
  const response = await state.attach();
  assert.equal(response.statusCode, 503, response.text);
  assert.deepEqual(state.rows, before);
});

test('read failures remain distinct from successful empty results and do not leak storage details', async context => {
  const state = install(context);
  state.failures['News.find'] = { name: 'MongoServerError', code: 50 };
  const failed = await state.request('get', `${BASE}/${TOPIC_ID}/stories`);
  assert.equal(failed.statusCode, 503, failed.text);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.items, undefined);
  assert.equal(failed.text.includes('Synthetic'), false);
  delete state.failures['News.find'];
  const empty = await state.request('get', `${BASE}/${TOPIC_ID}/stories`);
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.body.items, []);
});

test('post-commit revalidation failure reports persisted membership and an explicit warning', async context => {
  const state = install(context);
  context.mock.method(global, 'fetch', async () => { throw new Error('Synthetic transport details'); });
  const response = await state.attach();
  assert.equal(response.statusCode, 200, response.text);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.revalidation.ok, false);
  assert.equal(response.body.revalidation.code, 'PUBLIC_REVALIDATION_FAILED');
  assert.equal(response.text.includes('Synthetic'), false);
  assertTags(state, [TAG]);
});
