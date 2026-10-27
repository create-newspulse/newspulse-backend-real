require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const News = require('../models/News');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const readPublicSettings = PublicSiteSettings.getOrCreate;
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin', '/api/api', '/api/api/admin'];
const LEGACY = ['/api/news', '/api/api/news'];
const EDITOR = { moduleAccessStates: { manageNews: 'enabled' }, specialRightsOverride: ['news_edit'] };
const DRAFTER = { moduleAccessStates: { addNews: 'enabled', draftDesk: 'enabled' }, specialRightsOverride: [] };
const POLICY = { adminModulePolicy: { modulePolicies: { manageNews: 'available', addNews: 'available', draftDesk: 'available' } } };
const MANAGE_NEWS_GRANT = { moduleKey: 'manage_news', enabled: true, expiresAt: '2099-01-01' };
const MANAGE_NEWS_DENIAL = { moduleKey: 'manageNews', enabled: false, expiresAt: '2099-01-02' };
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const copy = value => JSON.parse(JSON.stringify(value));
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const CONTENT_MODELS = ['News', 'Article', 'TranslationJob', 'PublicConfigVersion', 'YouthPulseSubmission', 'YouthPulseContributor'];
const TITLES = {
  en: 'Authorized synthetic headline',
  hi: '\u0939\u093f\u0902\u0926\u0940 \u0938\u092e\u093e\u091a\u093e\u0930 \u0938\u0902\u092a\u093e\u0926\u0928',
  gu: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0 \u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0 \u0ab8\u0a82\u0aaa\u0abe\u0aa6\u0aa8',
};

function install(context, access = EDITOR) {
  const state = installEditorialFixture(context);
  state.access = copy(access);
  state.policy = copy(POLICY);
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
  context.mock.method(SiteSettings, 'create', () => assert.fail('Save authorization must not initialize module policy'));
  context.mock.method(SiteSettings, 'findOneAndUpdate', () => assert.fail('Save authorization must not upgrade module policy'));
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  const db = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = db; });
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(key => [key, copy(state.rows[key])]));
  return state;
}

function ownedDraft(state, { siblings = false, role = 'reporter' } = {}) {
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  if (!siblings) state.rows.News.splice(1);
  for (const doc of state.rows.News) doc.createdByUserId = actorId(role);
  return ids[0];
}

function assertDenied(state, before, response) {
  assert.equal(response.status, 403, response.text);
  assert.equal(response.body.code, 'ARTICLE_SAVE_FORBIDDEN', response.text);
  assert.match(response.body.message || response.body.error, /authorized Editor or Founder/);
  assert.deepEqual(state.content(), before);
  assert.equal(state.invalidations.length, 0);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
}

for (const [index, prefix] of PREFIXES.entries()) for (const method of ['put', 'patch']) {
  test(`${method.toUpperCase()} ${prefix}/articles denies a module-only published edit before every content write`, async context => {
    const state = install(context, { moduleAccessStates: { manageNews: 'enabled' } });
    const { ids } = seedGroup(state);
    const before = state.content();
    const response = await state.request(method, `${prefix}/articles/${ids[0]}`, { title: 'Denied edit' }, 'editor');
    assertDenied(state, before, response);
  });
  test(`${method.toUpperCase()} ${prefix}/articles permits effective Editor ${['en', 'hi', 'gu'][index % 3]} group editing`, async context => {
    const state = install(context);
    const { ids, publication } = seedGroup(state);
    const language = ['en', 'hi', 'gu'][index % 3];
    const response = await state.request(method, `${prefix}/articles/${ids[index % 3]}`, {
      title: TITLES[language], tags: ['navratri-2026', 'authorized-edit'],
    }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.article, response.body.data.article);
    assert.equal(response.body.article.body, response.body.article.content);
    assert.equal(response.body.article.language, language);
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.tags.includes('authorized-edit')));
    assert.ok(state.rows.News.every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
    assert.equal(state.rows.Article.find(doc => String(doc.sourceNewsId) === ids[index % 3]).title, TITLES[language]);
    assert.equal(state.rows.TranslationJob.length, 1);
  });
}

for (const base of LEGACY) for (const method of ['put', 'patch']) {
  test(`${method.toUpperCase()} ${base} rejects unauthorized published edits`, async context => {
    const state = install(context, DRAFTER);
    const { ids } = seedGroup(state);
    assertDenied(state, state.content(), await state.request(method, `${base}/${ids[0]}`, { title: 'Denied' }, 'reporter'));
  });
  test(`${method.toUpperCase()} ${base} preserves the authorized legacy response`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    const response = await state.request(method, `${base}/${ids[1]}`, { title: TITLES.hi, lang: 'hi' }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body, { message: 'News updated successfully' });
    assert.equal(state.rows.News[1].title, TITLES.hi);
  });
}

for (const base of [...PREFIXES.map(prefix => `${prefix}/articles`), ...LEGACY]) {
  for (const method of ['put', 'patch']) for (const denialFirst of [false, true]) {
    test(`temporary module denial blocks ${method.toUpperCase()} ${base} (${denialFirst ? 'denial first' : 'grant first'})`, async context => {
      const state = install(context, {
        ...EDITOR, moduleAccessStates: { manageNews: 'disabled' },
        temporaryAccess: denialFirst ? [MANAGE_NEWS_DENIAL, MANAGE_NEWS_GRANT] : [MANAGE_NEWS_GRANT, MANAGE_NEWS_DENIAL],
      });
      const { ids } = seedGroup(state);
      assertDenied(state, state.content(), await state.request(method, `${base}/${ids[0]}`, { title: 'Denied temporary access' }, 'editor'));
    });
  }
}

for (const base of ['/api/articles', '/api/news']) for (const method of ['put', 'patch']) {
  for (const expiredDenial of [false, true]) {
    test(`temporary module grant permits ${method.toUpperCase()} ${base} with ${expiredDenial ? 'an expired denial' : 'no denial'}`, async context => {
      const state = install(context, {
        ...EDITOR, moduleAccessStates: { manageNews: 'disabled' },
        temporaryAccess: [
          ...(expiredDenial ? [{ ...MANAGE_NEWS_DENIAL, expiresAt: '2020-01-01' }] : []),
          MANAGE_NEWS_GRANT,
        ],
      });
      const { ids, publication } = seedGroup(state);
      const response = await state.request(method, `${base}/${ids[1]}`, { title: TITLES.hi }, 'editor');
      assert.equal(response.status, 200, response.text);
      assert.equal(state.rows.News[1].title, TITLES.hi);
      assert.ok(state.rows.News.every(doc => doc.status === 'published' && new Date(doc.publishedAt).getTime() === publication.getTime()));
      if (base === '/api/articles') {
        assert.equal(state.rows.Article.find(doc => String(doc.sourceNewsId) === ids[1]).title, TITLES.hi);
        assert.deepEqual(response.body.article, response.body.data.article);
        assert.equal(state.rows.TranslationJob.length, 1);
      } else {
        assert.deepEqual(response.body, { message: 'News updated successfully' });
      }
    });
  }
}

for (const base of ['/api/articles', '/api/news']) for (const moduleKey of ['addNews', 'draftDesk']) {
  for (const denied of [false, true]) {
    test(`temporary module ${moduleKey} ${denied ? 'denial blocks' : 'grant permits'} own draft saving through ${base}`, async context => {
      const state = install(context, {
        temporaryAccess: [
          MANAGE_NEWS_DENIAL, { ...MANAGE_NEWS_GRANT, moduleKey },
          ...(denied ? [{ ...MANAGE_NEWS_DENIAL, moduleKey }] : []),
        ],
      });
      const id = ownedDraft(state);
      const before = state.content();
      const response = await state.request('patch', `${base}/${id}`, { title: 'Temporary own-draft save', status: 'draft' }, 'reporter');
      if (denied) return assertDenied(state, before, response);
      assert.equal(response.status, 200, response.text);
      assert.equal(state.rows.News[0].title, 'Temporary own-draft save');
      assert.equal(state.rows.News[0].status, 'draft');
      assert.equal(state.rows.Article.length, 0);
    });
  }
}

for (const base of ['/api/articles', '/api/news']) {
  test(`temporary module denial does not revoke Founder editing through ${base}`, async context => {
    const state = install(context, { temporaryAccess: [MANAGE_NEWS_GRANT, MANAGE_NEWS_DENIAL] });
    const { ids } = seedGroup(state);
    const response = await state.request('patch', `${base}/${ids[0]}`, { title: 'Founder edit despite staff denial' }, 'founder');
    assert.equal(response.status, 200, response.text);
    assert.equal(state.rows.News[0].title, 'Founder edit despite staff denial');
  });
}

test('temporary module grant does not replace the required news_edit Special Right', async context => {
  const state = install(context, { temporaryAccess: [MANAGE_NEWS_GRANT] });
  const { ids } = seedGroup(state);
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Denied missing edit right' }, 'editor'));
});

test('temporary module denial appended after commit blocks enqueue without claiming rollback', async context => {
  const state = install(context, {
    ...EDITOR, moduleAccessStates: { manageNews: 'disabled' }, temporaryAccess: [MANAGE_NEWS_GRANT],
  });
  const { ids } = seedGroup(state);
  const start = mongoose.startSession;
  let attempts = 0;
  context.mock.method(mongoose, 'startSession', async () => {
    if (++attempts === 2) state.access.temporaryAccess.push(copy(MANAGE_NEWS_DENIAL));
    return start();
  });
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Committed before module denial' }, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.postCommitWarnings[0].code, 'ARTICLE_FOLLOW_UP_FAILED');
  assert.equal(state.rows.News[0].title, 'Committed before module denial');
  assert.equal(state.rows.Article[0].title, 'Committed before module denial');
  assert.equal(state.rows.TranslationJob.length, 0);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name)
    && WRITES.has(call.method) && call.options?.session === state.transactions[1]).length, 0);
});

for (const [label, access] of [
  ['right without module', { specialRightsOverride: ['news_edit'] }],
  ['configured empty with legacy publish/edit aliases', { moduleAccessStates: { manageNews: 'enabled' }, permissions: ['news_edit', 'news_publish'] }],
  ['expired temporary edit right', { moduleAccessStates: { manageNews: 'enabled' }, temporaryAccess: [{ rightKey: 'news_edit', expiresAt: '2020-01-01', enabled: true }] }],
  ['active temporary denial', { ...EDITOR, temporaryAccess: [{ rightKey: 'news_edit', expiresAt: '2099-01-01', enabled: false }] }],
]) {
  test(`Effective authorization rejects ${label}`, async context => {
    const state = install(context, access);
    const { ids } = seedGroup(state);
    assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Denied' }, 'editor'));
  });
}

test('active temporary news_edit grant authorizes an otherwise configured-empty Editor', async context => {
  const state = install(context, {
    moduleAccessStates: { manageNews: 'enabled' },
    temporaryAccess: [{ rightKey: 'news_edit', expiresAt: '2099-01-01', enabled: true }],
  });
  const { ids } = seedGroup(state);
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Temporary authorized edit' }, 'editor');
  assert.equal(response.status, 200, response.text);
});

for (const moduleKey of ['addNews', 'draftDesk']) for (const method of ['put', 'patch']) {
  test(`${moduleKey} permits ${method.toUpperCase()} of the reporter's isolated draft without news_edit`, async context => {
    const state = install(context, { moduleAccessStates: { [moduleKey]: 'enabled' } });
    const id = ownedDraft(state);
    const response = await state.request(method, `/api/articles/${id}`, { title: 'Own autosave', status: 'draft' }, 'reporter');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.article.status, 'draft');
    assert.equal(state.rows.News[0].title, 'Own autosave');
    assert.equal(state.rows.Article.length, 0);
    assert.equal(state.rows.TranslationJob.length, 1);
    assert.equal(state.rows.News[0].workflowStage, 'DRAFT');
    assert.deepEqual(state.rows.News[0].workflowHistory, []);
  });
}

test('a verified entirely owned draft group keeps all language synchronization', async context => {
  const state = install(context, DRAFTER);
  const id = ownedDraft(state, { siblings: true });
  const response = await state.request('patch', `/api/articles/${id}`, { tags: ['navratri-2026', 'own-group'] }, 'reporter');
  assert.equal(response.status, 200, response.text);
  assert.ok(state.rows.News.every(doc => doc.tags.includes('own-group') && doc.status === 'draft'));
});

for (const scenario of ['published-sibling', 'unknown-generated-sibling', 'other-creator', 'unknown-source', 'locked-draft', 'youth-linked', 'legacy-youth-linked']) {
  test(`limited draft save fails closed for ${scenario}`, async context => {
    const state = install(context, DRAFTER);
    const id = ownedDraft(state, { siblings: true });
    if (scenario === 'published-sibling') state.rows.News[1].status = 'published';
    if (scenario === 'unknown-generated-sibling') {
      state.rows.News[1].machineGenerated = true;
      delete state.rows.News[1].createdByUserId;
    }
    if (scenario === 'other-creator') state.rows.News[2].createdByUserId = actorId('editor');
    if (scenario === 'unknown-source') delete state.rows.News[0].createdByUserId;
    if (scenario === 'locked-draft') state.rows.News[0].locked = true;
    if (scenario.endsWith('youth-linked')) Object.assign(state.rows.News[0], {
      sourceType: scenario === 'youth-linked' ? 'youth_pulse' : ' Youth_Pulse ', youthPulseSubmissionId: '507f1f77bcf86cd799439073',
    });
    const before = state.content();
    const response = await state.request('patch', `/api/articles/${id}`, {
      title: 'Denied draft', createdByUserId: actorId('reporter'), byline: 'Reporter',
      taskId: '507f1f77bcf86cd799439074',
    }, 'reporter');
    assertDenied(state, before, response);
  });
}

test('Founder retains group editorial control despite empty stored rights and unknown creators', async context => {
  const state = install(context, {});
  const { ids } = seedGroup(state);
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Founder edit' });
  assert.equal(response.status, 200, response.text);
  assert.equal(state.rows.Article[0].title, 'Founder edit');
});

for (const base of ['/api/articles', '/api/news']) for (const body of [
  { status: 'published' }, { status: 'scheduled', scheduledAt: '2099-01-01' },
  { status: 'archived' }, { status: 'deleted' }, { publishedAt: '2020-01-01' },
  { publishAt: '2020-01-01' }, { workflow: { stage: 'published', locked: false } },
  { 'workflow.locked': false }, { sourceArticleId: actorId('founder') },
  { translationGroupId: 'foreign-group' },
]) {
  test(`${base} rejects body-driven ${Object.keys(body).join('/')} changes from an authorized content Editor`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state, { status: 'draft', copies: false });
    assertDenied(state, state.content(), await state.request('put', `${base}/${ids[0]}`, body, 'editor'));
  });
}

test('a public-only article cannot acquire the draft-owner exception', async context => {
  const state = install(context, DRAFTER);
  seedGroup(state);
  state.rows.News = [];
  delete state.rows.Article[0].sourceNewsId;
  const id = state.rows.Article[0]._id;
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${id}`, { title: 'Denied public-only edit' }, 'reporter'));
});

test('a global module lock and Safe Zone lock cannot be bypassed by the edit right', async context => {
  const state = install(context);
  state.policy = { adminModulePolicy: { version: 1, modulePolicies: { manageNews: 'staff_locked' } } };
  const { ids } = seedGroup(state);
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Denied global lock' }, 'editor'));
  state.policy = copy(POLICY);
  process.env.SAFE_ZONE_MASTER_LOCK = 'true';
  context.after(() => { delete process.env.SAFE_ZONE_MASTER_LOCK; });
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Denied Safe Zone' }, 'editor'));
});

test('publication between the initial read and transaction denies an entire own-draft save', async context => {
  const state = install(context, DRAFTER);
  const id = ownedDraft(state, { siblings: true });
  const start = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    state.rows.News[1].status = 'published';
    return start();
  });
  const before = state.content();
  before.News[1].status = 'published';
  assertDenied(state, before, await state.request('patch', `/api/articles/${id}`, { title: 'Denied race' }, 'reporter'));
});

test('an unexpected group member cannot be written after initial preflight', async context => {
  const state = install(context, DRAFTER);
  const id = ownedDraft(state);
  const before = state.content();
  const update = News.findByIdAndUpdate;
  let inserted = false;
  context.mock.method(News, 'findByIdAndUpdate', (...args) => {
    if (!inserted) {
      inserted = true;
      state.rows.News.push({
        ...copy(state.rows.News[0]), _id: '507f1f77bcf86cd799439079',
        status: 'published', createdByUserId: actorId('editor'),
      });
    }
    return update(...args);
  });
  const response = await state.request('patch', `/api/articles/${id}`, { tags: ['unauthorized-group-tag'] }, 'reporter');
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(state.content(), before);
  assert.equal(state.invalidations.length, 0);
});

test('transaction retries discard the old authorization and all queued follow-ups', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
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
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Rolled back retry' }, 'editor');
  assert.equal(response.status, 403, response.text);
  assert.deepEqual(state.content(), before);
  assert.equal(state.invalidations.length, 0);
});

for (const mode of ['revoked', 'enqueue-failure']) {
  test(`post-commit ${mode} keeps the committed-save warning and blocks unauthorized follow-up writes`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    if (mode === 'enqueue-failure') state.failures['TranslationJob.findOneAndUpdate'] = { once: true };
    const start = mongoose.startSession;
    let attempts = 0;
    context.mock.method(mongoose, 'startSession', async () => {
      attempts++;
      if (mode === 'revoked' && attempts === 2) state.access.specialRightsOverride = [];
      return start();
    });
    const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Committed edit' }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.committed, true);
    assert.equal(response.body.postCommitWarnings[0].code, 'ARTICLE_FOLLOW_UP_FAILED');
    assert.equal(state.rows.News[0].title, 'Committed edit');
    assert.equal(state.rows.Article[0].title, 'Committed edit');
    assert.equal(state.rows.TranslationJob.length, 0);
    assert.equal(state.rows.News[0].syncVersion, 2);
  });
}

for (const failure of [false, true]) {
  test(`Faith-topic save ${failure ? 'rolls source and siblings back on failure' : 'retains authorized group synchronization'}`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    const before = state.content();
    if (failure) state.failures['Article.findOneAndUpdate'] = { once: true };
    const response = await state.request('patch', `/api/articles/${ids[0]}`, { topic: 'living-heritage' }, 'editor');
    if (failure) {
      assert.equal(response.status, 503, response.text);
      assert.deepEqual(state.content(), before);
      assert.equal(state.invalidations.length, 0);
    } else {
      assert.equal(response.status, 200, response.text);
      assert.ok(state.rows.News.every(doc => doc.topic === 'living-heritage'));
      assert.ok(state.rows.Article.every(doc => doc.topic === 'living-heritage' || doc.topic === undefined));
    }
  });
}

for (const failure of [null, 'YouthPulseContributor.findByIdAndUpdate', 'Article.findOneAndUpdate']) {
  test(`real News save hook shares the article transaction with Youth Pulse (${failure || 'success'})`, async context => {
    const state = install(context);
    state.realNewsDocuments = true;
    const { ids } = seedGroup(state);
    const submissionId = '507f1f77bcf86cd799439073';
    const contributorId = '507f1f77bcf86cd799439074';
    Object.assign(state.rows.News[0], { sourceType: 'youth_pulse', youthPulseSubmissionId: submissionId });
    state.rows.YouthPulseSubmission.push({
      _id: submissionId, contributorId, status: 'draft_created', linkedDraftId: ids[0],
      createdAt: new Date('2026-01-01'), linkedArticleId: null,
    });
    state.rows.YouthPulseContributor.push({ _id: contributorId, totalSubmissions: 1, totalPublished: 0 });
    context.mock.method(News.collection, 'updateOne', (...args) => News.updateOne(...args));
    context.mock.method(News.collection, 'findOne', (filter, options) => News.findOne(filter, null, options).lean());
    const before = state.content();
    if (failure) state.failures[failure] = { once: true };
    const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Youth transaction edit' }, 'editor');
    const related = state.calls.filter(call => ['YouthPulseSubmission', 'YouthPulseContributor'].includes(call.name));
    const firstArticleWrite = state.calls.findIndex(call => call.name === 'News' && WRITES.has(call.method));
    assert.ok(state.calls.findIndex(call => call.name === 'YouthPulseSubmission' && call.method === 'findById') < firstArticleWrite);
    assert.ok(state.calls.findIndex(call => call.name === 'YouthPulseContributor' && call.method === 'findById') < firstArticleWrite);
    assert.ok(related.some(call => call.method === 'save'), 'The real News post-save hook must run');
    assert.ok(related.some(call => call.method === 'aggregate'), 'The real contributor statistics service must run');
    for (const call of related) {
      assert.ok(state.transactions.includes(call.options?.session));
      if (WRITES.has(call.method) || call.method === 'aggregate') assert.equal(call.options.session, state.transactions[0]);
    }
    if (failure) {
      assert.ok([500, 503].includes(response.status), response.text);
      assert.deepEqual(state.content(), before);
      assert.equal(state.invalidations.length, 0);
    } else {
      assert.equal(response.status, 200, response.text);
      assert.equal(state.rows.YouthPulseSubmission[0].status, 'published');
      assert.equal(String(state.rows.YouthPulseSubmission[0].linkedArticleId), ids[0]);
      assert.equal(state.rows.YouthPulseContributor[0].totalPublished, 1);
    }
  });
}

for (const sharedSlug of [false, true]) for (const [index, language] of ['en', 'hi', 'gu'].entries()) {
  test(`Editor edits a mixed ${language} draft/published group with ${sharedSlug ? 'shared' : 'separate'} public slugs`, async context => {
    const state = install(context);
    const { ids, publication } = seedGroup(state, { sharedSlug });
    Object.assign(state.rows.News[index], { status: 'draft', publishedAt: null, workflowStage: 'DRAFT' });
    if (!sharedSlug) state.rows.Article = state.rows.Article.filter(doc => String(doc.sourceNewsId) !== ids[index]);
    const response = await state.request('patch', `/api/articles/${ids[index]}`, {
      title: TITLES[language], tags: ['navratri-2026', 'mixed-group'],
    }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.equal(state.rows.News[index].status, 'draft');
    const publishedCopies = state.rows.Article.filter(doc => doc.status === 'published');
    assert.equal(publishedCopies.length, sharedSlug ? 1 : 2);
    for (const doc of publishedCopies) {
      assert.equal(new Date(doc.publishedAt).getTime(), publication.getTime());
      assert.notEqual(doc.title, TITLES[language]);
      assert.ok(doc.tags.includes('mixed-group'));
      assert.equal(doc.translationStatus[language], 'pending');
      assert.equal(doc.translations[language].content, null);
    }
  });
}

test('Editor Faith-topic synchronization preserves a mixed shared public copy', async context => {
  const state = install(context);
  const { ids } = seedGroup(state, { sharedSlug: true });
  Object.assign(state.rows.News[0], { status: 'draft', publishedAt: null, workflowStage: 'DRAFT' });
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { topic: 'living-heritage' }, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.ok(state.rows.News.every(doc => doc.topic === 'living-heritage'));
  assert.equal(state.rows.News[0].status, 'draft');
  assert.equal(state.rows.Article.length, 1);
  assert.equal(state.rows.Article[0].status, 'published');
  assert.equal(state.rows.Article[0].translationStatus.en, 'pending');
});

test('a limited verified isolated Faith draft can save its topic atomically', async context => {
  const state = install(context, DRAFTER);
  const id = ownedDraft(state);
  const response = await state.request('patch', `/api/articles/${id}`, { topic: 'living-heritage' }, 'reporter');
  assert.equal(response.status, 200, response.text);
  assert.equal(state.rows.News[0].topic, 'living-heritage');
  assert.ok(state.rows.Article.every(doc => doc.status === 'draft'));
});

test('a content save cannot remove an existing public visibility gate through synchronization', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
  state.rows.Article[1].locked = true;
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Denied gate removal' }, 'editor'));
});

test('Editor public-only content saves retain the existing envelope and status', async context => {
  const state = install(context);
  seedGroup(state);
  state.rows.News = [];
  delete state.rows.Article[0].sourceNewsId;
  const id = state.rows.Article[0]._id;
  const response = await state.request('patch', `/api/articles/${id}`, { title: 'Authorized public-only edit', status: 'published' }, 'editor');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.article.status, 'published');
  assert.equal(state.rows.Article[0].title, 'Authorized public-only edit');
});

for (const change of [
  { accountStatus: 'suspended' }, { accountStatus: 'locked' }, { loginAllowed: false },
  { accessExpiresAt: '2020-01-01' }, { tokenVersion: 1 }, { role: 'reporter' },
]) {
  test(`transaction rechecks authenticated account ${Object.keys(change)[0]} before writing`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    const start = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      Object.assign(state.access, change);
      return start();
    });
    assertDenied(state, state.content(), await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Denied changed account' }, 'editor'));
  });
}

for (const expiresAt of ['2020-01-01', '2099-01-01']) {
  test(`temporary Manage News grant uses its effective expiry (${expiresAt})`, async context => {
    const state = install(context, {
      specialRightsOverride: ['news_edit'],
      temporaryAccess: [{ moduleKey: 'manageNews', enabled: true, expiresAt }],
    });
    const { ids } = seedGroup(state);
    const before = state.content();
    const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Temporary module edit' }, 'editor');
    if (expiresAt === '2020-01-01') assertDenied(state, before, response);
    else assert.equal(response.status, 200, response.text);
  });
}

test('unconfigured rights retain the existing Editor preset without granting module access', async context => {
  const state = install(context, { specialRightsConfigured: false, moduleAccessStates: { manageNews: 'enabled' } });
  context.mock.method(Role, 'findOne', () => ({ lean: async () => ({ specialRights: ['news_edit'] }) }));
  const { ids } = seedGroup(state);
  const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Legacy configured-module edit' }, 'editor');
  assert.equal(response.status, 200, response.text);
});

for (const settings of [null, { published: { languageTheme: { languages: ['en', 'hi', 'gu'] } } }]) {
  test(`authorized enqueue reads ${settings ? 'legacy' : 'absent'} public settings without creation or backfills`, async context => {
    const state = install(context);
    const { ids } = seedGroup(state);
    context.mock.method(PublicSiteSettings, 'getOrCreate', readPublicSettings);
    const reads = [];
    context.mock.method(PublicSiteSettings, 'findOne', (_filter, _projection, options) => {
      reads.push(options);
      return { sort() { return this; }, lean: async () => settings };
    });
    context.mock.method(PublicSiteSettings, 'create', () => assert.fail('Unexpected settings initialization'));
    context.mock.method(PublicSiteSettings.prototype, 'save', () => assert.fail('Unexpected settings backfill'));
    const before = copy(settings);
    const response = await state.request('patch', `/api/articles/${ids[0]}`, { title: 'Read-only settings enqueue' }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.equal(state.rows.TranslationJob.length, 1);
    assert.deepEqual(settings, before);
    assert.equal(reads.length, 1);
    assert.equal(reads[0].session, state.transactions[1]);
  });
}

test('ordinary autosave can resubmit computed fields without writing them or changing its verified creator', async context => {
  const state = install(context, DRAFTER);
  const id = ownedDraft(state);
  const first = await state.request('patch', `/api/articles/${id}`, { title: 'First save', status: 'draft' }, 'reporter');
  assert.equal(first.status, 200, first.text);
  assert.notEqual(first.body.article.syncVersion, state.rows.News[0].syncVersion);
  const response = await state.request('put', `/api/articles/${id}`, {
    title: 'Next autosave', status: 'draft',
    syncVersion: first.body.article.syncVersion, updatedAt: first.body.article.updatedAt,
    contentFingerprint: 'client-computed-value', createdByUserId: actorId('founder'),
  }, 'reporter');
  assert.equal(response.status, 200, response.text);
  assert.equal(state.rows.News[0].createdByUserId, actorId('reporter'));
  assert.notEqual(state.rows.News[0].contentFingerprint, 'client-computed-value');
  assert.equal(state.rows.News[0].title, 'Next autosave');
});

test('standalone scoped metadata synchronization authorizes before its source-version write', async context => {
  const state = install(context);
  const { ids } = seedGroup(state);
  const before = state.content();
  const { syncTranslationGroupMetadata } = require('../services/translationGroupSync.service');
  const { saveDenied } = require('../services/articleSaveAccess.service');
  await assert.rejects(syncTranslationGroupMetadata(state.newsDoc(ids[0]), {
    patch: { tags: ['denied'] }, authorizeSave: async () => { throw saveDenied(); },
  }), { code: 'ARTICLE_SAVE_FORBIDDEN' });
  assert.deepEqual(state.content(), before);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method)).length, 0);
  assert.equal(state.invalidations.length, 0);
});

test('public-only editing does not bypass deleted-record protection', async context => {
  const state = install(context);
  seedGroup(state, { status: 'deleted' });
  state.rows.News = [];
  delete state.rows.Article[0].sourceNewsId;
  assertDenied(state, state.content(), await state.request('patch', `/api/articles/${state.rows.Article[0]._id}`, { title: 'Denied deleted edit' }, 'editor'));
});

test('a protected sibling added after commit prevents every enqueue-transaction write', async context => {
  const state = install(context, DRAFTER);
  const id = ownedDraft(state);
  const start = mongoose.startSession;
  let attempts = 0;
  context.mock.method(mongoose, 'startSession', async () => {
    if (++attempts === 2) {
      const sibling = {
        ...copy(state.rows.News[0]), _id: '507f1f77bcf86cd799439086',
        title: 'Externally published sibling', status: 'published', language: 'hi',
        createdByUserId: actorId('editor'), publishedAt: new Date('2026-01-01'),
      };
      state.rows.News.push(sibling);
      state.rows.Article.push({ ...copy(sibling), _id: '607f1f77bcf86cd799439086', sourceNewsId: sibling._id });
    }
    return start();
  });
  const response = await state.request('patch', `/api/articles/${id}`, { title: 'Committed own draft' }, 'reporter');
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.postCommitWarnings[0].code, 'ARTICLE_FOLLOW_UP_FAILED');
  assert.equal(state.rows.News[0].title, 'Committed own draft');
  assert.equal(state.rows.Article[0].title, 'Externally published sibling');
  assert.equal(state.rows.TranslationJob.length, 0);
  assert.equal(state.calls.filter(call => CONTENT_MODELS.includes(call.name)
    && WRITES.has(call.method) && call.options?.session === state.transactions[1]).length, 0);
});
