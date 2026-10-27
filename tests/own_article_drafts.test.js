require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const News = require('../models/News');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const StaffTask = require('../models/StaffTask');
const mongooseFind = News.find;
const mongooseFindOne = News.findOne;
const mongooseCount = News.countDocuments;
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin', '/api/api', '/api/api/admin'];
const BASE = '/api/articles/own-drafts';
const ID = '507f1f77bcf86cd79943a001';
const OTHER_ID = '507f1f77bcf86cd79943a002';
const ABSENT_ID = '507f1f77bcf86cd79943afff';
const PRIVATE = 'SYNTHETIC-PRIVATE-SIBLING-METADATA';
const PAST = '2000-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const DRAFTER = { moduleAccessStates: { draftDesk: 'enabled' } };
const POLICY = { adminModulePolicy: { version: 1, modulePolicies: { addNews: 'available', draftDesk: 'available', manageNews: 'available' } } };
const LIST_KEYS = ['_id', 'id', 'title', 'slug', 'status', 'category', 'imageURL', 'description', 'summary', 'language', 'lang', 'coverImageUrl', 'createdAt', 'updatedAt'];
const DETAIL_KEYS = [...LIST_KEYS, 'content', 'body', 'editorialType', 'track', 'topic', 'tags', 'externalUrls', 'embeds', 'gallery', 'stateTags', 'stateNames', 'coverImage', 'seo', 'location', 'geo'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const copy = value => JSON.parse(JSON.stringify(value));

function install(context, access = DRAFTER) {
  const state = installEditorialFixture(context);
  state.access = copy(access);
  state.policy = copy(POLICY);
  state.accountUpdates = [];
  for (const method of ['findById', 'findOne']) {
    const findUser = User[method];
    context.mock.method(User, method, (...args) => {
      const query = findUser(...args);
      const lean = query.lean.bind(query);
      query.lean = async () => {
        const user = await lean();
        return user ? { ...user, specialRightsConfigured: true, specialRightsOverride: [], ...copy(state.access) } : null;
      };
      return query;
    });
  }
  context.mock.method(User, 'findByIdAndUpdate', async (...args) => {
    state.accountUpdates.push(args);
    return null;
  });
  context.mock.method(Role, 'findOne', () => ({ lean: async () => null }));
  context.mock.method(Role, 'findById', () => ({ lean: async () => null }));
  context.mock.method(SiteSettings, 'findOne', () => ({
    lean: async () => state.policy,
    then(resolve, reject) { return Promise.resolve(state.policy).then(resolve, reject); },
  }));
  context.mock.method(SiteSettings, 'create', () => assert.fail('Own-draft reads must not initialize module policy'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('Own-draft reads must not upgrade module policy'));
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  return state;
}

function draft(overrides = {}) {
  return {
    _id: ID, createdByUserId: actorId('reporter'), status: 'draft',
    title: 'Own draft headline', description: 'Own draft summary', content: '<p>Own draft body</p>',
    slug: 'own-draft-headline', category: 'national', lang: 'en', language: 'en',
    imageURL: '/uploads/legacy.jpg', coverImage: { url: '/uploads/cover.jpg', publicId: 'own-cover', alt: 'Own cover' },
    editorialType: 'news', track: 'standard', topic: 'own-topic',
    tags: ['national'], externalUrls: ['https://example.invalid/source'], embeds: [], gallery: [],
    stateTags: ['gujarat'], stateNames: ['Gujarat'],
    seo: { metaTitle: 'Own SEO title', metaDescription: 'Own SEO summary', canonicalUrl: 'https://example.invalid/own-draft' },
    location: { state: 'Gujarat', stateSlug: 'gujarat', district: 'Ahmedabad', districtSlug: 'ahmedabad', city: 'Ahmedabad', citySlug: 'ahmedabad', country: 'India', isUT: false },
    geo: { state: 'gujarat', district: 'ahmedabad', city: 'ahmedabad' },
    workflowStage: 'DRAFT', workflow: { stage: 'DRAFT', locked: false, embargoUntil: null },
    publishedAt: null, scheduledAt: null, publishAt: null, deletedAt: null,
    locked: false, requiresFounderApproval: false, embargoUntil: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'), updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

function assertPrivate(response) {
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(response.headers.pragma, 'no-cache');
  const vary = response.headers.vary.toLowerCase().split(/,\s*/);
  assert.ok(vary.includes('authorization'));
  assert.ok(vary.includes('cookie'));
  assert.equal(response.headers.etag, undefined);
}

function assertReadOnly(state, before) {
  assert.deepEqual(copy(state.rows), before);
  assert.deepEqual(state.invalidations, []);
  assert.deepEqual(state.transactions, []);
  assert.ok(state.calls.every(call => call.name === 'News' && !WRITES.has(call.method)));
  assert.equal(SiteSettings.create.mock.callCount(), 0);
  assert.equal(SiteSettings.findOneAndUpdate.mock.callCount(), 0);
  assert.equal(PublicSiteSettings.getOrCreate.mock.callCount(), 0);
}

async function listAndDetail(state, base = BASE, role = 'reporter', id = ID) {
  const list = await state.request('get', base, undefined, role);
  const detail = await state.request('get', `${base}/${id}`, undefined, role);
  assertPrivate(list);
  assertPrivate(detail);
  return { list, detail };
}

function resign(call, overrides, { emailOnly = false } = {}) {
  const payload = jwt.decode(call.get('Authorization').slice(7));
  if (emailOnly) delete payload.sub;
  Object.assign(payload, overrides);
  return call.set('Authorization', `Bearer ${jwt.sign(payload, process.env.JWT_SECRET, { algorithm: 'HS256' })}`);
}

for (const prefix of PREFIXES) {
  const base = `${prefix}/articles/own-drafts`;
  for (const moduleKey of ['addNews', 'draftDesk']) {
    test(`${base} lists and reopens only owned drafts with ${moduleKey} and no Special Rights`, async context => {
      const state = install(context, { moduleAccessStates: { [moduleKey]: 'enabled' } });
      state.rows.News.push(draft(), draft({ _id: OTHER_ID, createdByUserId: actorId('editor'), title: PRIVATE }));
      const before = copy(state.rows);
      const { list, detail } = await listAndDetail(state, base);
      assert.equal(list.status, 200, list.text);
      assert.equal(detail.status, 200, detail.text);
      assert.deepEqual(list.body.items.map(row => row._id), [ID]);
      assert.equal(list.body.total, 1);
      assert.deepEqual(list.body.articles, list.body.items);
      assert.deepEqual(list.body.data, { items: list.body.items, page: 1, limit: 20, total: 1, pages: 1 });
      assert.deepEqual(detail.body.article, detail.body.data.article);
      assert.deepEqual(Object.keys(list.body.items[0]).sort(), [...LIST_KEYS].sort());
      assert.deepEqual(Object.keys(detail.body.article).sort(), [...DETAIL_KEYS].sort());
      assert.equal(detail.body.article.body, '<p>Own draft body</p>');
      assert.equal(detail.body.article.summary, 'Own draft summary');
      assert.equal(detail.body.article.coverImageUrl, '/uploads/cover.jpg');
      assert.equal(JSON.stringify([list.body, detail.body]).includes(PRIVATE), false);
      assertReadOnly(state, before);
    });
  }
  test(`${base} rejects anonymous reads and protects HEAD`, async context => {
    const state = install(context);
    state.rows.News.push(draft());
    const before = copy(state.rows);
    const { list, detail } = await listAndDetail(state, base, null);
    assert.equal(list.status, 401);
    assert.equal(detail.status, 401);
    for (const path of [base, `${base}/${ID}`]) {
      const denied = await state.request('head', path, undefined, null);
      assert.equal(denied.status, 401);
      assertPrivate(denied);
      const allowed = await state.request('head', path, undefined, 'reporter');
      assert.equal(allowed.status, 200);
      assertPrivate(allowed);
      assert.equal(allowed.text, undefined);
    }
    assertReadOnly(state, before);
  });
  for (const cookie of ['np_admin_token', 'np_token', 'token']) {
    test(`${base} uses persisted identity with the ${cookie} cookie`, async context => {
      const state = install(context);
      state.rows.News.push(draft());
      const before = copy(state.rows);
      for (const path of [base, `${base}/${ID}`]) {
        const call = state.request('get', path, undefined, 'reporter');
        const token = call.get('Authorization').slice(7);
        const response = await call.unset('Authorization').set('Cookie', `${cookie}=${encodeURIComponent(token)}`);
        assert.equal(response.status, 200, response.text);
        assertPrivate(response);
      }
      assertReadOnly(state, before);
    });
  }
}

const AUTH_CASES = [
  ['invalid signature', call => call.set('Authorization', 'Bearer invalid.synthetic.signature')],
  ['expired JWT', call => resign(call, { exp: 1 })],
  ['wrong token type', call => resign(call, { type: 'refresh' })],
  ['revoked token version', call => resign(call, { tokenVersion: 4 })],
  ['unpersisted account', call => resign(call, { sub: ABSENT_ID })],
  ['invalid subject', call => resign(call, { sub: 'not-an-object-id' })],
];
for (const [label, change] of AUTH_CASES) {
  test(`own drafts reject ${label} before content queries`, async context => {
    const state = install(context);
    state.rows.News.push(draft());
    const before = copy(state.rows);
    for (const path of [BASE, `${BASE}/${ID}`]) {
      const response = await change(state.request('get', path, undefined, 'reporter'));
      assert.equal(response.status, 401, response.text);
      assertPrivate(response);
    }
    assert.deepEqual(state.calls, []);
    assertReadOnly(state, before);
  });
}

test('email-only signed authentication resolves the persisted owner, not JWT authority', async context => {
  const state = install(context);
  state.rows.News.push(draft(), draft({ _id: OTHER_ID, createdByUserId: actorId('founder') }));
  const before = copy(state.rows);
  const list = await resign(state.request('get', BASE, undefined, 'reporter'), { role: 'founder' }, { emailOnly: true });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.items.map(row => row._id), [ID]);
  const detail = await resign(state.request('get', `${BASE}/${OTHER_ID}`, undefined, 'reporter'), { role: 'founder' });
  assert.equal(detail.status, 404, detail.text);
  assertReadOnly(state, before);
});

for (const userId of [undefined, 'not-a-persistent-id', [actorId('reporter')]]) {
  test(`own-draft identity rejects a malformed persisted ID (${String(userId)})`, async context => {
    const state = install(context);
    const findUser = User.findById;
    context.mock.method(User, 'findById', (...args) => {
      const query = findUser(...args);
      const lean = query.lean.bind(query);
      query.lean = async () => ({ ...await lean(), _id: userId });
      return query;
    });
    const { list, detail } = await listAndDetail(state);
    assert.equal(list.status, 401, list.text);
    assert.equal(detail.status, 401, detail.text);
    assert.deepEqual(state.calls, []);
  });
}

const grant = (moduleKey = 'draft_desk', expiresAt = FUTURE) => ({ moduleKey, enabled: true, expiresAt });
const denial = (moduleKey = 'draftDesk', expiresAt = FUTURE) => ({ moduleKey, enabled: false, expiresAt });
const MODULE_CASES = [
  ['missing module access', {}, false],
  ['Manage News only', { moduleAccessStates: { manageNews: 'enabled' } }, false],
  ['news_edit without modules', { specialRightsOverride: ['news_edit'] }, false],
  ['legacy Add News', { moduleAccessOverride: ['add_news'] }, true],
  ['legacy Draft Desk', { moduleAccessOverride: ['draft_desk'] }, true],
  ['canonical alias states', { moduleAccessStates: { draft_desk: 'enabled' } }, true],
  ['explicit module denial overrides legacy', { moduleAccessOverride: ['draft_desk'], moduleAccessStates: { draftDesk: 'disabled' } }, false],
  ['temporary grant', { temporaryAccess: [grant()] }, true],
  ['expired temporary grant', { temporaryAccess: [grant('draftDesk', PAST)] }, false],
  ['invalid temporary grant', { temporaryAccess: [grant('draftDesk', 'invalid-date')] }, false],
  ['missing temporary expiry', { temporaryAccess: [{ moduleKey: 'draftDesk', enabled: true }] }, false],
  ['grant followed by denial', { ...DRAFTER, temporaryAccess: [grant(), denial()] }, false],
  ['denial followed by grant', { ...DRAFTER, temporaryAccess: [denial(), grant()] }, false],
  ['expired denial and valid grant', { temporaryAccess: [denial('draftDesk', PAST), grant()] }, true],
  ['active denial and expired grant', { ...DRAFTER, temporaryAccess: [denial(), grant('draftDesk', PAST)] }, false],
  ['unrelated module denial', { ...DRAFTER, temporaryAccess: [denial('manageNews')] }, true],
  ['Add News survives Draft Desk denial', { moduleAccessStates: { addNews: 'enabled' }, temporaryAccess: [denial()] }, true],
  ['configured-empty permanent rights', { ...DRAFTER, specialRightsConfigured: true, specialRightsOverride: [], permissions: { canEditNews: true } }, true],
];
for (const [label, access, allowed] of MODULE_CASES) {
  test(`own drafts use effective module decisions: ${label}`, async context => {
    const state = install(context, access);
    state.rows.News.push(draft());
    const before = copy(state.rows);
    const { list, detail } = await listAndDetail(state);
    for (const response of [list, detail]) {
      assert.equal(response.status, allowed ? 200 : 403, response.text);
      if (!allowed) assert.equal(response.body.code, 'DRAFT_READ_FORBIDDEN');
    }
    if (!allowed) assert.deepEqual(state.calls, []);
    assertReadOnly(state, before);
  });
}

for (const globalState of ['hidden', 'staff_locked', 'founder_only']) {
  test(`global ${globalState} cannot be bypassed by saved or temporary modules`, async context => {
    const state = install(context, { moduleAccessStates: { addNews: 'enabled', draftDesk: 'enabled' }, temporaryAccess: [grant(), grant('addNews')] });
    state.policy.adminModulePolicy.modulePolicies = { addNews: globalState, draftDesk: globalState };
    const { list, detail } = await listAndDetail(state);
    assert.equal(list.status, 403, list.text);
    assert.equal(detail.status, 403, detail.text);
    assert.deepEqual(state.calls, []);
  });
}

test('Founder authority and owner-scoping coexist without policy initialization', async context => {
  const state = install(context, { temporaryAccess: [denial(), denial('addNews')] });
  state.policy = null;
  state.rows.News.push(draft({ createdByUserId: actorId('founder') }), draft({ _id: OTHER_ID }));
  const before = copy(state.rows);
  const { list, detail } = await listAndDetail(state, BASE, 'founder');
  assert.equal(list.status, 200, list.text);
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(list.body.items.map(row => row._id), [ID]);
  assert.equal((await state.request('get', `${BASE}/${OTHER_ID}`, undefined, 'founder')).status, 404);
  assertReadOnly(state, before);
});

test('missing policy fails closed for staff without creating settings', async context => {
  const state = install(context);
  state.policy = null;
  const before = copy(state.rows);
  const { list, detail } = await listAndDetail(state);
  assert.equal(list.status, 403, list.text);
  assert.equal(detail.status, 403, detail.text);
  assertReadOnly(state, before);
});

const ACCOUNT_CASES = [
  ['suspended', { accountStatus: 'suspended' }, 'ACCOUNT_SUSPENDED'],
  ['legacy suspended', { status: 'suspended' }, 'ACCOUNT_SUSPENDED'],
  ['locked', { accountStatus: 'locked' }, 'ACCOUNT_LOCKED'],
  ['future lock', { lockedUntil: FUTURE }, 'ACCOUNT_LOCKED'],
  ['expired', { accountStatus: 'expired' }, 'ACCOUNT_EXPIRED'],
  ['expired access', { accessExpiresAt: PAST, noExpiry: false }, 'ACCOUNT_EXPIRED'],
  ['archived', { accountStatus: 'archived' }, 'ACCOUNT_ARCHIVED'],
  ['deleted', { isDeleted: true }, 'ACCOUNT_DELETED'],
  ['deleted timestamp', { deletedAt: PAST }, 'ACCOUNT_DELETED'],
  ['disabled', { accountStatus: 'disabled' }, 'ACCOUNT_SUSPENDED'],
  ['login disabled', { loginAllowed: false }, 'LOGIN_DISABLED'],
];
for (const [label, fields, code] of ACCOUNT_CASES) {
  test(`${label} accounts cannot read own drafts`, async context => {
    const state = install(context, { ...DRAFTER, ...fields });
    state.rows.News.push(draft());
    const before = copy(state.rows);
    const { list, detail } = await listAndDetail(state);
    for (const response of [list, detail]) {
      assert.equal(response.status, 403, response.text);
      assert.equal(response.body.code, code);
    }
    assert.deepEqual(state.calls, []);
    assertReadOnly(state, before);
  });
}

test('no-expiry accounts and expired locks retain existing eligibility', async context => {
  const state = install(context, { ...DRAFTER, accessExpiresAt: PAST, noExpiry: true, lockedUntil: PAST });
  state.rows.News.push(draft());
  const { list, detail } = await listAndDetail(state);
  assert.equal(list.status, 200, list.text);
  assert.equal(detail.status, 200, detail.text);
});

const RESTRICTED = [
  ['foreign creator', { createdByUserId: actorId('editor') }],
  ['missing creator', { createdByUserId: undefined }],
  ['null creator', { createdByUserId: null }],
  ['array creator', { createdByUserId: [actorId('reporter'), actorId('editor')] }],
  ...['published', 'scheduled', 'deleted', 'archived', 'pending', 'DRAFT'].map(status => [`${status} status`, { status }]),
  ['missing status', { status: undefined }],
  ['array status', { status: ['draft', 'published'] }],
  ...['deletedAt', 'publishedAt', 'scheduledAt', 'publishAt'].flatMap(field => [
    [`${field} timestamp`, { [field]: new Date(PAST) }],
    [`${field} array`, { [field]: [null, new Date(PAST)] }],
  ]),
  ['locked', { locked: true }],
  ['array lock', { locked: [false, true] }],
  ['workflow lock', { workflow: { locked: true } }],
  ['array workflow lock', { workflow: { locked: [false, true] } }],
  ['Founder approval', { requiresFounderApproval: true }],
  ['array Founder approval', { requiresFounderApproval: [false, true] }],
  ['review workflow stage', { workflowStage: 'REVIEW' }],
  ['array workflow stage', { workflowStage: ['DRAFT', 'PUBLISHED'] }],
  ['nested workflow stage', { workflow: { stage: 'PUBLISHED' } }],
  ['array nested workflow stage', { workflow: { stage: ['DRAFT', 'PUBLISHED'] } }],
  ['array workflow container', { workflow: [{ stage: 'DRAFT' }, { stage: 'PUBLISHED', locked: true }] }],
  ['empty workflow array', { workflow: [] }],
  ['string workflow container', { workflow: 'PUBLISHED' }],
  ['boolean workflow container', { workflow: false }],
  ['number workflow container', { workflow: 0 }],
  ['private flag', { isPrivate: true }],
  ['array private flag', { isPrivate: [false, true] }],
  ['private visibility', { visibility: 'private' }],
  ['array visibility', { visibility: ['public', 'private'] }],
  ['embargo', { embargoUntil: new Date(FUTURE) }],
  ['nested embargo', { workflow: { embargoUntil: new Date(FUTURE) } }],
  ['array embargo', { embargoUntil: [null, new Date(FUTURE)] }],
  ['array nested embargo', { workflow: { embargoUntil: [null, new Date(FUTURE)] } }],
];
for (const [label, fields] of RESTRICTED) {
  test(`list, count and detail exclude ${label} without disclosing existence`, async context => {
    const state = install(context);
    state.rows.News.push(draft(fields), draft({ _id: OTHER_ID }));
    const before = copy(state.rows);
    const { list, detail } = await listAndDetail(state);
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(list.body.items.map(row => row._id), [OTHER_ID]);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.pages, 1);
    const absent = await state.request('get', `${BASE}/${ABSENT_ID}`, undefined, 'reporter');
    assert.equal(detail.status, 404, detail.text);
    assert.deepEqual(detail.body, absent.body);
    assert.deepEqual(detail.body, { ok: false, success: false, status: 404, code: 'DRAFT_NOT_FOUND', message: 'Draft not found.' });
    assertReadOnly(state, before);
  });
}

test('legacy absent restrictions and past embargoes are eligible without ownership backfill', async context => {
  const state = install(context);
  state.rows.News.push(
    { _id: ID, createdByUserId: actorId('reporter'), status: 'draft', title: 'Legacy own draft' },
    draft({ _id: OTHER_ID, workflow: null, embargoUntil: new Date(PAST) }),
    draft({ _id: ABSENT_ID, workflowStage: 'draft', workflow: { stage: 'draft', embargoUntil: new Date(PAST) } }),
  );
  const before = copy(state.rows);
  const { list, detail } = await listAndDetail(state);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.total, 3);
  assert.equal(detail.status, 200, detail.text);
  assertReadOnly(state, before);
});

test('task links, bylines, history and group membership are not ownership grants', async context => {
  const state = install(context);
  const task = { assignedToStaffId: actorId('reporter'), relatedNewsId: ID, status: 'assigned' };
  context.mock.method(StaffTask, 'find', () => ({ lean: async () => [task] }));
  context.mock.method(StaffTask, 'findOne', () => ({ lean: async () => task }));
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  state.rows.News[0].createdByUserId = actorId('editor');
  state.rows.News[0].author = actorId('reporter');
  state.rows.News[0].createdBy = actorId('reporter');
  state.rows.News[0].staffId = actorId('reporter');
  state.rows.News[0].authorByline = { userId: actorId('reporter') };
  state.rows.News[0].workflowHistory = [{ actor: actorId('reporter') }];
  state.rows.News[1].createdByUserId = actorId('reporter');
  const before = copy(state.rows);
  const { list, detail } = await listAndDetail(state, BASE, 'reporter', ids[0]);
  assert.deepEqual(list.body.items.map(row => row._id), [ids[1]]);
  assert.equal(detail.status, 404);
  assert.equal((await state.request('get', `${BASE}/${ids[2]}`, undefined, 'reporter')).status, 404);
  assert.equal(StaffTask.find.mock.callCount(), 0);
  assert.equal(StaffTask.findOne.mock.callCount(), 0);
  assertReadOnly(state, before);
});

for (const [index, language, title] of [
  [0, 'en', 'Owned English headline'],
  [1, 'hi', '\u0905\u092a\u0928\u0940 \u0916\u092c\u0930'],
  [2, 'gu', '\u0aaa\u0acb\u0aa4\u0abe\u0aa8\u0abe \u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0'],
]) {
  test(`${language} draft DTO preserves only its stored language, never sibling metadata or buckets`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    for (const row of state.rows.News) {
      row.title = PRIVATE;
      row.content = PRIVATE;
    }
    const own = state.rows.News[index];
    Object.assign(own, draft({
      _id: ids[index], title, content: `<p>${title}</p>`, lang: language, language,
      translations: { en: { title: PRIVATE }, hi: { content: PRIVATE }, gu: { summary: PRIVATE } },
      i18n: { title: { en: PRIVATE, hi: PRIVATE, gu: PRIVATE } },
      translationStatus: { en: PRIVATE }, translationGroupId: PRIVATE, translationKey: PRIVATE,
      sourceArticleId: ids[(index + 1) % 3], slugs: { en: PRIVATE, hi: PRIVATE, gu: PRIVATE },
    }));
    const before = copy(state.rows);
    const { list, detail } = await listAndDetail(state, BASE, 'reporter', own._id);
    assert.equal(list.status, 200, list.text);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(list.body.total, 1);
    assert.equal(detail.body.article.title, title);
    assert.equal(detail.body.article.content, `<p>${title}</p>`);
    assert.equal(detail.body.article.language, language);
    assert.equal(detail.body.article.lang, language);
    const serialized = JSON.stringify([list.body, detail.body]);
    assert.equal(serialized.includes(PRIVATE), false);
    for (const id of ids.filter(id => id !== own._id)) assert.equal(serialized.includes(id), false);
    for (const row of state.rows.Article) assert.equal(serialized.includes(row._id), false);
    assertReadOnly(state, before);
  });
}

function unprojectedQuery(value) {
  return {
    select() { return this; }, sort() { return this; }, skip() { return this; }, limit() { return this; },
    lean: async () => value,
  };
}

test('DTO allowlists protect nested and root metadata even if a query returns unprojected documents', async context => {
  const state = install(context);
  const row = draft({
    internalComments: [{ text: PRIVATE }], creatorEmail: PRIVATE, translationGroupId: PRIVATE,
    sourceArticleId: OTHER_ID, translationStatus: { hi: PRIVATE }, permissions: { internal: PRIVATE },
    workflowHistory: [{ notes: PRIVATE }], translationJobId: OTHER_ID, youthPulseSubmissionId: OTHER_ID,
    authorByline: { privateContact: PRIVATE }, sponsoredFeatureId: OTHER_ID, sponsorName: PRIVATE,
    coverImage: { url: '/uploads/cover.jpg', publicId: 'own-cover', alt: 'Own cover', internal: PRIVATE },
    seo: { metaTitle: 'Own SEO title', internal: PRIVATE, metaDescription: { private: PRIVATE } },
    location: { state: 'Gujarat', city: 'Ahmedabad', citySlug: 'ahmedabad', isUT: false, privateContact: PRIVATE, district: { internal: PRIVATE } },
    geo: { city: 'ahmedabad', internal: PRIVATE },
    tags: ['national', { internal: PRIVATE }], gallery: ['/uploads/gallery.jpg', { internal: PRIVATE }],
  });
  context.mock.method(News, 'find', () => unprojectedQuery([row]));
  context.mock.method(News, 'countDocuments', async () => 1);
  context.mock.method(News, 'findOne', () => unprojectedQuery(row));
  const { list, detail } = await listAndDetail(state);
  assert.equal(list.status, 200, list.text);
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(Object.keys(list.body.items[0]).sort(), [...LIST_KEYS].sort());
  assert.deepEqual(Object.keys(detail.body.article).sort(), [...DETAIL_KEYS].sort());
  assert.deepEqual(detail.body.article.tags, ['national']);
  assert.deepEqual(detail.body.article.gallery, ['/uploads/gallery.jpg']);
  assert.deepEqual(detail.body.article.seo, { metaTitle: 'Own SEO title' });
  assert.deepEqual(detail.body.article.location, { state: 'Gujarat', city: 'Ahmedabad', citySlug: 'ahmedabad', isUT: false });
  assert.deepEqual(detail.body.article.geo, { city: 'ahmedabad' });
  assert.equal(JSON.stringify([list.body, detail.body]).includes(PRIVATE), false);
  assert.equal(JSON.stringify([list.body, detail.body]).includes(OTHER_ID), false);
});

for (const [label, fields, expected] of [
  ['nested cover', { coverImage: { url: '/nested.jpg' }, coverImageUrl: '/legacy.jpg', imageURL: '/image.jpg' }, '/nested.jpg'],
  ['string cover', { coverImage: '/string.jpg', coverImageUrl: '/legacy.jpg' }, '/string.jpg'],
  ['legacy cover URL', { coverImage: null, coverImageUrl: '/legacy.jpg' }, '/legacy.jpg'],
  ['legacy image URL', { coverImage: null, coverImageUrl: null, imageURL: '/image.jpg' }, '/image.jpg'],
  ['absent cover', { coverImage: null, coverImageUrl: null, imageURL: null }, null],
]) {
  test(`own-draft DTO retains ${label} compatibility`, async context => {
    const state = install(context);
    state.rows.News.push(draft(fields));
    const { list, detail } = await listAndDetail(state);
    assert.equal(list.body.items[0].coverImageUrl, expected);
    assert.equal(detail.body.article.coverImageUrl, expected);
    assert.equal(detail.body.article.coverImage.url, expected);
  });
}

test('record-local language fallback does not select or synthesize another language', async context => {
  const state = install(context);
  state.rows.News.push(draft({ language: undefined, lang: 'gu', content: 'Stored Gujarati content' }));
  const { list, detail } = await listAndDetail(state);
  assert.equal(list.body.items[0].language, 'gu');
  assert.equal(detail.body.article.language, 'gu');
  assert.equal(detail.body.article.content, 'Stored Gujarati content');
  assert.equal(detail.body.article.translations, undefined);
});

for (const sort of ['-createdAt', '-updatedAt']) {
  test(`${sort} pagination counts only eligible owned records and resolves ties by descending ID`, async context => {
    const state = install(context);
    const ids = ['507f1f77bcf86cd79943a101', '507f1f77bcf86cd79943a102', '507f1f77bcf86cd79943a103'];
    state.rows.News.push(...ids.map(_id => draft({ _id })));
    state.rows.News.push(draft({ _id: ID, createdByUserId: actorId('editor') }), draft({ _id: OTHER_ID, status: 'published' }));
    const before = copy(state.rows);
    const first = await state.request('get', `${BASE}?page=1&limit=2&status=draft&sort=${sort}`, undefined, 'reporter');
    const second = await state.request('get', `${BASE}?page=2&pageSize=2&sort=${sort}`, undefined, 'reporter');
    const empty = await state.request('get', `${BASE}?page=3&limit=2&sort=${sort}`, undefined, 'reporter');
    assert.deepEqual(first.body.items.map(row => row._id), [ids[2], ids[1]]);
    assert.deepEqual(second.body.items.map(row => row._id), [ids[0]]);
    assert.deepEqual(empty.body.items, []);
    for (const response of [first, second, empty]) {
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.total, 3);
      assert.equal(response.body.pages, 2);
      assert.equal(response.body.limit, 2);
      assert.equal(response.body.sort, sort);
    }
    const finds = state.calls.filter(call => call.method === 'find');
    const counts = state.calls.filter(call => call.method === 'countDocuments');
    for (const [index, call] of finds.entries()) {
      assert.deepEqual(call.filter, counts[index].filter);
      assert.deepEqual(call.options, { strictQuery: false });
      assert.deepEqual(counts[index].options, { strictQuery: false });
    }
    assertReadOnly(state, before);
  });
}

test('pagination defaults, zero normalization, cap and zero-result pages are explicit', async context => {
  const state = install(context);
  for (let index = 1; index <= 105; index++) state.rows.News.push(draft({ _id: index.toString(16).padStart(24, '0') }));
  const capped = await state.request('get', `${BASE}?page=0&limit=999`, undefined, 'reporter');
  assert.equal(capped.status, 200, capped.text);
  assert.equal(capped.body.page, 1);
  assert.equal(capped.body.limit, 100);
  assert.equal(capped.body.items.length, 100);
  assert.equal(capped.body.total, 105);
  assert.equal(capped.body.pages, 2);
  const one = await state.request('get', `${BASE}?limit=0`, undefined, 'reporter');
  assert.equal(one.body.limit, 1);
  assert.equal(one.body.items.length, 1);
  const aliases = await state.request('get', `${BASE}?limit=3&pageSize=3`, undefined, 'reporter');
  assert.equal(aliases.body.limit, 3);
  state.rows.News.length = 0;
  const empty = await state.request('get', BASE, undefined, 'reporter');
  assert.equal(empty.body.total, 0);
  assert.equal(empty.body.pages, 0);
  assert.deepEqual(empty.body.items, []);
});

test('createdAt and updatedAt sorting use their respective timestamps before ID ties', async context => {
  const state = install(context);
  state.rows.News.push(
    draft({ createdAt: new Date('2023-01-01'), updatedAt: new Date('2025-01-01') }),
    draft({ _id: OTHER_ID, createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01') }),
  );
  const created = await state.request('get', `${BASE}?sort=-createdAt`, undefined, 'reporter');
  const updated = await state.request('get', `${BASE}?sort=-updatedAt`, undefined, 'reporter');
  assert.equal(created.status, 200, created.text);
  assert.equal(updated.status, 200, updated.text);
  assert.deepEqual(created.body.items.map(row => row._id), [OTHER_ID, ID]);
  assert.deepEqual(updated.body.items.map(row => row._id), [ID, OTHER_ID]);
});

for (const query of [
  'status=published', 'status=deleted', 'createdByUserId=foreign', 'translationGroupId=secret',
  'lang=hi', 'language=gu', 'includeDeleted=true', 'q=private', 'sort=title', 'sort=__proto__',
  'page=-1', 'page=1.5', 'page=1e2', 'page=abc', 'page=', 'page=9007199254740992',
  'page=9007199254740991&limit=100', 'page=2147483648&limit=2',
  'limit=-1', 'limit=1.2', 'limit=9007199254740992', 'limit=2&pageSize=3',
  'page[]=1', 'page[$gt]=0', 'limit[]=5', 'sort[]=createdAt', 'status[]=draft',
]) {
  test(`own-draft list rejects unsupported or malformed query ${query}`, async context => {
    const state = install(context);
    state.rows.News.push(draft());
    const response = await state.request('get', `${BASE}?${query}`, undefined, 'reporter');
    assert.equal(response.status, 400, response.text);
    assert.equal(response.body.code, 'INVALID_DRAFT_QUERY');
    assertPrivate(response);
    assert.deepEqual(state.calls, []);
  });
}

for (const query of ['lang=hi', 'language=gu', 'translationGroupId=secret', 'sourceArticleId=secret', 'page=1']) {
  test(`own-draft detail rejects query ${query} rather than loading siblings`, async context => {
    const state = install(context);
    const response = await state.request('get', `${BASE}/${ID}?${query}`, undefined, 'reporter');
    assert.equal(response.status, 400, response.text);
    assert.equal(response.body.code, 'INVALID_DRAFT_QUERY');
    assertPrivate(response);
    assert.deepEqual(state.calls, []);
  });
}

test('invalid, absent and public-copy IDs share a generic non-disclosing 404', async context => {
  const state = install(context);
  state.rows.Article.push(draft({ _id: OTHER_ID }));
  const before = copy(state.rows);
  const responses = [];
  for (const id of ['not-an-object-id', 'abcdefghijkl', ABSENT_ID, OTHER_ID]) {
    const response = await state.request('get', `${BASE}/${id}`, undefined, 'reporter');
    assert.equal(response.status, 404, response.text);
    assertPrivate(response);
    responses.push(response.body);
  }
  for (const body of responses) assert.deepEqual(body, responses[0]);
  assertReadOnly(state, before);
});

test('Mongoose casting retains typed owner filters, privacy predicates and workflow shape checks without executing queries', async context => {
  const state = install(context);
  state.rows.News.push(draft());
  for (const [method, realMethod] of [['find', mongooseFind], ['findOne', mongooseFindOne], ['countDocuments', mongooseCount]]) {
    const fixtureMethod = News[method];
    context.mock.method(News, method, (filter, ...args) => {
      const query = realMethod.call(News, filter, ...args);
      query.cast(News);
      const cast = query.getFilter();
      assert.ok(cast.createdByUserId.$eq instanceof mongoose.Types.ObjectId);
      assert.equal(cast.createdByUserId.$eq.toHexString(), actorId('reporter'));
      assert.deepEqual(cast.visibility, { $in: [null, 'public'], $not: { $type: 'array' } });
      assert.deepEqual(cast.isPrivate, { $in: [null, false], $not: { $type: 'array' } });
      assert.deepEqual(cast.workflow, { $not: { $type: 'array' } });
      assert.equal(query.getOptions().strictQuery, false);
      return fixtureMethod.call(News, filter, ...args);
    });
  }
  const { list, detail } = await listAndDetail(state);
  assert.equal(list.status, 200, list.text);
  assert.equal(detail.status, 200, detail.text);
  assert.equal(list.body.total, 1);
});

for (const method of ['find', 'countDocuments', 'findOne']) {
  for (const [name, status, code] of [['MongoNetworkError', 503, 'DB_UNAVAILABLE'], ['Error', 500, 'DRAFT_READ_FAILED']]) {
    test(`${method} ${name} is explicit, private and never an empty success`, async context => {
      const state = install(context);
      state.rows.News.push(draft());
      state.failures[`News.${method}`] = { name, message: PRIVATE };
      const before = copy(state.rows);
      const log = context.mock.method(console, 'error', () => {});
      const path = method === 'findOne' ? `${BASE}/${ID}` : BASE;
      const response = await state.request('get', path, undefined, 'reporter');
      assert.equal(response.status, status, response.text);
      assert.equal(response.body.code, code);
      assert.equal(response.body.ok, false);
      assert.equal(response.body.items, undefined);
      assert.equal(response.text.includes(PRIVATE), false);
      assertPrivate(response);
      assert.ok(log.mock.callCount() > 0);
      assert.equal(JSON.stringify(log.mock.calls.map(call => call.arguments)).includes(PRIVATE), false);
      assertReadOnly(state, before);
    });
  }
}

test('policy storage failure denies reads without content queries or initialization', async context => {
  const state = install(context);
  const before = copy(state.rows);
  context.mock.method(SiteSettings, 'findOne', () => ({
    lean: async () => { throw Object.assign(new Error(PRIVATE), { name: 'MongoServerSelectionError' }); },
  }));
  context.mock.method(console, 'error', () => {});
  const { list, detail } = await listAndDetail(state);
  for (const response of [list, detail]) {
    assert.equal(response.status, 503, response.text);
    assert.equal(response.body.code, 'DB_UNAVAILABLE');
    assert.equal(response.text.includes(PRIVATE), false);
  }
  assert.deepEqual(state.calls, []);
  assertReadOnly(state, before);
});

test('unavailable authentication storage fails closed before content queries', async context => {
  const state = install(context);
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 0;
  context.after(() => { mongoose.connection.readyState = previous; });
  const before = copy(state.rows);
  const { list, detail } = await listAndDetail(state);
  for (const response of [list, detail]) {
    assert.equal(response.status, 503, response.text);
    assert.equal(response.body.code, 'AUTH_UNAVAILABLE');
  }
  assert.deepEqual(state.calls, []);
  assertReadOnly(state, before);
});

for (const prefix of PREFIXES) {
  test(`successful own read does not weaken full-CMS guards on ${prefix || 'root'}`, async context => {
    const state = install(context);
    state.rows.News.push(draft());
    const own = await state.request('get', `${prefix}/articles/own-drafts/${ID}`, undefined, 'reporter');
    assert.equal(own.status, 200, own.text);
    for (const path of [`${prefix}/articles?status=draft`, `${prefix}/articles/${ID}`, `${prefix}/articles/${ID}/translation-status`]) {
      const response = await state.request('get', path, undefined, 'reporter');
      assert.equal(response.status, 403, response.text);
    }
    assert.equal(state.calls.filter(call => ['News', 'Article', 'TranslationJob'].includes(call.name) && WRITES.has(call.method)).length, 0);
    assert.deepEqual(state.invalidations, []);
  });
}

for (const role of ['founder', 'editor']) {
  test(`${role} retains existing broader CMS list and detail access`, async context => {
    const state = install(context, { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_edit'] });
    state.rows.News.push(draft(), draft({ _id: OTHER_ID, createdByUserId: actorId('legal') }));
    const list = await state.request('get', '/api/articles?status=draft', undefined, role);
    const detail = await state.request('get', `/api/articles/${OTHER_ID}`, undefined, role);
    assert.equal(list.status, 200, list.text);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.article._id, OTHER_ID);
    assert.deepEqual(detail.body.article, detail.body.data.article);
  });
}

test('public article detail cannot return private draft data after adding own-draft reads', async context => {
  const state = install(context);
  state.rows.News.push(draft({ title: PRIVATE, content: PRIVATE }));
  const before = copy(state.rows);
  const response = await state.request('get', `/api/articles/${ID}`, undefined, null);
  assert.equal(response.status, 404, response.text);
  assert.equal(response.text.includes(PRIVATE), false);
  assert.deepEqual(copy(state.rows), before);
  assert.deepEqual(state.invalidations, []);
});

test('reopening a draft leaves account rights unchanged and still rejects protected saves and publishing', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
  Object.assign(state.rows.News[0], {
    status: 'draft', publishedAt: null, workflowStage: 'DRAFT', createdByUserId: actorId('reporter'),
  });
  const before = copy(state.rows);
  const request = state.request('get', `${BASE}/${ids[0]}`, undefined, 'reporter');
  const accountBefore = copy(await User.findById(actorId('reporter')).lean());
  const read = await request;
  assert.equal(read.status, 200, read.text);
  assert.deepEqual(copy(await User.findById(actorId('reporter')).lean()), accountBefore);
  assert.deepEqual(state.accountUpdates, []);
  assertReadOnly(state, before);
  const save = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Forbidden indirect change' }, 'reporter');
  assert.equal(save.status, 403, save.text);
  assert.equal(save.body.code, 'ARTICLE_SAVE_FORBIDDEN');
  const publish = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'reporter');
  assert.equal(publish.status, 403, publish.text);
  for (const name of ['News', 'Article', 'TranslationJob', 'PublicConfigVersion', 'YouthPulseSubmission', 'YouthPulseContributor']) {
    assert.deepEqual(copy(state.rows[name]), before[name]);
    assert.equal(state.calls.filter(call => call.name === name && WRITES.has(call.method)).length, 0);
  }
  assert.deepEqual(state.invalidations, []);
});
