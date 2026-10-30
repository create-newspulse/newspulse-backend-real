require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const app = require('../server');

const ARTICLE_BASES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin',
  '/admin-api/api/admin', '/api/api', '/api/api/admin'].map(prefix => `${prefix}/articles`);
const LEGACY_CREATE = ['/api/news', '/api/news/news', '/api/api/news', '/api/api/news/news'];
const DRAFT_BASES = ['/api/admin', '/admin-api/admin', '/admin-api/api/admin', '/api/api/admin']
  .map(prefix => `${prefix}/drafts`);
const CREATE_BASES = [...ARTICLE_BASES, ...LEGACY_CREATE];
const RESTORE_BASES = [...ARTICLE_BASES, ...DRAFT_BASES];
const EDITOR = { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_edit'] };
const RESTORER = { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_restore'] };
const ADD_NEWS = { moduleAccessStates: { addNews: 'enabled' } };
const DRAFT_DESK = { moduleAccessStates: { draftDesk: 'enabled' } };
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const PRIVATE = 'SYNTHETIC-DELETED-STORY';
const FOREIGN_ID = '507f1f77bcf86cd79943b999';
const CONTENT_MODELS = ['News', 'Article', 'EditorialTopic', 'TranslationJob', 'PublicConfigVersion',
  'YouthPulseSubmission', 'YouthPulseContributor', 'PushHistory', 'WorkflowEvent'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const copy = value => JSON.parse(JSON.stringify(value));
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const newDraft = {
  title: 'Synthetic authorized draft', description: 'Synthetic summary', content: '<p>Synthetic draft body</p>',
  slug: 'synthetic-authorized-draft', category: 'business', language: 'en', status: 'draft',
};
const forgedClaims = {
  role: 'founder', isFounder: true, trusted: true,
  specialRightsConfigured: true, specialRightsOverride: ['news_edit', 'news_restore'],
  moduleAccessStates: { manageNews: 'enabled', addNews: 'enabled', draftDesk: 'enabled' },
  _authUserDoc: { _id: actorId('founder'), role: 'founder' },
};

function install(context, access = {}) {
  const staff = {
    specialRightsConfigured: true, specialRightsOverride: [],
    moduleAccessStates: { manageNews: 'disabled', addNews: 'disabled', draftDesk: 'disabled' },
    ...copy(access),
  };
  const policy = { manageNews: 'available', addNews: 'available', draftDesk: 'available' };
  const state = installEditorialFixture(context, { staff, modulePolicies: policy });
  state.access = staff;
  state.policy = policy;
  context.mock.method(SiteSettings, 'findOne', () => {
    const settings = { adminModulePolicy: { modulePolicies: policy, version: 1 } };
    return {
      lean: async () => settings,
      then: (resolve, reject) => Promise.resolve(settings).then(resolve, reject),
    };
  });
  context.mock.method(Role, 'findOne', () => ({ lean: async () => null }));
  context.mock.method(Role, 'findById', () => ({ lean: async () => null }));
  context.mock.method(User, 'findByIdAndUpdate', async () => null);
  context.mock.method(SiteSettings, 'create', () => assert.fail('Authorization must not initialize module policy'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('Authorization must not upgrade module policy'));
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  context.mock.method(models.News.prototype, 'save', async function (options) {
    state.calls.push({ name: 'News', method: 'save', options });
    await this.validate();
    return (await models.News.create([this.toObject()], options))[0];
  });
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(name => [name, copy(state.rows[name])]));
  return state;
}

function deletedGroup(state, statuses = ['draft', 'draft', 'draft']) {
  const group = seedGroup(state, { status: 'draft' });
  for (const [index, doc] of state.rows.News.entries()) {
    const previous = statuses[index];
    Object.assign(doc, {
      title: `${PRIVATE}-${doc.language}`, status: 'deleted', deletedFromStatus: previous,
      deletedAt: new Date('2026-10-01T00:00:00.000Z'), workflowStage: 'REJECTED',
      workflowHistory: [{ action: 'REJECT', fromStage: previous.toUpperCase(), toStage: 'REJECTED' }],
      createdByUserId: actorId('reporter'),
      publishedAt: previous === 'published' ? group.publication : null,
      scheduledAt: previous === 'scheduled' ? new Date(FUTURE) : null,
      publishAt: previous === 'scheduled' ? new Date(FUTURE) : null,
      coverImage: {
        url: `/uploads/${doc.language}-cover.jpg`, publicId: `synthetic-${doc.language}-cover`, alt: `${doc.language} cover`,
      },
      coverImageUrl: `/uploads/${doc.language}-cover.jpg`,
    });
    Object.assign(state.rows.Article[index], {
      status: 'deleted', deletedAt: doc.deletedAt, workflowStage: previous.toUpperCase(),
      publishedAt: doc.publishedAt, scheduledAt: doc.scheduledAt, publishAt: doc.publishAt,
      coverImage: copy(doc.coverImage), coverImageUrl: doc.coverImageUrl,
    });
  }
  return group;
}

function assertNoWrites(state, before, response, status = 403) {
  assert.equal(response.status, status, response.text);
  assert.equal(response.text.includes(PRIVATE), false);
  assert.deepEqual(state.content(), before);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
  assert.deepEqual(state.invalidations, []);
}

function assertRestored(state, before, response, statuses) {
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(state.rows.News.map(doc => doc.status), statuses);
  assert.deepEqual(state.rows.Article.map(doc => doc.status), statuses);
  assert.deepEqual(response.body.changedIds, before.News.map(doc => doc._id));
  assert.equal(response.body.changedCount, statuses.length);
  for (const name of ['News', 'Article']) {
    for (const [index, doc] of state.rows[name].entries()) {
      assert.equal(doc.deletedAt, null);
      for (const field of ['_id', 'slug', 'slugs', 'language', 'sourceArticleId', 'translationGroupId',
        'translationKey', 'content', 'createdAt', 'publishedAt', 'scheduledAt', 'publishAt', 'coverImage', 'coverImageUrl']) {
        assert.deepEqual(copy(doc[field] ?? null), before[name][index][field] ?? null, `${name}.${field}`);
      }
    }
  }
  const session = state.transactions.at(-1);
  assert.ok(session.committed && session.ended);
  for (const call of state.calls.filter(call => ['News', 'Article'].includes(call.name) && WRITES.has(call.method))) {
    assert.equal(call.options?.session, session);
  }
  assert.equal(state.invalidations.length, 1);
}

for (const path of CREATE_BASES) {
  test(`POST ${path} standalone creation rejects absent entitlement`, async context => {
    const state = install(context);
    const before = state.content();
    const response = await state.request('post', path, { ...newDraft, ...forgedClaims }, 'editor');
    assertNoWrites(state, before, response);
  });
  for (const [label, access, role] of [
    ['Founder', {}, 'founder'], ['Add News', ADD_NEWS, 'reporter'],
    ['Draft Desk', DRAFT_DESK, 'reporter'], ['Manage News and news_edit', EDITOR, 'editor'],
  ]) {
    test(`POST ${path} permits ${label} ordinary creation`, async context => {
      const state = install(context, access);
      const response = await state.request('post', path, newDraft, role);
      assert.equal(response.status, 201, response.text);
      assert.equal(state.rows.News.length, 1);
      assert.equal(state.rows.News[0].status, 'draft');
      assert.equal(String(state.rows.News[0].createdByUserId), actorId(role));
      assert.equal(state.rows.News[0].content, newDraft.content);
    });
  }
  for (const role of ['admin', 'editor', 'reporter']) {
    test(`POST ${path} Manage News without news_edit cannot create as ${role}`, async context => {
      const state = install(context, { moduleAccessStates: { manageNews: 'enabled' } });
      assertNoWrites(state, state.content(), await state.request('post', path, newDraft, role));
    });
  }
}

for (const status of ['archived', 'deleted']) {
  for (const path of ['/api/articles', '/api/news']) {
    test(`limited ${path} creation does not authorize creating ${status} records`, async context => {
      const state = install(context, ADD_NEWS);
      assertNoWrites(state, state.content(), await state.request('post', path, { ...newDraft, status }, 'reporter'));
    });
  }
}

for (const restriction of ['foreign owner', 'unknown owner', 'published sibling', 'scheduled sibling', 'locked sibling']) {
  test(`workspace creation preserves linked-group restriction: ${restriction}`, async context => {
    const state = install(context, ADD_NEWS);
    const { ids } = seedGroup(state, { status: 'draft', copies: false });
    state.rows.News.pop();
    state.rows.News.forEach(doc => { doc.createdByUserId = actorId('reporter'); });
    const sibling = state.rows.News[1];
    if (restriction === 'foreign owner') sibling.createdByUserId = actorId('editor');
    if (restriction === 'unknown owner') delete sibling.createdByUserId;
    if (restriction === 'published sibling') sibling.status = 'published';
    if (restriction === 'scheduled sibling') sibling.scheduledAt = new Date(FUTURE);
    if (restriction === 'locked sibling') sibling.locked = true;
    const before = state.content();
    const response = await state.request('post', '/api/articles', {
      ...newDraft, language: 'gu', translationGroupId: 'story-test-group', sourceArticleId: ids[0],
    }, 'reporter');
    assertNoWrites(state, before, response);
  });
}

for (const [index, base] of RESTORE_BASES.entries()) {
  test(`POST ${base}/:id/restore rejects absent explicit rights`, async context => {
    const state = install(context, { moduleAccessStates: { manageNews: 'enabled' } });
    const { ids } = deletedGroup(state);
    const before = state.content();
    const response = await state.request('post', `${base}/${ids[index % 3]}/restore`, forgedClaims, 'editor');
    assertNoWrites(state, before, response);
    assert.equal(response.body.code, 'ARTICLE_RESTORE_FORBIDDEN');
  });
  for (const role of ['founder', 'editor']) {
    test(`POST ${base}/:id/restore permits authorized ${role} draft/archive groups`, async context => {
      const state = install(context, role === 'founder' ? {} : RESTORER);
      const statuses = ['draft', 'archived', 'draft'];
      const { ids } = deletedGroup(state, statuses);
      delete state.rows.News[1].createdByUserId;
      const before = state.content();
      const response = await state.request('post', `${base}/${ids[index % 3]}/restore`, {}, role);
      assertRestored(state, before, response, statuses);
    });
  }
}

for (const [label, access] of [
  ['role presets only', { moduleAccessStates: { manageNews: 'enabled' }, specialRightsConfigured: false }],
  ['legacy explicit selection without configured marker', { ...RESTORER, specialRightsConfigured: false }],
  ['configured empty selection', { ...RESTORER, specialRightsOverride: [] }],
  ['news_delete instead of news_restore', { ...RESTORER, specialRightsOverride: ['news_delete'] }],
  ['news_publish instead of news_restore', { ...RESTORER, specialRightsOverride: ['news_publish'] }],
  ['right without Manage News', { specialRightsOverride: ['news_restore'] }],
  ['owned Draft Desk without Manage News', { ...DRAFT_DESK, specialRightsOverride: ['news_restore'] }],
  ['temporary-only restore grant', {
    moduleAccessStates: { manageNews: 'enabled' },
    temporaryAccess: [{ rightKey: 'news_restore', enabled: true, expiresAt: FUTURE, grantedBy: actorId('founder') }],
  }],
]) {
  for (const role of ['admin', 'editor', 'reporter']) {
    test(`restore denies ${label} for ${role} despite claimed ownership`, async context => {
      const state = install(context, access);
      const { ids } = deletedGroup(state);
      state.rows.News.forEach(doc => { doc.createdByUserId = actorId(role); });
      assertNoWrites(state, state.content(),
        await state.request('post', `/api/articles/${ids[0]}/restore`, forgedClaims, role));
    });
  }
}

for (const previous of ['published', 'scheduled']) {
  for (const index of [0, 1, 2]) {
    test(`a previously ${previous} edition at index ${index} keeps the whole restore Founder-only`, async context => {
      const state = install(context, RESTORER);
      const statuses = ['draft', 'archived', 'draft'];
      statuses[index] = previous;
      const { ids } = deletedGroup(state, statuses);
      const before = state.content();
      assertNoWrites(state, before, await state.request('post', `/api/articles/${ids[(index + 1) % 3]}/restore`, {}, 'editor'));
      const response = await state.request('post', `/api/articles/${ids[index]}/restore`, {}, 'founder');
      assertRestored(state, before, response, statuses);
    });
  }
}

for (const protection of ['publication timestamp', 'schedule timestamp', 'publication history', 'scheduled history',
  'unknown history', 'locked sibling', 'Founder approval', 'private sibling', 'embargoed sibling',
  'unresolved source', 'conflicting group', 'foreign public copy', 'unowned public copy', 'published public copy']) {
  test(`restore preflights every edition and public copy: ${protection}`, async context => {
    const state = install(context, RESTORER);
    const { ids, publication } = deletedGroup(state);
    const doc = state.rows.News[2];
    if (protection === 'publication timestamp') doc.publishedAt = publication;
    if (protection === 'schedule timestamp') doc.scheduledAt = new Date(FUTURE);
    if (protection === 'publication history') doc.workflowHistory.unshift({ action: 'PUBLISH', toStage: 'PUBLISHED' });
    if (protection === 'scheduled history') doc.workflowHistory.unshift({ action: 'SCHEDULE', toStage: 'SCHEDULED' });
    if (protection === 'unknown history') { delete doc.deletedFromStatus; doc.workflowHistory = []; }
    if (protection === 'locked sibling') doc.workflow = { locked: true };
    if (protection === 'Founder approval') doc.requiresFounderApproval = true;
    if (protection === 'private sibling') doc.visibility = 'private';
    if (protection === 'embargoed sibling') doc.embargoUntil = new Date(FUTURE);
    if (protection === 'unresolved source') doc.sourceArticleId = FOREIGN_ID;
    if (protection === 'conflicting group') doc.translationKey = 'different-story';
    if (protection === 'foreign public copy') state.rows.Article[2].sourceNewsId = FOREIGN_ID;
    if (protection === 'unowned public copy') state.rows.Article[2].sourceNewsId = null;
    if (protection === 'published public copy') state.rows.Article[2].publishedAt = publication;
    assertNoWrites(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor'));
  });
}

for (const operation of ['create', 'restore']) {
  for (const restriction of ['global module policy', 'Safe Zone', 'temporary module denial',
    'temporary right denial', 'suspended account', 'disabled login', 'revoked token']) {
    test(`${operation} applies ${restriction} before protected writes`, async context => {
      const state = install(context, operation === 'create' ? EDITOR : RESTORER);
      const ids = operation === 'restore' ? deletedGroup(state).ids : [];
      if (restriction === 'global module policy') state.policy.manageNews = 'staff_locked';
      if (restriction === 'Safe Zone') {
        process.env.SAFE_ZONE_MASTER_LOCK = 'true';
        context.after(() => { delete process.env.SAFE_ZONE_MASTER_LOCK; });
      }
      if (restriction === 'temporary module denial') state.access.temporaryAccess = [
        { moduleKey: 'manage_news', enabled: false, expiresAt: FUTURE },
        { moduleKey: 'manage_news', enabled: true, expiresAt: FUTURE },
      ];
      if (restriction === 'temporary right denial') state.access.temporaryAccess = [
        { rightKey: operation === 'create' ? 'news_edit' : 'news_restore', enabled: true, expiresAt: FUTURE },
        { rightKey: operation === 'create' ? 'news_edit' : 'news_restore', enabled: false, expiresAt: FUTURE },
      ];
      if (restriction === 'suspended account') state.access.accountStatus = 'suspended';
      if (restriction === 'disabled login') state.access.loginAllowed = false;
      if (restriction === 'revoked token') state.access.tokenVersion = 1;
      const before = state.content();
      const response = await state.request('post', operation === 'create' ? '/api/articles' : `/api/articles/${ids[0]}/restore`,
        operation === 'create' ? newDraft : {}, 'editor');
      assertNoWrites(state, before, response, restriction === 'revoked token' ? 401 : 403);
    });
  }
}

test('expired restore denial does not revoke a configured permanent grant', async context => {
  const state = install(context, {
    ...RESTORER, temporaryAccess: [{ rightKey: 'news_restore', enabled: false, expiresAt: PAST }],
  });
  const { ids } = deletedGroup(state);
  const before = state.content();
  assertRestored(state, before, await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor'),
    ['draft', 'draft', 'draft']);
});

for (const base of DRAFT_BASES) {
  test(`GET ${base} rejects workspace-only users`, async context => {
    const state = install(context, DRAFT_DESK);
    const { ids } = deletedGroup(state);
    const before = state.content();
    const response = await state.request('get', `${base}?deleted=1`, undefined, 'reporter');
    assertNoWrites(state, before, response);
    for (const id of ids) assert.equal(response.text.includes(id), false);
    assert.equal(state.calls.filter(call => ['News', 'Article'].includes(call.name)).length, 0);
  });
  for (const role of ['founder', 'editor']) {
    test(`GET ${base} permits authorized ${role} reads without granting restoration`, async context => {
      const state = install(context, { moduleAccessStates: { manageNews: 'enabled' } });
      deletedGroup(state);
      const before = state.content();
      const response = await state.request('get', `${base}?deleted=1`, undefined, role);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.total, 3);
      assert.equal(response.body.data.length, 3);
      assert.deepEqual(state.content(), before);
      assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
    });
  }
}

for (const operation of ['create', 'restore']) {
  test(`${operation} ignores forged JWT and body Founder claims`, async context => {
    const state = install(context);
    const ids = operation === 'restore' ? deletedGroup(state).ids : [];
    const before = state.content();
    const token = state.token('editor', { role: 'founder', isFounder: true, specialRights: ['news_edit', 'news_restore'] });
    const response = await request(app).post(operation === 'create' ? '/api/articles' : `/api/articles/${ids[0]}/restore`)
      .auth(token, { type: 'bearer' }).send({ ...(operation === 'create' ? newDraft : {}), ...forgedClaims });
    assertNoWrites(state, before, response);
  });
  for (const role of ['founder', 'editor']) {
    test(`${operation} reloads ${role} account eligibility inside the transaction`, async context => {
      const state = install(context, operation === 'create' ? EDITOR : RESTORER);
      const ids = operation === 'restore' ? deletedGroup(state).ids : [];
      const before = state.content();
      const start = mongoose.startSession;
      context.mock.method(mongoose, 'startSession', async () => {
        state.access.accountStatus = 'suspended';
        return start();
      });
      const response = await state.request('post', operation === 'create' ? '/api/articles' : `/api/articles/${ids[0]}/restore`,
        operation === 'create' ? newDraft : {}, role);
      assertNoWrites(state, before, response);
    });
  }
  test(`${operation} reauthorizes retries and discards rolled-back effects`, async context => {
    const state = install(context, operation === 'create' ? EDITOR : RESTORER);
    const ids = operation === 'restore' ? deletedGroup(state).ids : [];
    const before = state.content();
    const start = mongoose.startSession;
    let retryIndex;
    context.mock.method(mongoose, 'startSession', async () => {
      const session = await start();
      const transact = session.withTransaction.bind(session);
      session.withTransaction = async work => {
        await assert.rejects(transact(async () => { await work(); throw new Error('Synthetic retry'); }), /Synthetic retry/);
        state.access.specialRightsOverride = [];
        retryIndex = state.calls.length;
        await transact(work);
      };
      return session;
    });
    const response = await state.request('post', operation === 'create' ? '/api/articles' : `/api/articles/${ids[0]}/restore`,
      operation === 'create' ? newDraft : {}, 'editor');
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(state.content(), before);
    assert.deepEqual(state.invalidations, []);
    assert.equal(state.calls.slice(retryIndex).filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
    assert.ok(state.transactions.every(session => session.aborted && session.ended));
  });
}

test('authorized restore rolls back all editions when public-copy synchronization fails', async context => {
  const state = install(context, RESTORER);
  const { ids } = deletedGroup(state);
  const before = state.content();
  state.failures['Article.findOneAndUpdate'] = { name: 'MongoNetworkError' };
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor');
  assert.equal(response.status, 503, response.text);
  assert.deepEqual(state.content(), before);
  assert.deepEqual(state.invalidations, []);
  assert.ok(state.transactions.every(session => session.aborted && session.ended));
});
