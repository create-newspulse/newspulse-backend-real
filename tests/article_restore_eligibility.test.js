require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const request = require('supertest');
const User = require('../models/User');
const SiteSettings = require('../models/SiteSettings');
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const app = require('../server');

const BASES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin',
  '/admin-api/api/admin', '/api/api', '/api/api/admin'].map(prefix => `${prefix}/articles`);
const PRIVATE = 'SYNTHETIC-PRIVATE-RESTORE-CONTENT';
const FOREIGN_ID = '507f1f77bcf86cd79943b999';
const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';
const RESTORER = {
  specialRightsConfigured: true, specialRightsOverride: ['news_restore'],
  moduleAccessStates: { manageNews: 'enabled' },
};
const WRITE_METHODS = [
  'save', 'create', 'insertOne', 'insertMany', 'bulkWrite', 'bulkSave',
  'updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate', 'findByIdAndUpdate',
  'findOneAndReplace', 'findOneAndRemove', 'findByIdAndRemove', 'findOneAndDelete',
  'findByIdAndDelete', 'deleteOne', 'deleteMany', 'createCollection',
  'ensureIndexes', 'createIndex', 'createIndexes', 'syncIndexes', 'cleanIndexes', 'dropIndex', 'dropIndexes',
];
const clone = value => JSON.parse(JSON.stringify(value));
const pathFor = id => `/api/articles/${id}/restore-eligibility`;

function install(context, overrides = {}) {
  const access = { ...clone(RESTORER), ...clone(overrides) };
  const policy = { manageNews: 'available', addNews: 'available', draftDesk: 'available' };
  const state = installEditorialFixture(context, { staff: access, modulePolicies: policy });
  state.access = access;
  state.policy = policy;
  const start = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await start();
    const transact = session.withTransaction.bind(session);
    session.withTransaction = (work, options) => {
      session.transactionOptions = options;
      return transact(work, options);
    };
    return session;
  });
  return state;
}

function deletedGroup(state, statuses = ['draft', 'archived', 'draft']) {
  const group = seedGroup(state, { status: 'draft' });
  state.rows.News.forEach((doc, index) => {
    const previous = statuses[index];
    Object.assign(doc, {
      title: PRIVATE, description: PRIVATE, content: PRIVATE, internalComments: [{ message: PRIVATE }],
      createdByUserId: FOREIGN_ID, status: 'deleted', deletedAt: new Date(PAST), deletedFromStatus: previous,
      workflowStage: 'REJECTED',
      workflowHistory: [{ action: 'REJECT', fromStage: previous.toUpperCase(), toStage: 'REJECTED', note: PRIVATE }],
      publishedAt: previous === 'published' ? group.publication : null,
      scheduledAt: previous === 'scheduled' ? new Date(FUTURE) : null,
      publishAt: previous === 'scheduled' ? new Date(FUTURE) : null,
    });
    Object.assign(state.rows.Article[index], {
      title: PRIVATE, content: PRIVATE, status: 'deleted', deletedAt: new Date(PAST),
      publishedAt: doc.publishedAt, scheduledAt: doc.scheduledAt, publishAt: doc.publishAt,
    });
  });
  return group;
}

async function readOnlyRequest(context, state, pending) {
  const before = clone(state.rows);
  const callsBefore = state.calls.length;
  const attempts = [];
  const guards = [];
  const guard = (target, method) => {
    if (typeof target?.[method] !== 'function') return;
    guards.push(context.mock.method(target, method, () => {
      attempts.push(method);
      throw new Error(`Persistence/provider call forbidden during assessment: ${method}`);
    }));
  };
  for (const target of [mongoose.Model, mongoose.Model.prototype, mongoose.Collection.prototype,
    ...Object.values(models), User, SiteSettings]) {
    for (const method of WRITE_METHODS) guard(target, method);
  }
  guard(global, 'fetch');
  try {
    const response = await pending;
    assert.deepEqual(attempts, [], 'No persistence, audit, index or provider call is permitted');
    assert.deepEqual(clone(state.rows), before);
    assert.deepEqual(state.invalidations, []);
    assert.equal(state.calls.slice(callsBefore).some(call => WRITE_METHODS.includes(call.method)), false);
    assert.equal((response.text || '').includes(PRIVATE), false, response.text);
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.equal(response.headers.pragma, 'no-cache');
    assert.match(response.headers.vary, /Authorization/i);
    assert.match(response.headers.vary, /Cookie/i);
    return response;
  } finally {
    guards.reverse().forEach(fn => fn.mock.restore());
  }
}

function assertAssessment(response, { eligible, decision, complete = true, requiresFounder = false, reason } = {}) {
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.keys(response.body).sort(), ['data', 'ok', 'status', 'success']);
  const data = response.body.data;
  assert.deepEqual(Object.keys(data).sort(), [
    'articleId', 'complete', 'decision', 'eligible', 'members', 'publicCopies', 'reasonCodes', 'requiresFounder',
  ]);
  assert.equal(data.eligible, eligible);
  assert.equal(data.decision, decision);
  assert.equal(data.complete, complete);
  assert.equal(data.requiresFounder, requiresFounder);
  if (reason) assert.ok(data.reasonCodes.includes(reason), response.text);
  for (const member of data.members) {
    assert.deepEqual(Object.keys(member).sort(), ['historyKnown', 'id', 'language', 'restoreStatus', 'status']);
  }
  for (const copy of data.publicCopies) assert.deepEqual(Object.keys(copy).sort(), ['id', 'sourceNewsId']);
  return data;
}

for (const [index, base] of BASES.entries()) for (const role of ['founder', 'editor']) {
  test(`GET ${base}/:id/restore-eligibility is read-only and complete for ${role}`, async context => {
    const state = install(context, role === 'founder' ? { specialRightsOverride: [], moduleAccessStates: {} } : {});
    const { ids } = deletedGroup(state);
    const response = await readOnlyRequest(context, state,
      state.request('get', `${base}/${ids[index % 3]}/restore-eligibility`, undefined, role));
    const data = assertAssessment(response, { eligible: true, decision: 'eligible' });
    assert.equal(data.articleId, ids[index % 3]);
    assert.deepEqual(data.members.map(member => member.id), ids);
    assert.deepEqual(data.members.map(member => member.language), ['en', 'hi', 'gu']);
    assert.deepEqual(data.members.map(member => member.restoreStatus), ['draft', 'archived', 'draft']);
    assert.ok(data.members.every(member => member.historyKnown && member.status === 'deleted'));
    assert.deepEqual(data.publicCopies, state.rows.Article.map(copy => ({ id: copy._id, sourceNewsId: copy.sourceNewsId })));
    assert.deepEqual(data.reasonCodes, []);
    assert.equal(response.text.includes(FOREIGN_ID), false);
    const session = state.transactions.at(-1);
    assert.deepEqual(session.transactionOptions, { readConcern: { level: 'snapshot' } });
    assert.ok(session.ended && session.committed);
    for (const call of state.calls.filter(call => ['News', 'Article'].includes(call.name))) {
      assert.equal(call.options?.session, session);
    }
  });
}

for (const [label, overrides] of [
  ['missing Manage News', { moduleAccessStates: {} }],
  ['Add News only', { moduleAccessStates: { addNews: 'enabled' } }],
  ['Draft Desk only', { moduleAccessStates: { draftDesk: 'enabled' } }],
  ['unconfigured permanent right', { specialRightsConfigured: false }],
  ['empty permanent rights', { specialRightsOverride: [] }],
  ['edit/delete/publish instead', { specialRightsOverride: ['news_edit', 'news_delete', 'news_publish'] }],
  ['temporary-only restore', {
    specialRightsOverride: [], temporaryAccess: [{ rightKey: 'news_restore', enabled: true, expiresAt: FUTURE }],
  }],
  ['temporary right denial', {
    temporaryAccess: [
      { rightKey: 'news_restore', enabled: true, expiresAt: FUTURE },
      { rightKey: 'news_restore', enabled: false, expiresAt: FUTURE },
    ],
  }],
  ['temporary module denial', {
    temporaryAccess: [
      { moduleKey: 'manage_news', enabled: true, expiresAt: FUTURE },
      { moduleKey: 'manage_news', enabled: false, expiresAt: FUTURE },
    ],
  }],
]) for (const role of ['admin', 'editor', 'reporter']) {
  test(`${role} with ${label} cannot look up deleted records`, async context => {
    const state = install(context, overrides);
    const { ids } = deletedGroup(state);
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, role));
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.code, 'ARTICLE_RESTORE_FORBIDDEN');
    assert.equal(response.body.data, undefined);
    assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
  });
}

for (const restriction of ['global module lock', 'Safe Zone']) {
  test(`${restriction} denies assessment without auditing or looking up stories`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    if (restriction === 'global module lock') state.policy.manageNews = 'staff_locked';
    else {
      process.env.SAFE_ZONE_MASTER_LOCK = 'true';
      context.after(() => { delete process.env.SAFE_ZONE_MASTER_LOCK; });
    }
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
    assert.equal(response.status, 403, response.text);
    assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
  });
}

test('expired denials do not override the permanent restore grant', async context => {
  const state = install(context, {
    temporaryAccess: [{ rightKey: 'news_restore', enabled: false, expiresAt: PAST }],
  });
  const { ids } = deletedGroup(state);
  assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')),
    { eligible: true, decision: 'eligible' });
});

for (const [label, overrides, status] of [
  ['suspended', { accountStatus: 'suspended' }, 403],
  ['revoked token', { tokenVersion: 1 }, 401],
  ['login disabled', { loginAllowed: false }, 403],
  ['expired access', { noExpiry: false, accessExpiresAt: PAST }, 403],
]) {
  test(`${label} session is denied without account-expiry or audit writes`, async context => {
    const state = install(context, overrides);
    const { ids } = deletedGroup(state);
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
    assert.equal(response.status, status, response.text);
    assert.equal(response.body.data, undefined);
    assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
  });
}

for (const base of BASES) {
  test(`anonymous ${base} assessment does not disclose deleted news`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    const response = await readOnlyRequest(context, state,
      state.request('get', `${base}/${ids[0]}/restore-eligibility`, undefined, null));
    assert.equal(response.status, 401, response.text);
    assert.equal(response.body.data, undefined);
    assert.equal(state.calls.length, 0);
  });
}

test('invalid tokens retain 401 rather than an unavailable assessment', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  const response = await readOnlyRequest(context, state, request(app).get(pathFor(ids[0])).auth('not-a-jwt', { type: 'bearer' }));
  assert.equal(response.status, 401, response.text);
  assert.equal(state.calls.length, 0);
});

test('forged Founder JWT, query and body claims cannot grant restore access', async context => {
  const state = install(context, { specialRightsOverride: [] });
  const { ids } = deletedGroup(state);
  const token = state.token('editor', { role: 'founder', isFounder: true, specialRights: ['news_restore'] });
  const response = await readOnlyRequest(context, state,
    request(app).get(pathFor(ids[0])).auth(token, { type: 'bearer' })
      .query({ eligible: true, isFounder: true, role: 'founder' })
      .send({ trusted: true, isFounder: true, specialRightsConfigured: true, specialRightsOverride: ['news_restore'] }));
  assert.equal(response.status, 403, response.text);
  assert.equal(response.body.data, undefined);
  assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
});

test('forged Founder claims do not bypass group publication restrictions for an entitled staff account', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state, ['draft', 'published', 'draft']);
  const token = state.token('editor', { role: 'founder', isFounder: true });
  assertAssessment(await readOnlyRequest(context, state, request(app).get(pathFor(ids[0])).auth(token, { type: 'bearer' })),
    { eligible: false, decision: 'founder_required', requiresFounder: true, reason: 'RESTORE_PUBLICATION_HISTORY' });
});

for (const previous of ['published', 'scheduled']) for (const index of [0, 1, 2]) {
  test(`previously ${previous} edition ${index} requires Founder regardless of selected language`, async context => {
    const state = install(context);
    const statuses = ['draft', 'archived', 'draft'];
    statuses[index] = previous;
    const { ids } = deletedGroup(state, statuses);
    for (const role of ['editor', 'founder']) {
      const response = await readOnlyRequest(context, state,
        state.request('get', pathFor(ids[(index + 1) % 3]), undefined, role));
      const data = assertAssessment(response, {
        eligible: role === 'founder', decision: role === 'founder' ? 'eligible' : 'founder_required',
        requiresFounder: true, reason: 'RESTORE_PUBLICATION_HISTORY',
      });
      assert.deepEqual(data.members.map(member => member.restoreStatus), statuses);
    }
  });
}

for (const [label, patch] of [
  ['publication timestamp', { publishedAt: PAST }],
  ['schedule timestamp', { scheduledAt: PAST }],
  ['publish timestamp', { publishAt: PAST }],
  ['workflow stage', { workflowStage: 'PUBLISHED' }],
  ['nested workflow stage', { workflow: { stage: 'SCHEDULED' } }],
  ['history action', { workflowHistory: [{ action: 'PUBLISH' }] }],
  ['history destination', { workflowHistory: [{ toStage: 'SCHEDULED' }] }],
  ['history origin', { workflowHistory: [{ fromStage: 'PUBLISHED' }] }],
]) for (const name of ['News', 'Article']) {
  test(`hidden ${label} in a ${name} sibling requires Founder`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    Object.assign(state.rows[name][2], clone(patch));
    assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')), {
      eligible: false, decision: 'founder_required', requiresFounder: true, reason: 'RESTORE_PUBLICATION_HISTORY',
    });
  });
}

test('source-link-only groups and linked public-copy IDs use the actual restore resolver', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    delete doc.translationGroupId;
    delete doc.translationKey;
  }
  const response = await readOnlyRequest(context, state,
    state.request('get', pathFor(state.rows.Article[1]._id), undefined, 'editor'));
  const data = assertAssessment(response, { eligible: true, decision: 'eligible' });
  assert.equal(data.articleId, ids[1]);
  assert.deepEqual(data.members.map(member => member.id), ids);
});

test('a valid one-language story with no public copies does not require fabricated siblings or writes', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  state.rows.News = state.rows.News.slice(0, 1);
  state.rows.Article = [];
  delete state.rows.News[0].createdByUserId;
  const data = assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')),
    { eligible: true, decision: 'eligible' });
  assert.equal(data.members.length, 1);
  assert.deepEqual(data.publicCopies, []);
});

test('valid deletion history resolves a missing deletedFromStatus without guessing', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  delete state.rows.News[1].deletedFromStatus;
  const data = assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')),
    { eligible: true, decision: 'eligible' });
  assert.equal(data.members[1].restoreStatus, 'archived');
  assert.equal(data.members[1].historyKnown, true);
});

test('unknown history fails closed in assessment but preserves the explicit Founder POST fallback', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  delete state.rows.News[1].deletedFromStatus;
  state.rows.News[1].workflowHistory = [];
  for (const role of ['editor', 'founder']) {
    const data = assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, role)), {
      eligible: false, decision: 'incomplete', complete: false, requiresFounder: true, reason: 'RESTORE_HISTORY_UNKNOWN',
    });
    assert.equal(data.members[1].restoreStatus, null);
    assert.equal(data.members[1].historyKnown, false);
  }
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'founder');
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.restoreFallbackIds, [ids[1]]);
  assert.ok(state.rows.News.every(doc => doc.status === 'draft'));
});

for (const [label, mutate, reason] of [
  ['missing referenced News member', state => { state.rows.News.splice(1, 1); }, 'RESTORE_COPY_OWNERSHIP_CONFLICT'],
  ['unresolved source', state => { state.rows.News[2].sourceArticleId = FOREIGN_ID; }, 'RESTORE_SOURCE_UNRESOLVED'],
  ['conflicting group keys', state => { state.rows.News[2].translationKey = 'other-group'; }, 'RESTORE_GROUP_IDENTITY_CONFLICT'],
  ['foreign public-copy owner', state => { state.rows.Article[2].sourceNewsId = FOREIGN_ID; }, 'RESTORE_COPY_OWNERSHIP_CONFLICT'],
  ['unowned public copy matched by slug', state => {
    Object.assign(state.rows.Article[2], { sourceNewsId: null, sourceArticleId: null, translationKey: null, translationGroupId: null });
  }, 'RESTORE_COPY_OWNERSHIP_CONFLICT'],
  ['duplicate language', state => { state.rows.News[2].language = 'hi'; }, 'RESTORE_DUPLICATE_LANGUAGE'],
  ['duplicate News identity', state => { state.rows.News.push(clone(state.rows.News[2])); }, 'RESTORE_MEMBER_IDENTITY_INVALID'],
  ['duplicate public-copy identity', state => { state.rows.Article.push(clone(state.rows.Article[2])); }, 'RESTORE_MEMBER_IDENTITY_INVALID'],
  ['invalid language', state => { state.rows.News[2].language = PRIVATE; }, 'RESTORE_MEMBER_IDENTITY_INVALID'],
  ['array-valued group identity', state => { state.rows.News[2].translationKey = ['story-test-group']; }, 'RESTORE_MEMBER_IDENTITY_INVALID'],
  ['array-valued status', state => { state.rows.News[2].status = ['deleted']; }, 'RESTORE_MEMBER_IDENTITY_INVALID'],
  ['unknown private status text', state => { state.rows.News[2].status = PRIVATE; }, 'RESTORE_MEMBER_IDENTITY_INVALID'],
  ['missing slug', state => { delete state.rows.News[2].slug; }, 'RESTORE_INVALID_SLUG'],
  ['blank slug', state => { state.rows.News[2].slug = ' '; }, 'RESTORE_INVALID_SLUG'],
  ['malformed slug bucket', state => { state.rows.News[2].slugs = { en: { note: PRIVATE } }; }, 'RESTORE_INVALID_SLUG'],
  ['malformed history container', state => { state.rows.News[2].workflowHistory = { note: PRIVATE }; }, 'RESTORE_HISTORY_INVALID'],
  ['malformed history entry', state => { state.rows.News[2].workflowHistory = [null]; }, 'RESTORE_HISTORY_INVALID'],
  ['date-valued history entry', state => { state.rows.News[2].workflowHistory = [new Date(PAST)]; }, 'RESTORE_HISTORY_INVALID'],
  ['array-valued pre-delete status', state => { state.rows.News[2].deletedFromStatus = ['draft']; }, 'RESTORE_HISTORY_INVALID'],
  ['malformed workflow container', state => { state.rows.Article[2].workflow = []; }, 'RESTORE_INVALID_WORKFLOW'],
  ['date-valued workflow container', state => { state.rows.Article[2].workflow = new Date(PAST); }, 'RESTORE_INVALID_WORKFLOW'],
  ['invalid embargo timestamp', state => { state.rows.Article[2].embargoUntil = 'not-a-date'; }, 'RESTORE_METADATA_INVALID'],
]) {
  test(`${label} is explicitly incomplete, never eligible`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    mutate(state);
    for (const role of ['editor', 'founder']) {
      const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, role));
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.data.eligible, false);
      assert.equal(response.body.data.complete, false);
      assert.equal(response.body.data.decision, 'incomplete');
      assert.ok(response.body.data.reasonCodes.includes(reason), response.text);
    }
  });
}

for (const [label, patch, reason] of [
  ['locked', { locked: true }, 'RESTORE_LOCKED'],
  ['workflow locked', { workflow: { locked: true } }, 'RESTORE_LOCKED'],
  ['Founder approval', { requiresFounderApproval: true }, 'RESTORE_FOUNDER_APPROVAL_REQUIRED'],
  ['private flag', { isPrivate: true }, 'RESTORE_PRIVATE'],
  ['private visibility', { visibility: 'private' }, 'RESTORE_PRIVATE'],
  ['embargo', { embargoUntil: FUTURE }, 'RESTORE_EMBARGOED'],
  ['workflow embargo', { workflow: { embargoUntil: FUTURE } }, 'RESTORE_EMBARGOED'],
]) for (const name of ['News', 'Article']) {
  test(`${name} ${label} is a group-wide staff restriction without changing Founder authority`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    Object.assign(state.rows[name][2], clone(patch));
    for (const role of ['editor', 'founder']) {
      assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, role)), {
        eligible: role === 'founder', decision: role === 'founder' ? 'eligible' : 'founder_required',
        requiresFounder: true, reason,
      });
    }
  });
}

test('a non-deleted member yields a blocked assessment and unchanged POST conflict', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  state.rows.News[2].status = 'draft';
  assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'founder')), {
    eligible: false, decision: 'blocked', requiresFounder: true, reason: 'RESTORE_NOT_DELETED',
  });
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'founder');
  assert.equal(response.status, 409, response.text);
});

test('slug conflicts return a non-sensitive blocked assessment without adopting foreign records', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  state.rows.News.push({
    _id: FOREIGN_ID, slug: state.rows.News[0].slug, translationGroupId: 'foreign-story', title: PRIVATE,
  });
  const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
  assertAssessment(response, { eligible: false, decision: 'blocked', reason: 'RESTORE_SLUG_CONFLICT' });
  assert.equal(response.text.includes(FOREIGN_ID), false);
});

test('incomplete previous publication is checked before Founder eligibility or any restore write', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state, ['draft', 'draft', 'published']);
  state.rows.News[2].content = '';
  assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'founder')), {
    eligible: false, decision: 'incomplete', complete: false, requiresFounder: true, reason: 'RESTORE_PUBLICATION_INCOMPLETE',
  });
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'founder');
  assert.equal(response.status, 409, response.text);
  assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name) && WRITE_METHODS.includes(call.method)), false);
});

for (const [id, status, code] of [
  ['malformed-id', 400, 'INVALID_ARTICLE_ID'],
  [FOREIGN_ID, 404, 'ARTICLE_NOT_FOUND'],
]) {
  test(`${code} does not become an empty successful assessment`, async context => {
    const state = install(context);
    deletedGroup(state);
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(id), undefined, 'editor'));
    assert.equal(response.status, status, response.text);
    assert.equal(response.body.code, code);
    assert.equal(response.body.data, undefined);
  });
}

for (const operation of ['News.findById', 'News.find', 'News.findOne', 'Article.find', 'session', 'policy', 'authentication']) {
  test(`${operation} lookup failure never returns eligibility or group details`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    const failure = Object.assign(new Error(PRIVATE), { name: 'MongoNetworkError' });
    if (operation === 'session') context.mock.method(mongoose, 'startSession', async () => { throw failure; });
    else if (operation === 'policy') context.mock.method(SiteSettings, 'findOne', () => { throw failure; });
    else if (operation === 'authentication') context.mock.method(User, 'findById', () => { throw failure; });
    else state.failures[operation] = { name: failure.name };
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
    assert.equal(response.status, 503, response.text);
    assert.equal(response.body.code, operation === 'authentication' ? 'AUTH_UNAVAILABLE' : 'RESTORE_ELIGIBILITY_UNAVAILABLE');
    assert.equal(response.body.data, undefined);
  });
}

test('unexpected storage failures return a safe 500 rather than raw errors or eligibility', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  context.mock.method(models.Article, 'find', () => { throw new Error(PRIVATE); });
  const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
  assert.equal(response.status, 500, response.text);
  assert.equal(response.body.code, 'RESTORE_ELIGIBILITY_FAILED');
  assert.equal(response.body.data, undefined);
});

test('cookie sessions and HEAD requests retain authorization and no-store behavior', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  const token = state.token('editor');
  const response = await readOnlyRequest(context, state,
    request(app).get(pathFor(ids[0])).set('Cookie', `np_admin_token=${token}`));
  assertAssessment(response, { eligible: true, decision: 'eligible' });
  assert.equal((await readOnlyRequest(context, state,
    request(app).head(pathFor(ids[0])).set('Cookie', `np_admin_token=${token}`))).status, 200);
  assert.equal((await readOnlyRequest(context, state, request(app).head(pathFor(ids[0])))).status, 401);
});

for (const id of ['malformed-id', FOREIGN_ID]) {
  test(`insufficient entitlement cannot probe existence or validity of ${id}`, async context => {
    const state = install(context, { specialRightsOverride: [] });
    deletedGroup(state);
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(id), undefined, 'editor'));
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.data, undefined);
    assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
  });
}

for (const role of ['editor', 'founder']) {
  test(`${role} account restrictions are rechecked inside the assessment transaction`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    const start = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      state.access.accountStatus = 'suspended';
      return start();
    });
    const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, role));
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.data, undefined);
    assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
  });
}

test('assessment retries do not return a previous eligible result after entitlement revocation', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  const start = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await start();
    const transact = session.withTransaction.bind(session);
    session.withTransaction = async (work, options) => {
      await assert.rejects(transact(async () => { await work(); throw new Error('Synthetic retry'); }, options), /Synthetic retry/);
      state.access.specialRightsOverride = [];
      await transact(work, options);
    };
    return session;
  });
  const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
  assert.equal(response.status, 403, response.text);
  assert.equal(response.body.data, undefined);
  assert.ok(state.transactions.every(session => session.aborted && session.ended));
});

test('a seed absent from the resolved member set fails closed with a conflict', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  const find = models.News.find;
  context.mock.method(models.News, 'find', (...args) => {
    const query = find(...args);
    const lean = query.lean.bind(query);
    query.lean = async () => (await lean()).filter(doc => doc._id !== ids[0]);
    return query;
  });
  const response = await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor'));
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.code, 'ARTICLE_RESTORE_SCOPE_CHANGED');
  assert.equal(response.body.data, undefined);
});

test('an active public copy prevents staff eligibility even without retained publication timestamps', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  state.rows.Article[2].status = 'published';
  assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')), {
    eligible: false, decision: 'founder_required', requiresFounder: true, reason: 'RESTORE_NOT_DELETED',
  });
});

test('public article namespaces do not expose restore assessments', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  const response = await state.request('get', `/api/public/articles/${ids[0]}/restore-eligibility`, undefined, null);
  assert.equal(response.status, 404, response.text);
  assert.equal(response.body.data, null);
  assert.equal(response.text.includes(PRIVATE), false);
  assert.equal(state.calls.some(call => ['News', 'Article'].includes(call.name)), false);
});

for (const change of ['rights revoked', 'new publication history', 'public-copy history', 'member undeleted']) {
  test(`POST independently rejects ${change} after a successful assessment`, async context => {
    const state = install(context);
    const { ids } = deletedGroup(state);
    assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')),
      { eligible: true, decision: 'eligible' });
    if (change === 'rights revoked') state.access.specialRightsOverride = [];
    if (change === 'new publication history') state.rows.News[2].publishedAt = PAST;
    if (change === 'public-copy history') state.rows.Article[2].workflowHistory = [{ action: 'SCHEDULE' }];
    if (change === 'member undeleted') state.rows.News[2].status = 'draft';
    const before = clone(state.rows.News);
    const copiesBefore = clone(state.rows.Article);
    const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {
      eligible: true, complete: true, isFounder: true, restoreStatus: 'draft',
    }, 'editor');
    assert.equal(response.status, change === 'member undeleted' ? 409 : 403, response.text);
    assert.deepEqual(clone(state.rows.News), before);
    assert.deepEqual(clone(state.rows.Article), copiesBefore);
    assert.deepEqual(state.invalidations, []);
  });
}

test('POST reauthorizes transaction retries and discards a previously eligible attempt', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')),
    { eligible: true, decision: 'eligible' });
  const before = clone(state.rows);
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
  const response = await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'editor');
  assert.equal(response.status, 403, response.text);
  for (const name of ['News', 'Article', 'PushHistory', 'TranslationJob']) assert.deepEqual(clone(state.rows[name]), before[name]);
  assert.deepEqual(state.invalidations, []);
  assert.equal(state.calls.slice(retryIndex).some(call => ['News', 'Article'].includes(call.name) && WRITE_METHODS.includes(call.method)), false);
});

test('eligible assessment preserves the actual canonical and legacy staff restore response contracts', async context => {
  const state = install(context);
  const { ids } = deletedGroup(state);
  assertAssessment(await readOnlyRequest(context, state, state.request('get', pathFor(ids[0]), undefined, 'editor')),
    { eligible: true, decision: 'eligible' });
  const response = await state.request('post', `/api/admin/drafts/${ids[0]}/restore`, {}, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.changedIds, ids);
  assert.deepEqual(response.body.restoredStatuses.sort(), ['archived', 'draft']);
  assert.deepEqual(response.body.restoreFallbackIds, []);
  assert.deepEqual(state.rows.News.map(doc => doc.status), ['draft', 'archived', 'draft']);
});

for (const role of ['editor', 'founder']) {
  test(`archived-to-draft PUT remains ${role === 'founder' ? 'permitted' : 'denied'} for ${role}`, async context => {
    const state = install(context, { ...RESTORER, specialRightsOverride: ['news_edit', 'news_restore'] });
    const { ids } = seedGroup(state, { status: 'draft' });
    for (const doc of [...state.rows.News, ...state.rows.Article]) doc.status = 'archived';
    const response = await state.request('put', `/api/articles/${ids[0]}`, { status: 'draft' }, role);
    assert.equal(response.status, role === 'founder' ? 200 : 403, response.text);
    if (role === 'editor') assert.equal(response.body.code, 'ARTICLE_SAVE_FORBIDDEN');
    assert.ok(state.rows.News.every(doc => doc.status === (role === 'founder' ? 'draft' : 'archived')));
  });
}
