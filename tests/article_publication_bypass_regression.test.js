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
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const { generateArticleTranslations } = require('../services/articleTranslationGeneration.service');
const { publishDueScheduledArticles } = require('../services/scheduledPublication.service');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');

const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin', '/api/api', '/api/api/admin'];
const LEGACY = ['/api/news', '/api/news/news', '/api/api/news', '/api/api/news/news'];
const GENERATORS = [
  ...PREFIXES.map(prefix => id => `${prefix}/articles/${id}/translations/generate`),
  ...['/api/admin/news', '/admin-api/admin/news', '/admin-api/api/admin/news']
    .map(prefix => id => `${prefix}/${id}/generate-translations`),
];
const EDITOR = { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_edit'] };
const DRAFTER = { moduleAccessStates: { addNews: 'enabled', draftDesk: 'enabled' } };
const PUBLISH_GRANT = {
  moduleAccessStates: { manageNews: 'enabled', addNews: 'enabled', draftDesk: 'enabled' },
  specialRightsOverride: ['news_edit', 'news_publish', 'news_schedule'],
};
const CONTENT_MODELS = ['News', 'Article', 'TranslationJob', 'PublicConfigVersion', 'YouthPulseSubmission', 'YouthPulseContributor'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const copy = value => JSON.parse(JSON.stringify(value));
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const scheduledAt = '2099-01-01T00:00:00.000Z';
const draft = {
  title: 'Synthetic new story', description: 'Synthetic new summary', content: '<p>Synthetic new body</p>',
  slug: 'synthetic-new-story', category: 'business', language: 'en', status: 'draft',
};

function install(context, access = EDITOR) {
  const state = installEditorialFixture(context);
  state.access = copy(access);
  state.policy = { adminModulePolicy: { modulePolicies: {
    manageNews: 'available', addNews: 'available', draftDesk: 'available',
  } } };
  const findUser = User.findById;
  context.mock.method(User, 'findById', (...args) => {
    const query = findUser(...args);
    const lean = query.lean.bind(query);
    query.lean = async () => {
      const user = await lean();
      return user ? { ...user, specialRightsConfigured: true, specialRightsOverride: [], ...copy(state.access) } : null;
    };
    return query;
  });
  context.mock.method(Role, 'findOne', () => ({ lean: async () => null }));
  context.mock.method(Role, 'findById', () => ({ lean: async () => null }));
  context.mock.method(SiteSettings, 'findOne', () => ({ lean: async () => state.policy }));
  context.mock.method(SiteSettings, 'create', () => assert.fail('Authorization must not initialize module policy'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('Authorization must not change module policy'));
  state.publicSettings = context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  state.translate = context.mock.method(google, 'translateText', async (text, _from, to) => ({ ok: true, text: `${to} ${text}` }));
  const db = mongoose.connection.db;
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  mongoose.connection.db = {};
  process.env.GOOGLE_TRANSLATE_API_KEY = 'synthetic-translation-key';
  context.after(() => {
    mongoose.connection.db = db;
    if (apiKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = apiKey;
  });
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(key => [key, copy(state.rows[key])]));
  return state;
}

function ownedDraft(state, { siblings = true, role = 'reporter', copies = false } = {}) {
  const { ids } = seedGroup(state, { status: 'draft', copies });
  if (!siblings) state.rows.News.splice(1);
  for (const doc of state.rows.News) doc.createdByUserId = actorId(role);
  return ids;
}

function assertUnchanged(state, before) {
  assert.deepEqual(state.content(), before);
  assert.equal(state.invalidations.length, 0);
}

function assertDenied(state, before, response, status = 403) {
  assert.equal(response.status, status, response.text);
  assertUnchanged(state, before);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
  assert.equal(state.translate.mock.callCount(), 0);
}

function assertSingleTransaction(state) {
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].committed, true);
  for (const call of state.calls.filter(call => ['News', 'Article', 'TranslationJob'].includes(call.name) && WRITES.has(call.method))) {
    assert.equal(call.options?.session, state.transactions[0], `${call.name}.${call.method} escaped the transaction`);
  }
}

for (const [index, prefix] of PREFIXES.entries()) {
  for (const language of ['en', 'hi', 'gu', 'all']) {
    test(`${prefix}/articles retry ${language} cannot promote linked drafts as staff`, async context => {
      const state = install(context, PUBLISH_GRANT);
      const { ids } = seedGroup(state);
      for (const doc of state.rows.News.slice(1)) {
        doc.status = 'draft';
        doc.workflowStage = 'DRAFT';
        doc.publishedAt = null;
        doc.createdByUserId = actorId('editor');
      }
      state.rows.TranslationJob.push({ _id: '707f1f77bcf86cd79943c001', type: 'news-publish-translate', newsId: ids[0], status: 'failed' });
      const before = state.content();
      const response = await state.request('post', `${prefix}/articles/${ids[index % 3]}/retry-translation?lang=${language}`, {
        trusted: true, source: 'scheduler', actor: { byRole: 'SYSTEM' }, role: 'founder', isFounder: true,
      }, 'editor');
      assertDenied(state, before, response);
    });
  }
  for (const action of ['create', 'schedule', 'put', 'patch']) {
    test(`${prefix}/articles ${action} denies publication-capable scheduling to staff`, async context => {
      const state = install(context, PUBLISH_GRANT);
      const { ids } = seedGroup(state, { status: 'draft' });
      const method = ['put', 'patch'].includes(action) ? action : 'post';
      const path = action === 'create' ? `${prefix}/articles`
        : `${prefix}/articles/${ids[index % 3]}${action === 'schedule' ? '/schedule' : ''}`;
      const body = action === 'create' ? { ...draft, status: 'scheduled', scheduledAt } : { status: 'scheduled', scheduledAt };
      assertDenied(state, state.content(), await state.request(method, path, body, ['admin', 'editor', 'reporter'][index % 3]));
    });
  }
}

for (const path of GENERATORS) {
  test(`generator ${path(':id')} cannot overwrite reviewed live translations as staff`, async context => {
    const state = install(context, PUBLISH_GRANT);
    const { ids } = seedGroup(state);
    state.rows.News.slice(1).forEach(doc => { doc.humanEdited = true; doc.translationReviewStatus = 'reviewed'; });
    const body = { targetLanguages: ['hi', 'gu'], overwrite: true, confirmOverwriteHumanEdited: true, founderConfirmed: true };
    assertDenied(state, state.content(), await state.request('post', path(ids[0]), body, 'admin'));
  });
  test(`generator ${path(':id')} keeps Founder human-overwrite confirmation and publication dates`, async context => {
    const state = install(context);
    const { ids, publication } = seedGroup(state);
    state.rows.News.slice(1).forEach(doc => { doc.humanEdited = true; doc.translationReviewStatus = 'reviewed'; });
    const response = await state.request('post', path(ids[0]), {
      targetLanguages: ['hi', 'gu'], overwrite: true, confirmOverwriteHumanEdited: true,
    });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(Object.keys(response.body.updated).sort(), ['gu', 'hi']);
    assert.deepEqual(state.rows.News.map(doc => String(doc._id)), ids);
    assert.equal(state.rows.Article.length, 3);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      assert.equal(doc.status, 'published');
      assert.equal(new Date(doc.publishedAt).getTime(), publication.getTime());
    }
    assertSingleTransaction(state);
  });
}

for (const [label, access] of [
  ['role preset without configured rights', { specialRightsConfigured: false }],
  ['module-only access', { moduleAccessStates: { manageNews: 'enabled' } }],
  ['configured-empty rights despite legacy aliases', { moduleAccessStates: { manageNews: 'enabled' }, permissions: ['news_edit', 'news_publish'] }],
  ['edit right without module access', { specialRightsOverride: ['news_edit'] }],
  ['temporary edit denial', { ...EDITOR, temporaryAccess: [{ rightKey: 'news_edit', enabled: false, expiresAt: '2099-01-01' }] }],
  ['temporary module denial', { ...EDITOR, temporaryAccess: [{ moduleKey: 'manage_news', enabled: false, expiresAt: '2099-01-01' }] }],
]) {
  for (const operation of ['retry-translation', 'translations/generate']) {
    test(`${operation} applies ${label} to the complete draft scope`, async context => {
      const state = install(context, access);
      const { ids } = seedGroup(state, { status: 'draft', copies: false });
      assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/${operation}`, {
        targetLanguages: ['hi', 'gu'], overwrite: true,
      }, 'reporter'));
    });
  }
}

for (const operation of ['retry-translation', 'translations/generate']) {
  for (const restriction of ['global module policy', 'Safe Zone lock', 'foreign GU owner', 'unknown HI owner', 'scheduled GU sibling', 'published HI sibling', 'locked GU sibling', 'protected public copy']) {
    test(`${operation} fails closed for ${restriction} before all writes`, async context => {
      const state = install(context, DRAFTER);
      const ids = ownedDraft(state, { copies: restriction === 'protected public copy' });
      if (restriction === 'global module policy') {
        state.policy.adminModulePolicy.modulePolicies = { addNews: 'staff_locked', draftDesk: 'staff_locked' };
      }
      if (restriction === 'Safe Zone lock') {
        process.env.SAFE_ZONE_MASTER_LOCK = 'true';
        context.after(() => { delete process.env.SAFE_ZONE_MASTER_LOCK; });
      }
      if (restriction === 'foreign GU owner') state.rows.News[2].createdByUserId = actorId('admin');
      if (restriction === 'unknown HI owner') delete state.rows.News[1].createdByUserId;
      if (restriction === 'scheduled GU sibling') state.rows.News[2].scheduledAt = scheduledAt;
      if (restriction === 'published HI sibling') state.rows.News[1].status = 'published';
      if (restriction === 'locked GU sibling') state.rows.News[2].workflow = { locked: true };
      if (restriction === 'protected public copy') state.rows.Article[2].status = 'published';
      assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/${operation}`, {
        targetLanguages: ['hi', 'gu'], overwrite: true,
      }, 'reporter'));
    });
  }
}

for (const [label, access, role] of [
  ['owned Draft Desk', DRAFTER, 'reporter'],
  ['Editor', EDITOR, 'editor'],
  ['temporary edit grant', {
    moduleAccessStates: { manageNews: 'enabled' },
    temporaryAccess: [{ rightKey: 'news_edit', enabled: true, expiresAt: '2099-01-01' }],
  }, 'editor'],
]) {
  test(`${label} preserves legitimate draft generation and creator identity`, async context => {
    const state = install(context, access);
    const ids = ownedDraft(state, { siblings: false, role });
    const response = await state.request('post', `/api/articles/${ids[0]}/translations/generate`, {}, role);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(Object.keys(response.body.created).sort(), ['gu', 'hi']);
    assert.equal(state.rows.News.length, 3);
    for (const doc of state.rows.News) {
      assert.equal(doc.status, 'draft');
      assert.equal(doc.publishedAt, null);
      assert.equal(String(doc.createdByUserId), actorId(role));
      assert.equal(String(doc.sourceArticleId), ids[0]);
    }
    assert.equal(state.rows.Article.length, 0);
    assert.ok(state.publicSettings.mock.callCount() > 0);
    assert.ok(state.publicSettings.mock.calls.every(call => call.arguments[0]?.readOnly === true));
    assertSingleTransaction(state);
  });
  test(`${label} preserves atomic draft retry without publishing GU/HI/EN`, async context => {
    const state = install(context, access);
    const ids = ownedDraft(state, { role });
    const response = await state.request('post', `/api/articles/${ids[0]}/retry-translation?lang=all`, {}, role);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.message, 'Translation retry queued');
    assert.equal(state.rows.TranslationJob.length, 1);
    assert.equal(state.rows.TranslationJob[0].type, 'news-publish-translate');
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'draft' && !doc.publishedAt));
    assertSingleTransaction(state);
  });
}

for (const path of [...PREFIXES.map(prefix => `${prefix}/articles`), ...LEGACY]) {
  for (const link of ['group', 'source']) {
    test(`create ${path} rejects staff ${link} linkage into a live story`, async context => {
      const state = install(context, PUBLISH_GRANT);
      const { ids } = seedGroup(state);
      state.rows.News.splice(1);
      state.rows.Article.splice(1);
      const body = {
        ...draft, language: 'hi',
        ...(link === 'group' ? { translationGroupId: 'story-test-group' } : { sourceArticleId: ids[0] }),
      };
      assertDenied(state, state.content(), await state.request('post', path, body, 'editor'));
    });
  }
}

for (const path of ['/api/articles', '/api/news']) {
  test(`create ${path} rejects an orphaned live public-copy group`, async context => {
    const state = install(context, PUBLISH_GRANT);
    seedGroup(state);
    state.rows.News = [];
    assertDenied(state, state.content(), await state.request('post', path, {
      ...draft, translationGroupId: 'story-test-group',
    }, 'editor'));
  });
  test(`create ${path} permits scoped own-draft linkage without publication`, async context => {
    const state = install(context, DRAFTER);
    const ids = ownedDraft(state, { siblings: false });
    if (path === '/api/news') context.mock.method(models.News.prototype, 'save', async function (options) {
      await this.validate();
      return (await models.News.create([this.toObject()], options))[0];
    });
    const response = await state.request('post', path, {
      ...draft, language: 'hi', translationGroupId: 'story-test-group', sourceArticleId: ids[0],
    }, 'reporter');
    assert.equal(response.status, 201, response.text);
    assert.equal(state.rows.News.length, 2);
    assert.ok(state.rows.News.every(doc => doc.status === 'draft' && !doc.publishedAt));
  });
}

for (const action of ['next', 'set']) {
  test(`workflow ${action} cannot initiate automatic publishing as staff`, async context => {
    const state = install(context, PUBLISH_GRANT);
    const { ids } = seedGroup(state, { status: 'draft' });
    state.rows.News[2].workflowStage = 'founder_approval';
    const body = { action, toStage: 'scheduled', scheduledAt };
    assertDenied(state, state.content(), await state.request('patch',
      `/api/admin/workflow/articles/${ids[2]}/stage`, body, action === 'next' ? 'editor' : 'admin'));
  });
}

for (const prefix of ['/api/articles', '/api/admin/drafts']) {
  for (const language of ['en', 'hi', 'gu']) {
    test(`restore ${prefix} via ${language} cannot re-arm a scheduled GU edition as staff`, async context => {
      const state = install(context, PUBLISH_GRANT);
      const { ids } = seedGroup(state, { status: 'deleted' });
      state.rows.News.forEach(doc => {
        doc.deletedAt = new Date('2026-01-01');
        doc.deletedFromStatus = doc.language === 'gu' ? 'scheduled' : 'draft';
        doc.scheduledAt = doc.language === 'gu' ? scheduledAt : null;
      });
      const id = ids[['en', 'hi', 'gu'].indexOf(language)];
      assertDenied(state, state.content(), await state.request('post', `${prefix}/${id}/restore`, {}, 'editor'));
    });
  }
}

test('restore recognizes scheduled provenance in legacy workflow history', async context => {
  const state = install(context, PUBLISH_GRANT);
  const { ids } = seedGroup(state, { status: 'deleted' });
  for (const doc of state.rows.News) {
    doc.deletedAt = new Date('2026-01-01');
    doc.workflowHistory = [{ fromStage: 'SCHEDULED', toStage: 'REJECTED', action: 'REJECT' }];
    doc.scheduledAt = scheduledAt;
  }
  assertDenied(state, state.content(), await state.request('post', `/api/articles/${ids[0]}/restore`, {}, 'admin'));
});

for (const status of ['scheduled', 'published']) {
  test(`staff generation cannot join a ${status} source even without human-overwrite confirmation`, async context => {
    const state = install(context, PUBLISH_GRANT);
    const { ids } = seedGroup(state, { status });
    state.rows.News.splice(1);
    assertDenied(state, state.content(), await state.request('post',
      `/api/articles/${ids[0]}/translations/generate`, { targetLanguages: ['hi', 'gu'] }, 'editor'));
  });
}

test('Founder retry may synchronize authorized published GU/HI/EN and queues only on commit', async context => {
  const state = install(context);
  const { ids, publication } = seedGroup(state);
  const originalIds = state.rows.Article.map(doc => doc._id);
  const response = await state.request('post', `/api/articles/${ids[0]}/retry-translation?lang=en`, {});
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(state.rows.Article.map(doc => doc._id), originalIds);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc =>
    doc.status === 'published' && new Date(doc.publishedAt).getTime() === publication.getTime()));
  assert.equal(state.rows.TranslationJob.length, 1);
  assert.equal(state.invalidations.length, 1);
  assertSingleTransaction(state);
});

for (const operation of ['retry-translation', 'translations/generate']) {
  test(`${operation} rechecks persisted account eligibility inside the transaction`, async context => {
    const state = install(context, DRAFTER);
    const ids = ownedDraft(state);
    const startSession = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      state.access.loginAllowed = false;
      return startSession();
    });
    assertDenied(state, state.content(), await state.request('post',
      `/api/articles/${ids[0]}/${operation}`, { targetLanguages: ['hi'], overwrite: true }, 'reporter'));
  });
}

for (const operation of ['create', 'schedule', 'workflow', 'restore']) {
  test(`${operation} rechecks Founder eligibility before any protected write`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state, { status: operation === 'restore' ? 'deleted' : 'draft' });
    if (operation === 'restore') state.rows.News.forEach(doc => {
      doc.deletedAt = new Date('2026-01-01');
      doc.deletedFromStatus = 'scheduled';
      doc.scheduledAt = scheduledAt;
    });
    const startSession = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      state.access.tokenVersion = 1;
      return startSession();
    });
    const path = operation === 'create' ? '/api/articles'
      : operation === 'workflow' ? `/api/admin/workflow/articles/${ids[0]}/stage`
        : `/api/articles/${ids[0]}/${operation}`;
    const body = operation === 'create' ? { ...draft, status: 'scheduled', scheduledAt }
      : { action: 'set', toStage: 'scheduled', scheduledAt };
    assertDenied(state, state.content(), await state.request(operation === 'workflow' ? 'patch' : 'post', path, body));
  });
}

for (const actor of ['editor', 'founder']) {
  test(`atomic generation rolls back earlier languages and jobs after ${actor} authority is revoked`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state, { status: actor === 'founder' ? 'published' : 'draft' });
    const before = state.content();
    context.mock.method(google, 'translateText', async (text, _from, to) => {
      if (to === 'gu') state.access.loginAllowed = false;
      return { ok: true, text: `${to} ${text}` };
    });
    const response = await state.request('post', `/api/articles/${ids[0]}/translations/generate`, {
      targetLanguages: ['hi', 'gu'], overwrite: true,
    }, actor);
    assert.equal(response.status, 403, response.text);
    assert.equal(response.body.committed, undefined);
    assertUnchanged(state, before);
    assert.equal(state.transactions.length, 1);
    assert.equal(state.transactions[0].aborted, true);
  });
}

test('provider failure rolls back every requested translation and queue change', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
  const before = state.content();
  context.mock.method(google, 'translateText', async (text, _from, to) =>
    to === 'gu' ? { ok: false, error: 'Synthetic provider failure' } : { ok: true, text: `${to} ${text}` });
  const response = await state.request('post', `/api/articles/${ids[0]}/translations/generate`, {
    targetLanguages: ['hi', 'gu'], overwrite: true,
  });
  assert.equal(response.status, 502, response.text);
  assert.equal(response.body.code, 'TRANSLATION_GENERATION_FAILED');
  assert.deepEqual(response.body.translationResult.updated, {});
  assert.deepEqual(response.body.translationResult.created, {});
  assert.equal(response.body.translationResult.jobId, null);
  assertUnchanged(state, before);
});

test('retry queue failure rolls back readiness, public copies and group synchronization', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
  const before = state.content();
  state.failures['TranslationJob.findOneAndUpdate'] = { once: true };
  const response = await state.request('post', `/api/articles/${ids[0]}/retry-translation?lang=en`, {});
  assert.equal(response.status, 503, response.text);
  assert.equal(response.body.code, 'TRANSLATION_QUEUE_FAILED');
  assertUnchanged(state, before);
  assert.equal(state.transactions[0].aborted, true);
});

for (const index of [0, 2]) {
  test(`retry of ${index === 0 ? 'source' : 'GU sibling'} reports post-commit revalidation failure without claiming rollback`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    context.mock.method(global, 'fetch', async () => ({ ok: false, status: 503 }));
    const response = await state.request('post', `/api/articles/${ids[index]}/retry-translation?lang=en`, {});
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.committed, true);
    assert.equal(response.body.revalidation.ok, false);
    assert.equal(state.rows.TranslationJob.length, 1);
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'published'));
    assertSingleTransaction(state);
  });
}

for (const operation of ['schedule', 'retry-translation', 'translations/generate']) {
  test(`${operation} reauthorizes a transaction retry without leaking committed effects`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    const before = state.content();
    const startSession = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      const session = await startSession();
      const transact = session.withTransaction.bind(session);
      session.withTransaction = async work => {
        await assert.rejects(transact(async () => {
          await work();
          throw new Error('Synthetic transaction retry');
        }), /Synthetic transaction retry/);
        state.access.tokenVersion = 1;
        return transact(work);
      };
      return session;
    });
    const response = await state.request('post', `/api/articles/${ids[0]}/${operation}`, {
      scheduledAt, targetLanguages: ['hi', 'gu'], overwrite: true,
    });
    assert.equal(response.status, 403, response.text);
    assertUnchanged(state, before);
  });
}

test('trusted internal generation retains its explicit partial-commit contract', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
  const update = models.News.findOneAndUpdate;
  context.mock.method(models.News, 'findOneAndUpdate', (filter, patch, options) => {
    if (patch.$set?.language === 'gu') throw Object.assign(new Error('Synthetic later edition failure'), { statusCode: 503 });
    return update(filter, patch, options);
  });
  await assert.rejects(generateArticleTranslations(state.newsDoc(ids[0]), {
    targetLanguages: ['hi', 'gu'], overwrite: true,
  }), error => {
    assert.equal(error.statusCode, 503);
    assert.equal(error.details.committed, true);
    assert.deepEqual(Object.keys(error.details.translationResult.updated), ['hi']);
    return true;
  });
  assert.equal(state.rows.News[1].title, 'hi en headline');
  assert.equal(state.rows.News[2].title, 'gu headline');
  assert.equal(state.rows.TranslationJob[0].status, 'failed');
});

test('trusted async translation preserves published identities, dates and human-reviewed GU content', async context => {
  const state = install(context);
  const { ids, publication } = seedGroup(state);
  const publicIds = state.rows.Article.map(doc => doc._id);
  state.rows.News[2].humanEdited = true;
  state.rows.News[2].content = '<p>Human-reviewed Gujarati edition</p>';
  state.access = { loginAllowed: false, specialRightsOverride: [] };
  const translator = require('../services/googleTranslate.service');
  context.mock.method(translator, 'translateMany', async (values, target) => ({
    ok: true, items: values.map(value => `${target === 'gu' ? '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0' : '\u0939\u093f\u0902\u0926\u0940'} ${value}`),
  }));
  const { translateAndSave } = require('../services/publishAsyncTranslation.service');
  await translateAndSave(ids[0]);
  assert.deepEqual(state.rows.News.map(doc => doc._id), ids);
  assert.deepEqual(state.rows.Article.map(doc => doc._id), publicIds);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc =>
    doc.status === 'published' && new Date(doc.publishedAt).getTime() === publication.getTime()));
  assert.equal(state.rows.News[2].content, '<p>Human-reviewed Gujarati edition</p>');
  assert.equal(state.rows.Article.find(doc => doc.sourceNewsId === ids[2]).content, state.rows.News[2].content);
});

for (const path of [GENERATORS[1], GENERATORS[PREFIXES.length]]) {
  test(`generator ${path(':id')} preserves human-reviewed translations without Founder confirmation`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    state.rows.News.slice(1).forEach(doc => { doc.humanEdited = true; doc.translationReviewStatus = 'reviewed'; });
    const original = copy(state.rows.News.map(doc => ({
      _id: doc._id, content: doc.content, publishedAt: doc.publishedAt, humanEdited: doc.humanEdited,
    })));
    const response = await state.request('post', path(ids[0]), { targetLanguages: ['hi', 'gu'], overwrite: true });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.skipped.hi.reason, 'human_edited');
    assert.equal(response.body.skipped.gu.reason, 'human_edited');
    assert.deepEqual(copy(state.rows.News.map(doc => ({
      _id: doc._id, content: doc.content, publishedAt: doc.publishedAt, humanEdited: doc.humanEdited,
    }))), original);
    assert.equal(state.translate.mock.callCount(), 0);
    assertSingleTransaction(state);
  });
}

for (const operation of ['retry-translation', 'translations/generate']) {
  test(`${operation} rechecks the entire draft group on a transaction retry`, async context => {
    const state = install(context, DRAFTER);
    const ids = ownedDraft(state);
    let expected;
    const startSession = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      const session = await startSession();
      const transact = session.withTransaction.bind(session);
      session.withTransaction = async work => {
        await assert.rejects(transact(async () => {
          await work();
          throw new Error('Synthetic transaction retry');
        }), /Synthetic transaction retry/);
        state.rows.News[2].createdByUserId = actorId('admin');
        expected = state.content();
        return transact(work);
      };
      return session;
    });
    const response = await state.request('post', `/api/articles/${ids[0]}/${operation}`, {
      targetLanguages: ['hi', 'gu'], overwrite: true,
    }, 'reporter');
    assert.equal(response.status, 403, response.text);
    assertUnchanged(state, expected);
  });
}

test('scheduling reloads sibling state on retry and cannot re-arm a deleted edition', async context => {
  const state = install(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  let expected;
  const startSession = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await startSession();
    const transact = session.withTransaction.bind(session);
    session.withTransaction = async work => {
      await assert.rejects(transact(async () => {
        await work();
        throw new Error('Synthetic transaction retry');
      }), /Synthetic transaction retry/);
      state.rows.News[2].status = 'deleted';
      state.rows.News[2].deletedAt = new Date();
      expected = state.content();
      return transact(work);
    };
    return session;
  });
  const response = await state.request('post', `/api/articles/${ids[0]}/schedule`, { scheduledAt });
  assert.equal(response.status, 409, response.text);
  assertUnchanged(state, expected);
});

for (const path of LEGACY) {
  test(`legacy ${path} preserves verified Founder scheduled creation`, async context => {
    const state = install(context, {});
    context.mock.method(models.News.prototype, 'save', async function (options) {
      await this.validate();
      return (await models.News.create([this.toObject()], options))[0];
    });
    const response = await state.request('post', path, { ...draft, status: 'scheduled', scheduledAt });
    assert.equal(response.status, 201, response.text);
    assert.deepEqual(response.body, { message: 'News created successfully' });
    assert.equal(state.rows.News.length, 1);
    assert.equal(state.rows.News[0].status, 'scheduled');
    assert.equal(String(state.rows.News[0].createdByUserId), actorId('founder'));
    assertSingleTransaction(state);
  });
}

test('a draft retry cannot overwrite publication chronology through source inheritance', async context => {
  const state = install(context, DRAFTER);
  const ids = ownedDraft(state);
  state.rows.News[0].publishedAt = new Date('2025-01-01');
  const before = state.content();
  const response = await state.request('post', `/api/articles/${ids[0]}/retry-translation?lang=en`, {}, 'reporter');
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.code, 'ARTICLE_SAVE_SCOPE_CHANGED');
  assertUnchanged(state, before);
});

for (const operation of ['create', 'schedule', 'workflow', 'restore']) {
  test(`Founder ${operation} retains scheduling authority without staff rights or modules`, async context => {
    const state = install(context, {});
    state.policy.adminModulePolicy.modulePolicies = { manageNews: 'staff_locked' };
    const { ids } = seedGroup(state, { status: operation === 'restore' ? 'deleted' : 'draft' });
    if (operation === 'restore') state.rows.News.forEach(doc => {
      doc.deletedAt = new Date('2026-01-01');
      doc.deletedFromStatus = 'scheduled';
      doc.scheduledAt = scheduledAt;
    });
    const path = operation === 'create' ? '/api/articles'
      : operation === 'workflow' ? `/api/admin/workflow/articles/${ids[1]}/stage`
        : `/api/articles/${ids[1]}/${operation}`;
    const body = operation === 'create' ? { ...draft, status: 'scheduled', scheduledAt }
      : { action: 'set', toStage: 'scheduled', scheduledAt };
    const response = await state.request(operation === 'workflow' ? 'patch' : 'post', path, body);
    assert.equal(response.status, operation === 'create' ? 201 : 200, response.text);
    assert.equal(response.body.postCommitWarnings, undefined, response.text);
    const changed = operation === 'create' ? state.rows.News.filter(doc => doc.slug === draft.slug) : state.rows.News;
    assert.ok(changed.length);
    assert.ok(changed.every(doc => doc.status === 'scheduled' && new Date(doc.scheduledAt).toISOString() === scheduledAt));
    if (operation !== 'create') assert.deepEqual(state.rows.News.map(doc => doc._id), ids);
  });
}

test('trusted scheduler still publishes an authorized group once without a staff permission or request actor', async context => {
  const state = install(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  const publicIds = state.rows.Article.map(doc => doc._id);
  const response = await state.request('post', `/api/articles/${ids[0]}/schedule`, { scheduledAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(response.status, 200, response.text);
  state.access = { loginAllowed: false, accountStatus: 'suspended', specialRightsOverride: [] };
  const now = new Date('2026-12-01T00:00:00.000Z');
  const actors = [];
  const result = await publishDueScheduledArticles({
    now,
    publishCanonicalArticle: async (doc, options) => {
      actors.push(options.actor);
      assert.equal(options.req, undefined);
      assert.equal(options.source, 'scheduler');
      return publishCanonicalArticle(doc, options);
    },
  });
  assert.deepEqual(result, { processed: 3, published: 1, failed: 0, skipped: 2 });
  assert.deepEqual(actors, [{ byUserId: null, byRole: 'SYSTEM' }]);
  assert.deepEqual(state.rows.News.map(doc => doc._id), ids);
  assert.deepEqual(state.rows.Article.map(doc => doc._id), publicIds);
  assert.ok([...state.rows.News, ...state.rows.Article].every(doc =>
    doc.status === 'published' && new Date(doc.publishedAt).getTime() === now.getTime()));
});
