require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const News = require('../models/News');
const Article = require('../models/Article');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');
const { changeArticleGroupStatus } = require('../services/articleLifecycle.service');

const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin', '/api/api', '/api/api/admin'];
const DRAFT_PREFIXES = ['/api/admin', '/admin-api/admin', '/admin-api/api/admin', '/api/api/admin'];
const DELETE_ACCESS = { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_delete'] };
const WORKSPACE = { moduleAccessStates: { addNews: 'enabled', draftDesk: 'enabled' } };
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const EXTRA_ID = '507f1f77bcf86cd79943b999';
const EXTRA_COPY_ID = '607f1f77bcf86cd79943b999';
const PRIVATE = 'SYNTHETIC-PRIVATE-SIBLING';
const CONTENT_MODELS = ['News', 'Article', 'EditorialTopic', 'TranslationJob', 'PublicConfigVersion', 'YouthPulseSubmission', 'YouthPulseContributor', 'PushHistory'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const copy = value => JSON.parse(JSON.stringify(value));

function install(context, access = DELETE_ACCESS) {
  const staff = { specialRightsConfigured: true, specialRightsOverride: [], ...copy(access) };
  const policy = { manageNews: 'available', addNews: 'available', draftDesk: 'available' };
  const state = installEditorialFixture(context, { staff, modulePolicies: policy });
  state.access = staff;
  state.policy = policy;
  state.role = null;
  context.mock.method(Role, 'findOne', () => ({ lean: async () => state.role }));
  context.mock.method(Role, 'findById', () => ({ lean: async () => state.role }));
  context.mock.method(User, 'findByIdAndUpdate', async () => null);
  context.mock.method(SiteSettings, 'create', () => assert.fail('Deletion authorization must not initialize module policy'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('Deletion authorization must not upgrade module policy'));
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(key => [key, copy(state.rows[key])]));
  return state;
}

function mixedGroup(state) {
  const result = seedGroup(state);
  Object.assign(state.rows.News[0], {
    status: 'draft', publishedAt: null, workflowStage: 'DRAFT', createdByUserId: actorId('reporter'),
  });
  Object.assign(state.rows.Article[0], { status: 'draft', publishedAt: null, workflowStage: 'DRAFT' });
  state.rows.News[1].createdByUserId = actorId('founder');
  state.rows.News[2].title = PRIVATE;
  state.rows.News[2].translations = { en: { title: PRIVATE } };
  return result;
}

function assertNoContentWrites(state, before, response, code = 'ARTICLE_DELETE_FORBIDDEN') {
  assert.equal(response.status, 403, response.text);
  if (code) assert.equal(response.body.code, code, response.text);
  assert.equal(response.text.includes(PRIVATE), false);
  assert.deepEqual(state.content(), before);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
  assert.deepEqual(state.invalidations, []);
}

function assertRolledBack(state, before, response) {
  assert.deepEqual(state.content(), before, response.text);
  assert.deepEqual(state.invalidations, []);
  assert.equal(state.rows.TranslationJob.length, 0);
  assert.ok(state.transactions.every(session => session.aborted && session.ended));
}

function assertDeleted(state, before, response, ids) {
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.deletedCount, ids.length);
  assert.deepEqual(response.body.deletedIds, ids);
  for (const [index, doc] of state.rows.News.entries()) {
    assert.equal(doc.status, 'deleted');
    assert.equal(doc.workflowStage, 'REJECTED');
    assert.equal(doc.deletedFromStatus, before.News[index].status);
    assert.ok(doc.deletedAt);
    for (const field of ['_id', 'slug', 'slugs', 'language', 'lang', 'sourceArticleId', 'translationGroupId', 'translationKey', 'content', 'translations', 'coverImage', 'createdAt', 'publishedAt']) {
      assert.deepEqual(copy(doc[field] ?? null), before.News[index][field] ?? null, field);
    }
    assert.equal(doc.syncVersion, before.News[index].syncVersion + 1);
  }
  assert.ok(state.rows.Article.every(doc => doc.status === 'deleted' && doc.deletedAt));
  assert.deepEqual(state.rows.Article.map(doc => doc._id), before.Article.map(doc => doc._id));
  assert.deepEqual(copy(state.rows.EditorialTopic), before.EditorialTopic);
  assert.deepEqual(copy(state.rows.TranslationJob), before.TranslationJob);
  assert.equal(state.invalidations.length, 1);
  const session = state.transactions.at(-1);
  assert.ok(session.committed && session.ended);
  assert.ok(state.transactions.slice(0, -1).every(previous => previous.aborted && previous.ended));
  assert.equal(SiteSettings.create.mock.callCount(), 0);
  assert.equal(SiteSettings.findOneAndUpdate.mock.callCount(), 0);
}

for (const [index, prefix] of PREFIXES.entries()) {
  test(`DELETE ${prefix}/articles rejects module-only deletion before all protected writes`, async context => {
    const state = install(context, { moduleAccessStates: { manageNews: 'enabled' } });
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('delete', `${prefix}/articles/${ids[index % 3]}`, undefined, 'editor');
    assertNoContentWrites(state, before, response);
    assert.equal(state.calls.filter(call => call.name === 'News' || call.name === 'Article').length, 0);
  });
  test(`DELETE ${prefix}/articles permits effective news_delete without news_edit for the complete language group`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('delete', `${prefix}/articles/${ids[index % 3]}`, undefined, 'editor');
    assertDeleted(state, before, response, ids);
    assert.deepEqual(response.body.article, response.body.data.article);
    assert.equal(response.body.article.id, ids[index % 3]);
    assert.equal(response.body.article.body, before.News[index % 3].content);
  });
  test(`DELETE ${prefix}/articles requires a persisted authenticated account`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('delete', `${prefix}/articles/${ids[0]}`, undefined, null);
    assert.equal(response.status, 401, response.text);
    assert.deepEqual(state.content(), before);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.invalidations, []);
  });
}

for (const prefix of DRAFT_PREFIXES) {
  test(`POST ${prefix}/drafts/delete denies an own-draft-only grant even with news_delete`, async context => {
    const state = install(context, { ...WORKSPACE, specialRightsOverride: ['news_delete'] });
    const { ids } = mixedGroup(state);
    const before = state.content();
    assertNoContentWrites(state, before, await state.request('post', `${prefix}/drafts/${ids[0]}/delete`, {}, 'reporter'));
  });
  test(`POST ${prefix}/drafts/delete retains the authorized legacy success DTO`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('post', `${prefix}/drafts/${ids[0]}/delete`, {}, 'editor');
    assertDeleted(state, before, response, ids);
    assert.equal(response.body.data.id, ids[0]);
    assert.equal(response.body.data.body, before.News[0].content);
    assert.equal(response.body.article, undefined);
  });
}

const moduleGrant = { moduleKey: 'manage_news', enabled: true, expiresAt: FUTURE };
const moduleDenial = { moduleKey: 'manageNews', enabled: false, expiresAt: FUTURE };
const rightGrant = { rightKey: 'news_delete', enabled: true, expiresAt: FUTURE };
const rightDenial = { rightKey: 'news_delete', enabled: false, expiresAt: FUTURE };
const ACCESS_CASES = [
  ['neither grant', {}, false],
  ['action right without required module', { specialRightsOverride: ['news_delete'] }, false],
  ['edit right without deletion right', { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_edit'] }, false],
  ['own-draft modules alone', WORKSPACE, false],
  ['own-draft modules and delete right', { ...WORKSPACE, specialRightsOverride: ['news_delete'] }, false],
  ['configured-empty cannot inherit role/default/legacy delete rights', { moduleAccessStates: { manageNews: 'enabled' }, permissions: ['news_delete'] }, false],
  ['legacy module alias', { moduleAccessOverride: ['manage_news'], specialRightsOverride: ['news_delete'] }, true],
  ['temporary module grant', { specialRightsOverride: ['news_delete'], temporaryAccess: [moduleGrant] }, true],
  ['expired module grant', { specialRightsOverride: ['news_delete'], temporaryAccess: [{ ...moduleGrant, expiresAt: PAST }] }, false],
  ['invalid module expiry', { specialRightsOverride: ['news_delete'], temporaryAccess: [{ ...moduleGrant, expiresAt: 'invalid' }] }, false],
  ['module grant then denial', { ...DELETE_ACCESS, temporaryAccess: [moduleGrant, moduleDenial] }, false],
  ['module denial then grant', { ...DELETE_ACCESS, temporaryAccess: [moduleDenial, moduleGrant] }, false],
  ['expired module denial plus grant', { specialRightsOverride: ['news_delete'], temporaryAccess: [{ ...moduleDenial, expiresAt: PAST }, moduleGrant] }, true],
  ['right grant on configured-empty permanent selection', { moduleAccessStates: { manageNews: 'enabled' }, temporaryAccess: [rightGrant] }, true],
  ['expired right grant', { moduleAccessStates: { manageNews: 'enabled' }, temporaryAccess: [{ ...rightGrant, expiresAt: PAST }] }, false],
  ['invalid right expiry', { moduleAccessStates: { manageNews: 'enabled' }, temporaryAccess: [{ ...rightGrant, expiresAt: 'invalid' }] }, false],
  ['right grant then denial', { ...DELETE_ACCESS, temporaryAccess: [rightGrant, rightDenial] }, false],
  ['right denial then grant', { ...DELETE_ACCESS, temporaryAccess: [rightDenial, rightGrant] }, false],
  ['expired right denial plus grant', { moduleAccessStates: { manageNews: 'enabled' }, temporaryAccess: [{ ...rightDenial, expiresAt: PAST }, rightGrant] }, true],
  ['unrelated module/right denials', { ...DELETE_ACCESS, temporaryAccess: [{ ...moduleDenial, moduleKey: 'addNews' }, { ...rightDenial, rightKey: 'news_edit' }] }, true],
];
for (const [label, access, allowed] of ACCESS_CASES) {
  test(`soft delete uses existing effective permission semantics: ${label}`, async context => {
    const state = install(context, access);
    state.role = { specialRights: ['news_delete'] };
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'admin');
    if (allowed) assertDeleted(state, before, response, ids);
    else assertNoContentWrites(state, before, response);
  });
}

test('unconfigured staff retain effective role rights rather than gaining new permanent selections', async context => {
  const state = install(context, { specialRightsConfigured: false, moduleAccessStates: { manageNews: 'enabled' } });
  state.role = { specialRights: ['news_delete'] };
  const { ids } = mixedGroup(state);
  const before = state.content();
  const actor = copy(state.access);
  assertDeleted(state, before, await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor'), ids);
  assert.deepEqual(state.access, actor);
  assert.equal(User.findByIdAndUpdate.mock.callCount(), 0);
});

for (const globalState of ['staff_locked', 'hidden', 'founder_only']) {
  test(`global ${globalState} blocks soft delete despite temporary and permanent rights`, async context => {
    const state = install(context, { ...DELETE_ACCESS, temporaryAccess: [moduleGrant, rightGrant] });
    state.policy.manageNews = globalState;
    const { ids } = mixedGroup(state);
    const before = state.content();
    assertNoContentWrites(state, before, await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor'));
  });
}

for (const role of ['editor', 'founder']) {
  test(`Safe Zone and denied module/right entries preserve ${role} authority boundaries`, async context => {
    const state = install(context, { ...DELETE_ACCESS, temporaryAccess: [moduleDenial, rightDenial] });
    state.policy.manageNews = 'staff_locked';
    const previous = process.env.SAFE_ZONE_MASTER_LOCK;
    process.env.SAFE_ZONE_MASTER_LOCK = 'true';
    context.after(() => {
      if (previous === undefined) delete process.env.SAFE_ZONE_MASTER_LOCK;
      else process.env.SAFE_ZONE_MASTER_LOCK = previous;
    });
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, role);
    if (role === 'founder') assertDeleted(state, before, response, ids);
    else assertNoContentWrites(state, before, response);
  });
}

const INELIGIBLE = [
  ['suspended', { accountStatus: 'suspended' }, 'ACCOUNT_SUSPENDED'],
  ['legacy suspended', { status: 'suspended' }, 'ACCOUNT_SUSPENDED'],
  ['locked', { accountStatus: 'locked' }, 'ACCOUNT_LOCKED'],
  ['temporary lock', { lockedUntil: FUTURE }, 'ACCOUNT_LOCKED'],
  ['expired', { accessExpiresAt: PAST, noExpiry: false }, 'ACCOUNT_EXPIRED'],
  ['archived', { accountStatus: 'archived' }, 'ACCOUNT_ARCHIVED'],
  ['deleted', { isDeleted: true }, 'ACCOUNT_DELETED'],
  ['disabled login', { loginAllowed: false }, 'LOGIN_DISABLED'],
];
for (const [label, fields, code] of INELIGIBLE) {
  test(`${label} accounts cannot soft-delete with otherwise valid grants`, async context => {
    const state = install(context, { ...DELETE_ACCESS, ...fields });
    const { ids } = mixedGroup(state);
    const before = state.content();
    assertNoContentWrites(state, before, await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor'), code);
  });
}

for (const cookie of ['np_admin_token', 'np_token', 'token']) {
  test(`${cookie} deletion requires trusted Origin and current action permission`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    let call = state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
    let token = call.get('Authorization').slice(7);
    assertNoContentWrites(state, before, await call.unset('Authorization').set('Cookie', `${cookie}=${token}`), 'CSRF_ORIGIN_REQUIRED');
    state.access.specialRightsOverride = [];
    call = state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
    token = call.get('Authorization').slice(7);
    assertNoContentWrites(state, before, await call.unset('Authorization')
      .set('Cookie', `${cookie}=${token}`).set('Origin', 'http://localhost:5173'));
    state.access.specialRightsOverride = ['news_delete'];
    call = state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
    token = call.get('Authorization').slice(7);
    assertDeleted(state, before, await call.unset('Authorization')
      .set('Cookie', `${cookie}=${token}`).set('Origin', 'http://localhost:5173'), ids);
  });
}

for (const overrides of [{ role: 'founder' }, { tokenVersion: 5 }, { sub: EXTRA_ID }]) {
  test(`JWT claims do not replace persisted deletion authority (${Object.keys(overrides)[0]})`, async context => {
    const state = install(context, WORKSPACE);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const call = state.request('delete', `/api/articles/${ids[0]}`, undefined, 'reporter');
    const payload = jwt.decode(call.get('Authorization').slice(7));
    const token = jwt.sign({ ...payload, ...overrides }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const response = await call.set('Authorization', `Bearer ${token}`);
    assert.equal(response.status, overrides.role ? 403 : 401, response.text);
    assert.deepEqual(state.content(), before);
    assert.deepEqual(state.invalidations, []);
  });
}

for (const [label, creator] of [['own', actorId('reporter')], ['foreign', actorId('founder')], ['generated', undefined]]) {
  test(`${label} draft ownership never supplies a limited deletion exception`, async context => {
    const state = install(context, { ...WORKSPACE, specialRightsOverride: ['news_delete'] });
    const { ids } = seedGroup(state, { status: 'draft', copies: false });
    state.rows.News.splice(1);
    state.rows.News[0].createdByUserId = creator;
    state.rows.News[0].authorByline = { staffId: actorId('reporter') };
    state.rows.News[0].workflowHistory = [{ byUserId: actorId('reporter') }];
    const before = state.content();
    assertNoContentWrites(state, before, await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'reporter'));
  });
}

test('a public-copy ID resolves the same authorized complete CMS group', async context => {
  const state = install(context);
  const { ids } = mixedGroup(state);
  const before = state.content();
  assertDeleted(state, before, await state.request('delete', `/api/articles/${state.rows.Article[1]._id}`, undefined, 'editor'), ids);
});

test('shared-slug and unowned compatibility copies keep existing soft-delete matching', async context => {
  const state = install(context);
  const { ids } = seedGroup(state, { sharedSlug: true });
  state.rows.Article.push({ _id: EXTRA_COPY_ID, slug: 'shared-story', status: 'published' });
  const before = state.content();
  assertDeleted(state, before, await state.request('delete', `/api/articles/${ids[2]}`, undefined, 'editor'), ids);
});

for (const [method, prefix] of [
  ...PREFIXES.flatMap(prefix => ['put', 'patch'].map(method => [method, `${prefix}/articles`])),
  ...['/api/news', '/api/api/news'].flatMap(prefix => ['put', 'patch'].map(method => [method, prefix])),
]) {
  test(`${method.toUpperCase()} ${prefix} cannot use body status as an alternate staff deletion action`, async context => {
    const state = install(context, { ...DELETE_ACCESS, specialRightsOverride: ['news_edit', 'news_delete'] });
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request(method, `${prefix}/${ids[0]}`, { status: 'deleted', title: 'Denied body write' }, 'editor');
    assertNoContentWrites(state, before, response, 'ARTICLE_SAVE_FORBIDDEN');
  });
}

for (const body of [
  { $set: { status: 'deleted' } }, { 'workflow.stage': 'REJECTED' }, { deletedAt: FUTURE },
  { deletedFromStatus: 'published' }, { workflow: { stage: 'REJECTED' } }, { status: ['deleted'] },
]) {
  test(`staff delete-state injection stays rejected (${Object.keys(body)[0]})`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('patch', `/api/articles/${ids[0]}`, body, 'editor');
    assertNoContentWrites(state, before, response, 'ARTICLE_SAVE_FORBIDDEN');
  });
}

for (const method of ['put', 'patch']) {
  test(`Founder ${method.toUpperCase()} deleted status retains group deletion and ignores accompanying edits`, async context => {
    const state = install(context, {});
    const { ids } = mixedGroup(state);
    const before = state.content();
    assertDeleted(state, before, await state.request(method, `/api/articles/${ids[0]}`, {
      status: 'deleted', title: 'Not an incidental content edit',
    }, 'founder'), ids);
  });
}

for (const path of ['/api/news', '/api/api/news']) {
  test(`legacy DELETE ${path} is not an alternate mutation endpoint`, async context => {
    const state = install(context, WORKSPACE);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const response = await state.request('delete', `${path}/${ids[0]}`, undefined, 'reporter');
    assert.equal(response.status, 404, response.text);
    assert.deepEqual(state.content(), before);
    assert.deepEqual(state.invalidations, []);
  });
}

for (const [method, suffix] of [
  ['delete', '?hard=true'], ['delete', '?hard=1'],
  ...['permanent', 'hard-delete', 'hard', 'forever'].map(suffix => ['delete', `/${suffix}`]),
  ...['hard-delete', 'hard'].map(suffix => ['post', `/${suffix}`]),
]) {
  test(`news_delete cannot grant Founder-only permanent action ${method.toUpperCase()} ${suffix}`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    const before = state.content();
    assertNoContentWrites(state, before, await state.request(method, `/api/articles/${ids[0]}${suffix}`, {}, 'editor'), 'FOUNDER_REQUIRED');
  });
}

for (const [method, path, body] of [
  ['post', '/api/articles/forever/bulk', { ids: ['507f1f77bcf86cd79943a001', '507f1f77bcf86cd79943a002'] }],
  ['delete', '/api/articles/forever/all-deleted', undefined],
]) {
  test(`news_delete cannot bypass permanent bulk deletion via ${path}`, async context => {
    const state = install(context);
    seedGroup(state, { status: 'deleted' });
    const before = state.content();
    assertNoContentWrites(state, before, await state.request(method, path, body, 'editor'), 'FOUNDER_REQUIRED');
  });
}

test('bulk-like payloads do not extend a single logical-story deletion', async context => {
  const state = install(context);
  const { ids } = mixedGroup(state);
  const other = { ...copy(state.rows.News[1]), _id: EXTRA_ID, translationGroupId: 'other', translationKey: 'other', sourceArticleId: EXTRA_ID };
  state.rows.News.push(other);
  const response = await state.request('delete', `/api/articles/${ids[0]}`, {
    ids: [ids[0], EXTRA_ID], all: true, allDeleted: true,
  }, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.deletedCount, 3);
  assert.deepEqual(state.rows.News.find(doc => doc._id === EXTRA_ID), other);
});

test('the service rejects role-only requests even without the HTTP router', async context => {
  const state = install(context);
  const { ids } = mixedGroup(state);
  const before = state.content();
  await assert.rejects(changeArticleGroupStatus(ids[0], 'deleted', { req: { admin: { role: 'founder' }, headers: {} } }), {
    code: 'ARTICLE_DELETE_FORBIDDEN', status: 403,
  });
  assert.deepEqual(state.content(), before);
  assert.equal(state.calls.filter(call => WRITES.has(call.method) && call.name !== 'AuditLog').length, 0);
});

test('account, policy and actual public copies are read in the transaction before its first protected write', async context => {
  const state = install(context);
  const { ids } = mixedGroup(state);
  const reads = [];
  for (const [Model, method, label] of [[User, 'findById', 'user'], [SiteSettings, 'findOne', 'policy'], [Article, 'find', 'copies']]) {
    const original = Model[method];
    context.mock.method(Model, method, (...args) => {
      reads.push({ label, session: args[2]?.session, writes: state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length });
      return original(...args);
    });
  }
  const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
  assert.equal(response.status, 200, response.text);
  const session = state.transactions[0];
  for (const label of ['user', 'policy', 'copies']) assert.ok(reads.some(read => read.label === label && read.session === session && read.writes === 0), label);
  for (const write of state.calls.filter(call => ['News', 'Article'].includes(call.name) && WRITES.has(call.method))) {
    assert.equal(write.options.session, session);
    assert.notEqual(write.filter, undefined);
  }
});

for (const revocation of [
  { specialRightsOverride: [] }, { temporaryAccess: [rightDenial] }, { temporaryAccess: [moduleDenial] },
  { tokenVersion: 1 }, { accountStatus: 'suspended' }, { role: 'reporter' },
]) {
  test(`deletion rechecks persisted access after authentication (${Object.keys(revocation)[0]})`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const start = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      Object.assign(state.access, copy(revocation));
      return start();
    });
    assertNoContentWrites(state, before, await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor'));
  });
}

test('transaction retries discard previous deletion authority and all deferred effects', async context => {
  const state = install(context);
  const { ids } = mixedGroup(state);
  const before = state.content();
  const start = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await start();
    const transact = session.withTransaction.bind(session);
    session.withTransaction = async work => {
      await assert.rejects(transact(async () => {
        await work();
        throw new Error('Synthetic retry');
      }), /Synthetic retry/);
      state.access.specialRightsOverride = [];
      await transact(work);
    };
    return session;
  });
  const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
  assert.equal(response.status, 403, response.text);
  assert.equal(response.body.code, 'ARTICLE_DELETE_FORBIDDEN');
  assertRolledBack(state, before, response);
});

for (const change of ['member-status', 'member-identity', 'new-member', 'copy-identity', 'new-copy', 'copy-removed']) {
  test(`a changed ${change} aborts the whole deletion without widening its write scope`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    const update = News.findOneAndUpdate;
    let pending = true;
    context.mock.method(News, 'findOneAndUpdate', (...args) => {
      if (pending) {
        pending = false;
        if (change === 'member-status') state.rows.News[1].status = 'archived';
        if (change === 'member-identity') state.rows.News[1].translationKey = 'moved-story';
        if (change === 'new-member') state.rows.News.push({ ...copy(state.rows.News[1]), _id: EXTRA_ID });
        if (change === 'copy-identity') state.rows.Article[1].sourceNewsId = EXTRA_ID;
        if (change === 'new-copy') state.rows.Article.push({ ...copy(state.rows.Article[1]), _id: EXTRA_COPY_ID });
        if (change === 'copy-removed') state.rows.Article.splice(1, 1);
      }
      return update(...args);
    });
    const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
    assert.equal(response.status, 409, response.text);
    assert.equal(response.body.code, 'ARTICLE_DELETE_SCOPE_CHANGED');
    assertRolledBack(state, before, response);
  });
}

test('an empty public preflight never becomes an unbounded update when a copy appears later', async context => {
  const state = install(context);
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  const before = state.content();
  const update = News.findOneAndUpdate;
  let pending = true;
  context.mock.method(News, 'findOneAndUpdate', (...args) => {
    if (pending) {
      pending = false;
      state.rows.Article.push({ _id: EXTRA_COPY_ID, sourceNewsId: ids[0], status: 'published' });
    }
    return update(...args);
  });
  const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
  assert.equal(response.status, 409, response.text);
  assertRolledBack(state, before, response);
});

for (const method of ['Article.find', 'News.findOneAndUpdate', 'Article.updateMany']) {
  test(`${method} failure does not leave a partial deletion or post-commit effects`, async context => {
    const state = install(context);
    const { ids } = mixedGroup(state);
    const before = state.content();
    state.failures[method] = { name: 'MongoNetworkError' };
    const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
    assert.equal(response.status, 503, response.text);
    assertRolledBack(state, before, response);
    if (method === 'Article.find') assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
  });
}

test('a failed post-commit follow-up is reported as committed, never as rollback', async context => {
  const state = install(context);
  const { ids } = mixedGroup(state);
  context.mock.method(global, 'fetch', async () => { throw new Error('Synthetic revalidation outage'); });
  const response = await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.committed, true);
  assert.ok(response.body.revalidation?.ok === false || response.body.postCommitWarnings?.length > 0);
  assert.ok(state.rows.News.every(doc => doc.status === 'deleted'));
  assert.ok(state.rows.Article.every(doc => doc.status === 'deleted'));
});

test('restore and unpublish retain their independent permission boundaries', async context => {
  const state = install(context, {});
  const { ids } = seedGroup(state);
  assert.equal((await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'founder')).status, 200);
  assert.equal((await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor')).status, 403);
  assert.equal((await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'founder')).status, 200);
  assert.equal((await state.request('post', `/api/articles/${ids[0]}/unpublish`, {}, 'editor')).status, 403);
  assert.equal((await state.request('post', `/api/articles/${ids[0]}/unpublish`, {}, 'founder')).status, 200);
  assert.equal((await state.request('delete', `/api/articles/${ids[0]}`, undefined, 'founder')).status, 200);
  assert.equal((await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor')).status, 200);
});
