require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const google = require('../services/googleTranslationService');
const { installEditorialFixture, seedGroup, matches, models } = require('./helpers/editorialLifecycleFixture');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');
const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
const { hasRecordedNewsPublishGrant } = require('../lib/newsPublishGrant');

const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin', '/api/api', '/api/api/admin'];
const LEGACY = ['/api/news', '/api/news/news', '/api/api/news', '/api/api/news/news'];
const CONTENT_MODELS = ['News', 'Article', 'TranslationJob', 'PublicConfigVersion', 'YouthPulseSubmission', 'YouthPulseContributor'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const copy = value => JSON.parse(JSON.stringify(value));
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const future = () => new Date(Date.now() + 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
const rightsPath = role => `/api/admin/team/access/staff/${actorId(role)}/rights`;
const temporaryPath = role => `/api/admin/team/access/staff/${actorId(role)}/temporary`;
const newStory = {
  title: 'Synthetic publication story', description: 'Synthetic publication summary',
  content: '<p>Synthetic publication body</p>', slug: 'synthetic-publication-story', category: 'business', language: 'en',
};

function install(context) {
  const state = installEditorialFixture(context);
  state.accounts = new Map(['founder', 'editor', 'reporter', 'admin'].map(role => [actorId(role), {
    _id: actorId(role), email: `${role}@example.invalid`, name: `Synthetic ${role}`, role,
    isFounder: role === 'founder', status: 'active', accountStatus: 'active', tokenVersion: 0, accessVersion: 0,
    specialRightsConfigured: true, specialRightsOverride: role === 'reporter' ? [] : ['news_edit'],
    moduleAccessStates: role === 'reporter'
      ? { manageNews: 'disabled', addNews: 'enabled', draftDesk: 'enabled' }
      : { manageNews: 'enabled', addNews: 'disabled', draftDesk: 'disabled' },
  }]));
  state.user = role => state.accounts.get(actorId(role));
  state.userWrites = [];
  const query = resolve => ({
    select() { return this; }, session() { return this; },
    lean: async () => { const value = resolve(); return value ? copy(value) : null; },
    then(onValue, onError) {
      return Promise.resolve().then(() => {
        const value = resolve();
        return value ? User.hydrate(copy(value)) : null;
      }).then(onValue, onError);
    },
  });
  context.mock.method(User, 'findById', id => query(() => state.accounts.get(String(id))));
  context.mock.method(User, 'findOne', filter => query(() => [...state.accounts.values()].find(user => matches(user, filter))));
  const updateUser = (id, update) => {
    const user = state.accounts.get(String(id));
    if (!user) return null;
    state.userWrites.push(copy(update));
    Object.assign(user, copy(update.$set || {}));
    for (const [field, increment] of Object.entries(update.$inc || {})) user[field] = (user[field] || 0) + increment;
    for (const [field, entry] of Object.entries(update.$push || {})) user[field] = [...(user[field] || []), copy(entry)];
    for (const [field, condition] of Object.entries(update.$pull || {})) {
      user[field] = (user[field] || []).filter(entry => !matches(entry, condition));
    }
    return user;
  };
  context.mock.method(User, 'findByIdAndUpdate', (id, update) => query(() => updateUser(id, update)));
  context.mock.method(User, 'findOneAndUpdate', (filter, update) => query(() => {
    const user = [...state.accounts.values()].find(item => matches(item, filter));
    return user ? updateUser(user._id, update) : null;
  }));
  context.mock.method(Role, 'findOne', () => query(() => null));
  context.mock.method(Role, 'findById', () => query(() => null));
  state.policy = { adminModulePolicy: { modulePolicies: {
    manageNews: 'available', addNews: 'available', draftDesk: 'available',
  } } };
  context.mock.method(SiteSettings, 'findOne', () => ({
    lean: async () => state.policy,
    then(resolve, reject) { return Promise.resolve(state.policy).then(resolve, reject); },
  }));
  context.mock.method(SiteSettings, 'create', () => assert.fail('Publication must not initialize module policy'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('Publication must not change module policy'));
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  state.translate = context.mock.method(google, 'translateText', async (text, _from, to) => {
    const translated = { en: 'Synthetic English translation', hi: 'हिंदी परीक्षण अनुवाद', gu: 'ગુજરાતી પરીક્ષણ અનુવાદ' }[to];
    return { ok: true, text: String(text).includes('<') ? `<p>${translated}</p>` : translated };
  });
  const db = mongoose.connection.db;
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  mongoose.connection.db = { collection: () => ({}) };
  process.env.GOOGLE_TRANSLATE_API_KEY = 'synthetic-translation-key';
  context.after(() => {
    mongoose.connection.db = db;
    if (apiKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = apiKey;
  });
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(key => [key, copy(state.rows[key])]));
  state.writes = () => state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method));
  state.grant = async (role = 'editor', rights = ['news_edit', 'news_publish']) => {
    const response = await state.request('patch', rightsPath(role), { rights, auditReason: 'Synthetic Founder publication review' });
    assert.equal(response.status, 200, response.text);
    return response;
  };
  state.temporary = async (role, payload = {}) => {
    const response = await state.request('post', temporaryPath(role), {
      rightKey: 'news_publish', enabled: true, expiresAt: future(), auditReason: 'Synthetic temporary publication review', ...payload,
    });
    assert.equal(response.status, 201, response.text);
    return response;
  };
  state.seed = ({ role = 'editor', ...options } = {}) => {
    const group = seedGroup(state, { status: 'draft', ...options });
    for (const doc of state.rows.News) doc.createdByUserId = actorId(role);
    if (options.status === 'published') {
      group.publication = new Date(past());
      for (const doc of [...state.rows.News, ...state.rows.Article]) doc.publishedAt = group.publication;
    }
    return group;
  };
  return state;
}

function assertDenied(state, before, response, status = 403) {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(state.content(), before);
  assert.equal(state.writes().length, 0, 'Denied operations must not attempt protected writes');
  assert.equal(state.translate.mock.callCount(), 0, 'Denied operations must not prepare translations');
  assert.equal(state.invalidations.length, 0);
}

function assertPublished(state, response, ids) {
  assert.equal(response.status, ids === null ? 201 : 200, response.text);
  assert.deepEqual(state.rows.News.map(doc => doc.language).sort(), ['en', 'gu', 'hi']);
  assert.ok(state.rows.News.every(doc => doc.status === 'published' && doc.publishedAt));
  assert.deepEqual(state.rows.Article.map(doc => doc.language).sort(), ['en', 'gu', 'hi']);
  assert.ok(state.rows.Article.every(doc => doc.status === 'published' && doc.publishedAt));
  if (ids) assert.deepEqual(state.rows.News.map(doc => String(doc._id)), ids);
  assert.equal(state.transactions.length, 1);
  assert.ok(state.transactions[0].committed && state.transactions[0].ended);
  for (const call of state.writes()) {
    if (call.name === 'PublicConfigVersion') continue;
    assert.equal(call.options?.session, state.transactions[0], `${call.name}.${call.method} escaped the transaction`);
  }
}

test('Founder grant produces usable publication authority without widening Staff Access', async context => {
  const state = install(context);
  const beforeModules = copy(state.user('reporter').moduleAccessStates);
  const { ids } = state.seed({ role: 'reporter' });
  const grant = await state.grant('reporter', ['news_publish']);
  assert.deepEqual(state.user('reporter').moduleAccessStates, beforeModules);
  assert.deepEqual(state.user('reporter').specialRightsOverride, ['news_publish']);
  assert.equal(state.userWrites.length, 1);
  assert.equal(state.user('reporter').accessVersion, 1);
  assert.equal(state.user('reporter').newsPublishGrant.grantedBy, actorId('founder'));
  assert.equal(grant.body.data.effectiveAccess.newsPublishGrantRecorded, true);
  const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'reporter');
  assertPublished(state, response, ids);
});

test('temporary Founder publication works with an intentionally empty permanent selection', async context => {
  const state = install(context);
  const { ids } = state.seed({ role: 'reporter' });
  await state.grant('reporter', []);
  await state.temporary('reporter', { grantedBy: actorId('admin') });
  const entry = state.user('reporter').temporaryAccess[0];
  assert.equal(entry.grantedBy, actorId('founder'));
  assert.equal(entry.newsPublishGrant.grantedBy, actorId('founder'));
  assert.equal(entry.newsPublishGrant.temporaryAccessId, entry._id);
  assert.equal(entry.newsPublishGrant.expiresAt, entry.expiresAt);
  assert.equal(hasRecordedNewsPublishGrant(state.user('reporter')), true);
  assertPublished(state, await state.request('post', `/api/articles/${ids[2]}/publish-group`, {}, 'reporter'), ids);
});

for (const prefix of PREFIXES) {
  for (const action of ['publish', 'publish-group', 'publish-all-languages', 'put', 'patch', 'create']) {
    for (const allowed of [true, false]) {
      test(`${allowed ? 'authorized' : 'missing-grant'} publication ${prefix || '/'} ${action}`, async context => {
        const state = install(context);
        const { ids } = action === 'create' ? { ids: null } : state.seed();
        if (allowed) await state.grant();
        const method = ['put', 'patch'].includes(action) ? action : 'post';
        const path = action === 'create' ? `${prefix}/articles`
          : `${prefix}/articles/${ids[0]}${method === 'post' ? `/${action}` : ''}`;
        const body = action === 'create' ? { ...newStory, status: 'published' }
          : method === 'post' ? { reason: 'Synthetic explicit publication' } : { status: 'published', title: 'Updated authorized title' };
        const before = state.content();
        const response = await state.request(method, path, body, 'editor');
        if (!allowed) assertDenied(state, before, response);
        else assertPublished(state, response, ids);
      });
    }
  }
}

for (const scenario of [
  'missing right', 'unverified historical right', 'preset only', 'configured empty', 'revoked',
  'legacy marker', 'foreign subject', 'non-Founder issuer', 'missing issuer', 'future proof', 'wrong source',
  'module denial', 'global module denial', 'missing edit scope', 'temporary denial',
  'temporary module denial', 'safe zone',
]) {
  test(`publication denies ${scenario} before its first mutation`, async context => {
    const state = install(context);
    const { ids } = state.seed();
    await state.grant();
    const user = state.user('editor');
    if (scenario === 'missing right') user.specialRightsOverride = ['news_edit'];
    if (scenario === 'unverified historical right') delete user.newsPublishGrant;
    if (scenario === 'preset only') {
      delete user.specialRightsConfigured;
      delete user.newsPublishGrant;
      user.specialRightsOverride = [];
    }
    if (scenario === 'configured empty') user.specialRightsOverride = [];
    if (scenario === 'revoked') await state.grant('editor', ['news_edit']);
    if (scenario === 'legacy marker') user.specialRightsConfigured = false;
    if (scenario === 'foreign subject') user.newsPublishGrant.subjectUserId = actorId('reporter');
    if (scenario === 'non-Founder issuer') user.newsPublishGrant.grantedBy = actorId('admin');
    if (scenario === 'missing issuer') user.newsPublishGrant.grantedBy = '707f1f77bcf86cd79943c000';
    if (scenario === 'future proof') user.newsPublishGrant.grantedAt = future();
    if (scenario === 'wrong source') user.newsPublishGrant.source = 'staff-created';
    if (scenario === 'module denial') user.moduleAccessStates.manageNews = 'disabled';
    if (scenario === 'global module denial') state.policy.adminModulePolicy.modulePolicies.manageNews = 'staff_locked';
    if (scenario === 'missing edit scope') user.specialRightsOverride = ['news_publish'];
    if (scenario === 'temporary denial') await state.temporary('editor', { enabled: false });
    if (scenario === 'temporary module denial') await state.temporary('editor', { rightKey: undefined, moduleKey: 'manageNews', enabled: false });
    if (scenario === 'safe zone') {
      process.env.SAFE_ZONE_MASTER_LOCK = 'true';
      context.after(() => { delete process.env.SAFE_ZONE_MASTER_LOCK; });
    }
    assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/publish`, {
      grantedBy: actorId('founder'), trusted: true, actor: { byRole: 'SYSTEM' }, role: 'founder', isFounder: true,
    }, 'editor'));
  });
}

for (const restriction of [
  { accountStatus: 'suspended' }, { accountStatus: 'locked' }, { accountStatus: 'expired' },
  { accountStatus: 'archived' }, { accountStatus: 'deleted' }, { status: 'suspended' },
  { loginAllowed: false }, { isDeleted: true }, { deletedAt: past() },
  { lockedUntil: future() }, { accessExpiresAt: past() },
]) {
  test(`restricted publication account ${JSON.stringify(restriction)}`, async context => {
    const state = install(context);
    const { ids } = state.seed();
    await state.grant();
    Object.assign(state.user('editor'), restriction);
    const before = state.content();
    const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'editor');
    assert.ok([401, 403].includes(response.status), response.text);
    assertDenied(state, before, response, response.status);
  });
}

for (const scenario of ['expired', 'removed', 'old unverified', 'copied entry', 'extended expiry', 'changed issuer']) {
  test(`temporary publication grant rejects ${scenario}`, async context => {
    const state = install(context);
    const { ids } = state.seed({ role: 'reporter' });
    await state.temporary('reporter');
    const entry = state.user('reporter').temporaryAccess[0];
    if (scenario === 'expired') entry.expiresAt = past();
    if (scenario === 'removed') {
      const response = await state.request('delete', `${temporaryPath('reporter')}/${entry._id}`, {});
      assert.equal(response.status, 200, response.text);
    }
    if (scenario === 'old unverified') delete entry.newsPublishGrant;
    if (scenario === 'copied entry') entry._id = '707f1f77bcf86cd79943c001';
    if (scenario === 'extended expiry') entry.expiresAt = new Date(Date.now() + 2 * 86400000).toISOString();
    if (scenario === 'changed issuer') entry.grantedBy = actorId('admin');
    assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'reporter'));
  });
}

for (const language of [0, 1, 2]) {
  for (const protection of ['foreign owner', 'missing owner', 'locked', 'workflow lock', 'embargo', 'private', 'Founder approval', 'scheduled', 'scheduled stage', 'deleted', 'foreign public copy', 'unowned public copy', 'group-only public copy']) {
    test(`limited staff cannot publish protected edition ${language}: ${protection}`, async context => {
      const state = install(context);
      const { ids } = state.seed({ role: 'reporter' });
      await state.grant('reporter', ['news_publish']);
      const doc = state.rows.News[language];
      if (protection === 'foreign owner') doc.createdByUserId = actorId('admin');
      if (protection === 'missing owner') delete doc.createdByUserId;
      if (protection === 'locked') doc.locked = true;
      if (protection === 'workflow lock') doc.workflow = { locked: true };
      if (protection === 'embargo') doc.embargoUntil = future();
      if (protection === 'private') doc.isPrivate = true;
      if (protection === 'Founder approval') doc.requiresFounderApproval = true;
      if (protection === 'scheduled') { doc.status = 'scheduled'; doc.scheduledAt = future(); }
      if (protection === 'scheduled stage') doc.workflowStage = 'SCHEDULED';
      if (protection === 'deleted') { doc.status = 'deleted'; doc.deletedAt = past(); }
      if (protection === 'foreign public copy') state.rows.Article[language].sourceNewsId = actorId('admin');
      if (protection === 'unowned public copy') delete state.rows.Article[language].sourceNewsId;
      if (protection === 'group-only public copy') state.rows.Article.push({
        _id: '707f1f77bcf86cd79943c002', translationGroupId: doc.translationGroupId,
        slug: 'unresolved-protected-copy', language: 'fr', status: 'draft', sourceNewsId: actorId('admin'),
      });
      assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/publish-all-languages`, {}, 'reporter'));
    });
  }
}

test('broader editorial access may publish an otherwise eligible non-owned group', async context => {
  const state = install(context);
  const { ids } = state.seed({ role: 'reporter' });
  await state.grant();
  assertPublished(state, await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'editor'), ids);
});

test('limited publication does not grant editing of another staff draft', async context => {
  const state = install(context);
  const { ids } = state.seed({ role: 'editor' });
  await state.grant('reporter', ['news_publish']);
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Not authorized' }, 'reporter'));
});

test('a Founder can still publish without recorded rights or module access during Safe Zone lock', async context => {
  const state = install(context);
  const { ids } = state.seed();
  state.user('founder').specialRightsOverride = [];
  state.user('founder').moduleAccessStates = { manageNews: 'disabled', addNews: 'disabled', draftDesk: 'disabled' };
  process.env.SAFE_ZONE_MASTER_LOCK = 'true';
  context.after(() => { delete process.env.SAFE_ZONE_MASTER_LOCK; });
  assertPublished(state, await state.request('post', `/api/articles/${ids[0]}/publish`, {}), ids);
});

test('request-shaped service calls cannot manufacture Founder identity', async context => {
  const state = install(context);
  const { ids } = state.seed();
  const before = state.content();
  await assert.rejects(() => publishCanonicalArticle(ids[0], {
    req: { admin: { role: 'founder', isFounder: true }, body: { trusted: true } },
  }), error => error.code === 'ARTICLE_PUBLISH_FORBIDDEN');
  assert.deepEqual(state.content(), before);
  assert.equal(state.writes().length, 0);
});

for (const suffix of ['/publish', '/publish-group']) {
  test(`missing editions are preflighted before provider or queue work for ${suffix}`, async context => {
    const state = install(context);
    const { ids } = state.seed({ role: 'reporter', copies: false });
    state.rows.News.splice(1, 1);
    state.rows.News[1].createdByUserId = actorId('admin');
    await state.grant('reporter', ['news_publish']);
    assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}${suffix}`, {}, 'reporter'));
  });
}

for (const mode of ['cached', 'generated']) {
  test(`authorized own-draft publication prepares ${mode} translations atomically`, async context => {
    const state = install(context);
    const { ids } = state.seed({ role: 'reporter', copies: false });
    state.rows.News.splice(1);
    if (mode === 'cached') state.rows.News[0].translations = {
      hi: { title: 'हिंदी परीक्षण', summary: 'हिंदी सारांश', content: '<p>हिंदी समाचार</p>', provider: 'manual' },
      gu: { title: 'ગુજરાતી પરીક્ષણ', summary: 'ગુજરાતી સારાંશ', content: '<p>ગુજરાતી સમાચાર</p>', provider: 'manual' },
    };
    await state.grant('reporter', ['news_publish']);
    assertPublished(state, await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'reporter'));
    assert.ok(state.rows.News.every(doc => String(doc.createdByUserId) === actorId('reporter')));
    assert.ok(state.rows.News.every(doc => doc.coverImageUrl === '/uploads/shared.jpg'));
    if (mode === 'cached') assert.equal(state.translate.mock.callCount(), 0);
    else assert.ok(state.translate.mock.callCount() > 0);
  });
}

for (const failure of ['translation', 'public synchronization']) {
  test(`authorized publication rolls back preparation after ${failure} failure`, async context => {
    const state = install(context);
    const { ids } = state.seed({ copies: false });
    state.rows.News.splice(1);
    await state.grant();
    const before = state.content();
    if (failure === 'translation') context.mock.method(google, 'translateText', async () => ({ ok: false, error: 'Synthetic translation failure' }));
    else state.failures['Article.findOneAndUpdate'] = { code: 91 };
    const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'editor');
    assert.ok(response.status >= 400, response.text);
    assert.deepEqual(state.content(), before);
    assert.equal(state.invalidations.length, 0);
    assert.ok(state.transactions[0].aborted);
  });
}

test('editorial republishing preserves identities, language media and original publication chronology', async context => {
  const state = install(context);
  const { ids, publication } = state.seed({ status: 'published' });
  const publicIds = state.rows.Article.map(doc => doc._id);
  state.rows.News[1].humanEdited = true;
  state.rows.News[1].translationReviewStatus = 'reviewed';
  const reviewed = state.rows.News[1].content;
  await state.grant();
  assertPublished(state, await state.request('post', `/api/articles/${ids[2]}/publish-group`, {}, 'editor'), ids);
  assert.deepEqual(state.rows.Article.map(doc => String(doc._id)), publicIds);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
  assert.equal(state.rows.News[1].content, reviewed);
  assert.equal(state.rows.PushHistory.length, 0);
  assert.equal(state.translate.mock.callCount(), 0);
});

test('staff publication preserves committed-save warnings after revalidation failure', async context => {
  const state = install(context);
  const { ids } = state.seed();
  await state.grant();
  context.mock.method(global, 'fetch', async () => ({ ok: false, status: 503, text: async () => 'Synthetic revalidation outage' }));
  const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.revalidation.ok, false);
  assert.ok(state.rows.News.every(doc => doc.status === 'published'));
});

for (const change of ['revoked right', 'revoked module', 'foreign sibling', 'protected public copy', 'revoked session', 'unverified issuer']) {
  test(`publication transaction retries recheck ${change} before further writes`, async context => {
    const state = install(context);
    const { ids } = state.seed({ role: 'reporter' });
    await state.grant('reporter', ['news_publish']);
    const startSession = mongoose.startSession;
    let beforeRetry;
    let retryCallIndex;
    context.mock.method(mongoose, 'startSession', async () => {
      const session = await startSession();
      const transact = session.withTransaction.bind(session);
      session.withTransaction = async work => {
        await assert.rejects(transact(async () => { await work(); throw new Error('Synthetic retry'); }), /Synthetic retry/);
        if (change === 'revoked right') state.user('reporter').specialRightsOverride = [];
        if (change === 'revoked module') state.user('reporter').moduleAccessStates = { addNews: 'disabled', draftDesk: 'disabled' };
        if (change === 'foreign sibling') state.rows.News[2].createdByUserId = actorId('admin');
        if (change === 'protected public copy') state.rows.Article[2].locked = true;
        if (change === 'revoked session') state.user('reporter').tokenVersion += 1;
        if (change === 'unverified issuer') Object.assign(state.user('founder'), { role: 'admin', isFounder: false });
        beforeRetry = state.content();
        retryCallIndex = state.calls.length;
        return transact(work);
      };
      return session;
    });
    const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'reporter');
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(state.content(), beforeRetry);
    assert.equal(state.calls.slice(retryCallIndex).filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
    assert.equal(state.invalidations.length, 0);
    assert.equal(state.rows.PushHistory.length, 0);
  });
}

test('workflow publication uses the same scoped authority without granting arbitrary workflow set', async context => {
  const state = install(context);
  const { ids } = state.seed({ role: 'reporter' });
  await state.grant('reporter', ['news_publish']);
  assertDenied(state, state.content(), await state.request('patch', `/api/admin/workflow/articles/${ids[0]}/stage`, {
    action: 'set', toStage: 'review',
  }, 'reporter'));
  assertPublished(state, await state.request('patch', `/api/admin/workflow/articles/${ids[0]}/stage`, {
    action: 'set', toStage: 'published',
  }, 'reporter'), ids);
});

for (const path of LEGACY) {
  for (const method of ['create', 'put', 'patch']) {
    test(`legacy publication ${path} ${method} remains closed to staff`, async context => {
      const state = install(context);
      const { ids } = state.seed();
      await state.grant();
      const endpoint = method === 'create' ? path : `${path}/${ids[0]}`;
      const body = method === 'create' ? { ...newStory, status: 'published' } : { status: 'published' };
      const before = state.content();
      const response = await state.request(method === 'create' ? 'post' : method, endpoint, body, 'editor');
      assertDenied(state, before, response, method !== 'create' && path.endsWith('/news/news') ? 404 : 403);
    });
  }
}

for (const operation of ['create', 'schedule', 'status', 'workflow', 'restore', 'retry translation', 'compatibility translation']) {
  test(`verified news_publish does not authorize ${operation} bypasses`, async context => {
    const state = install(context);
    const { ids } = state.seed();
    await state.grant('editor', ['news_edit', 'news_publish', 'news_schedule']);
    let method = 'post';
    let path = `/api/articles/${ids[0]}/schedule`;
    let body = { scheduledAt: future() };
    if (operation === 'create') { path = '/api/articles'; body = { ...newStory, status: 'scheduled', scheduledAt: future() }; }
    if (operation === 'status') { method = 'patch'; path = `/api/articles/${ids[0]}`; body = { status: 'scheduled', scheduledAt: future() }; }
    if (operation === 'workflow') {
      method = 'patch'; path = `/api/admin/workflow/articles/${ids[0]}/stage`; body = { action: 'set', toStage: 'scheduled', scheduledAt: future() };
    }
    if (operation === 'restore') {
      for (const doc of [...state.rows.News, ...state.rows.Article]) {
        doc.status = 'deleted'; doc.deletedAt = past(); doc.deletedFromStatus = 'scheduled'; doc.scheduledAt = future();
      }
      path = `/api/articles/${ids[0]}/restore`; body = { status: 'scheduled', scheduledAt: future() };
    }
    if (operation.includes('translation')) {
      for (const doc of [...state.rows.News, ...state.rows.Article]) {
        doc.status = 'published'; doc.publishedAt = past(); doc.humanEdited = true;
      }
      path = operation === 'retry translation' ? `/api/articles/${ids[0]}/retry-translation?lang=hi`
        : `/api/admin/news/${ids[0]}/generate-translations`;
      body = { targetLanguages: ['hi'], overwrite: true, confirmOverwriteHumanEdited: true };
    }
    assertDenied(state, state.content(), await state.request(method, path, body, 'editor'));
  });
}

test('trusted SYSTEM scheduled publishing does not need a staff grant', async context => {
  const state = install(context);
  state.seed({ copies: false });
  for (const doc of state.rows.News) { doc.status = 'scheduled'; doc.scheduledAt = new Date(past()); doc.publishAt = doc.scheduledAt; }
  const result = await publishDueScheduledArticles({ now: new Date() });
  assert.ok(state.rows.News.every(doc => doc.status === 'published'), JSON.stringify(result));
  assert.ok(state.rows.Article.every(doc => doc.status === 'published'));
  assert.ok(state.rows.News.every(doc => doc.scheduledAt === null && doc.publishAt === null));
});

for (const method of ['put', 'patch']) {
  for (const foreign of [false, true]) {
    test(`limited ${method} content-and-publication checks the complete own-draft group: foreign=${foreign}`, async context => {
      const state = install(context);
      const { ids } = state.seed({ role: 'reporter' });
      await state.grant('reporter', ['news_publish']);
      if (foreign) state.rows.News[2].createdByUserId = actorId('admin');
      const before = state.content();
      const response = await state.request(method, `/api/articles/${ids[0]}`, {
        title: 'Authorized own-draft publication title', status: 'published',
      }, 'reporter');
      if (foreign) assertDenied(state, before, response);
      else assertPublished(state, response, ids);
    });
  }
}

for (const foreign of [false, true]) {
  test(`create-and-publish preflights existing siblings before creation: foreign=${foreign}`, async context => {
    const state = install(context);
    const { ids } = state.seed({ role: 'reporter' });
    state.rows.News.splice(2);
    state.rows.Article.splice(2);
    if (foreign) state.rows.News[1].createdByUserId = actorId('admin');
    await state.grant('reporter', ['news_publish']);
    const before = state.content();
    const response = await state.request('post', '/api/articles', {
      ...newStory, status: 'published', title: 'ગુજરાતી પરીક્ષણ સમાચાર', language: 'gu', slug: 'new-gu-edition',
      translationGroupId: 'story-test-group', translationKey: 'story-test-group',
      sourceArticleId: ids[0], sourceLanguage: 'en',
    }, 'reporter');
    if (foreign) assertDenied(state, before, response);
    else assertPublished(state, response, null);
  });
}

for (const protection of ['Founder approval', 'private', 'unknown parent', 'cross-group linkage', 'foreign copy']) {
  test(`broader editorial publication still denies ${protection} before preparation`, async context => {
    const state = install(context);
    const { ids } = state.seed();
    await state.grant();
    if (protection === 'Founder approval') state.rows.News[1].requiresFounderApproval = true;
    if (protection === 'private') state.rows.News[1].visibility = 'private';
    if (protection === 'unknown parent') state.rows.News[1].sourceArticleId = actorId('admin');
    if (protection === 'cross-group linkage') state.rows.News[1].translationGroupId = 'different-group';
    if (protection === 'foreign copy') state.rows.Article[1].sourceNewsId = actorId('admin');
    assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, {
      status: 'published', title: 'Must not change protected group',
    }, 'editor'));
  });
}

test('legacy source-linked edition publication retains the existing shared group identity', async context => {
  const state = install(context);
  const { ids } = state.seed({ role: 'reporter' });
  delete state.rows.News[1].translationGroupId;
  delete state.rows.News[1].translationKey;
  await state.grant('reporter', ['news_publish']);
  assertPublished(state, await state.request('post', `/api/articles/${ids[1]}/publish`, {}, 'reporter'), ids);
  assert.ok(state.rows.News.every(doc => doc.translationGroupId === 'story-test-group' && doc.sourceArticleId === ids[0]));
});

test('combined publication preserves mixed-group chronology and language-specific media', async context => {
  const state = install(context);
  const { ids } = state.seed();
  const publication = new Date(past());
  for (const doc of [state.rows.News[1], state.rows.Article[1]]) {
    Object.assign(doc, {
      status: 'published', publishedAt: publication, workflowStage: 'PUBLISHED',
      coverImage: { url: '/uploads/hi-custom.jpg' }, coverImageUrl: '/uploads/hi-custom.jpg',
    });
  }
  await state.grant();
  const response = await state.request('patch', `/api/articles/${ids[0]}`, {
    status: 'published', category: 'business', coverImageUrl: '/uploads/updated-cover.jpg',
  }, 'editor');
  assertPublished(state, response, ids);
  assert.ok(state.rows.News.every(doc => doc.category === 'business'));
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
  assert.equal(state.rows.News[1].coverImageUrl, '/uploads/hi-custom.jpg');
  assert.ok(state.rows.News[2].coverImageUrl.endsWith('/uploads/updated-cover.jpg'));
});

for (const failure of [null, 'YouthPulseSubmission.save', 'YouthPulseContributor.findByIdAndUpdate']) {
  test(`publication preflights and binds real News hooks to the transaction: ${failure || 'success'}`, async context => {
    const state = install(context);
    state.realNewsDocuments = true;
    const { ids } = state.seed();
    const submissionId = '507f1f77bcf86cd799439073';
    const contributorId = '507f1f77bcf86cd799439074';
    Object.assign(state.rows.News[0], { sourceType: 'youth_pulse', youthPulseSubmissionId: submissionId });
    state.rows.YouthPulseSubmission.push({
      _id: submissionId, contributorId, status: 'draft_created', linkedDraftId: ids[0],
      createdAt: new Date(past()), linkedArticleId: null,
    });
    state.rows.YouthPulseContributor.push({ _id: contributorId, totalSubmissions: 1, totalPublished: 0 });
    context.mock.method(models.News.collection, 'updateOne', (...args) => models.News.updateOne(...args));
    context.mock.method(models.News.collection, 'findOne', (filter, options) => models.News.findOne(filter, null, options).lean());
    await state.grant();
    const before = state.content();
    if (failure) state.failures[failure] = { once: true };
    const response = await state.request('post', `/api/articles/${ids[0]}/publish`, {}, 'editor');
    const firstWrite = state.calls.findIndex(call => call.name === 'News' && WRITES.has(call.method));
    for (const name of ['YouthPulseSubmission', 'YouthPulseContributor']) {
      const preflight = state.calls.findIndex(call => call.name === name && call.method === 'findById');
      assert.ok(preflight >= 0 && preflight < firstWrite, `${name} must be preflighted before article writes`);
    }
    if (failure) {
      assert.ok([500, 503].includes(response.status), response.text);
      assert.deepEqual(state.content(), before);
      assert.equal(state.invalidations.length, 0);
    } else {
      assertPublished(state, response, ids);
      assert.ok(state.calls.some(call => call.name === 'YouthPulseSubmission' && call.method === 'save'));
      assert.ok(state.calls.some(call => call.name === 'YouthPulseSubmission' && call.method === 'aggregate'));
      assert.equal(state.rows.YouthPulseSubmission[0].status, 'published');
      assert.equal(state.rows.YouthPulseContributor[0].totalPublished, 1);
    }
  });
}
