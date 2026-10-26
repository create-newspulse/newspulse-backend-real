require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const News = require('../models/News');
const User = require('../models/User');
const Role = require('../models/Role');
const SiteSettings = require('../models/SiteSettings');
const CommunitySubmission = require('../models/CommunitySubmission');
const YouthPulseSubmission = require('../models/YouthPulseSubmission');
const { buildArticleCreatorFields, hasArticleCreatorInput } = require('../lib/articleCreator');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');
const { createYouthPulseDraft } = require('../services/youthPulseSubmission.service');
const { generateArticleTranslations, sourceHashForDoc } = require('../services/articleTranslationGeneration.service');
const { publishCanonicalArticle } = require('../services/articlePublishing.service');
const googleTranslation = require('../services/googleTranslationService');
const reporterIdentity = require('../services/reporterIdentityResolution.service');
const { serializePublicArticle } = require('../services/publicArticleSerializer.service');

const OWNER_ID = '507f1f77bcf86cd799439071';
const OTHER_ID = '507f1f77bcf86cd799439072';
const SUBMISSION_ID = '507f1f77bcf86cd799439073';
const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin'];
const COMMUNITY_PREFIXES = [
  '/api/admin/community-reporter', '/admin-api/admin/community-reporter',
  '/admin-api/api/admin/community-reporter', '/admin/community-reporter', '/admin/community',
];
const TITLES = {
  en: 'Synthetic creator story',
  hi: '\u0939\u093f\u0902\u0926\u0940 \u0938\u092e\u093e\u091a\u093e\u0930',
  gu: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0 \u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0',
};

function install(context) {
  const state = installEditorialFixture(context);
  const findUser = User.findById;
  let account;
  context.mock.method(User, 'findById', id => {
    const query = findUser(id);
    const lean = query.lean.bind(query);
    query.lean = async () => {
      account = await lean();
      return account;
    };
    return query;
  });
  state.account = () => account;
  return state;
}

function storeConstructedNews(context, state) {
  context.mock.method(News.prototype, 'save', async function () {
    const row = this.toObject();
    const index = state.rows.News.findIndex(doc => String(doc._id) === String(this._id));
    if (index < 0) state.rows.News.push(row);
    else state.rows.News[index] = row;
    return this;
  });
}

function submission(overrides = {}) {
  return {
    _id: SUBMISSION_ID, headline: 'Synthetic submission', body: 'Synthetic community body',
    storyBody: 'Synthetic youth body', category: 'national', status: 'APPROVED',
    sourceType: 'community_reporter', originalLanguage: 'en', track: 'student-voices',
    reporterId: OTHER_ID, reviewedBy: OTHER_ID, createdByUserId: OTHER_ID,
    async save() { return this; },
    ...overrides,
  };
}

function enableCommunityCreation(context) {
  // Exercise the real handoff branch without removing the database/network isolation or model mocks.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  context.after(() => { process.env.NODE_ENV = previous; });
  context.mock.method(reporterIdentity, 'resolveAndAttachForSubmission', async () => ({ profileId: null }));
}

function seedSource(state) {
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  state.rows.News.splice(1);
  state.rows.News[0].createdByUserId = OWNER_ID;
  return ids[0];
}

function stubTranslationProvider(context) {
  context.mock.method(googleTranslation, 'translateText', async (_text, _source, target, options) => ({
    ok: true, text: options.format === 'html' ? `<p>${TITLES[target]}</p>` : TITLES[target],
  }));
}

test('creator provenance uses only the persisted authentication context, never claims or actor labels', () => {
  for (const req of [
    undefined, {}, { admin: { id: OWNER_ID, role: 'founder' } }, { user: { id: OWNER_ID } },
    { body: { createdByUserId: OWNER_ID, _authUserDoc: { _id: OWNER_ID } } },
    { requestedBy: OWNER_ID, reviewedBy: OWNER_ID, staffId: OWNER_ID },
  ]) assert.deepEqual(buildArticleCreatorFields(req), {});
  assert.deepEqual(buildArticleCreatorFields({
    _authUserDoc: { _id: OWNER_ID }, body: { createdByUserId: OTHER_ID },
  }), { createdByUserId: OWNER_ID });
  const objectId = new mongoose.Types.ObjectId(OWNER_ID);
  assert.deepEqual(buildArticleCreatorFields({ _authUserDoc: { _id: objectId } }), { createdByUserId: objectId });
  assert.throws(() => buildArticleCreatorFields({ _authUserDoc: { _id: 'invalid' } }), {
    code: 'INVALID_ARTICLE_CREATOR', statusCode: 500,
  });
  assert.equal(hasArticleCreatorInput({ createdByUserId: null }), true);
  assert.equal(hasArticleCreatorInput({ 'createdByUserId.value': OTHER_ID }), true);
  assert.equal(hasArticleCreatorInput({ title: 'Ordinary edit' }), false);
});

test('creator schema is optional, immutable and excluded from ordinary query projections without a new index', async context => {
  const path = News.schema.path('createdByUserId');
  assert.equal(path.instance, 'ObjectId');
  assert.equal(path.options.ref, 'User');
  assert.equal(path.options.immutable, true);
  assert.equal(path.options.select, false);
  assert.equal(path.defaultValue, undefined);
  assert.equal(News.schema.indexes().some(([keys]) => Object.hasOwn(keys, 'createdByUserId')), false);
  let projection;
  context.mock.method(News.collection, 'findOne', async (_filter, options) => {
    projection = options.projection;
    return { _id: new mongoose.Types.ObjectId(SUBMISSION_ID), title: 'Existing story' };
  });
  const doc = await News.findById(SUBMISSION_ID).lean();
  assert.equal(projection.createdByUserId, 0);
  assert.equal(doc.createdByUserId, undefined);
});

test('hydrated records cannot replace a known creator or acquire a creator during an ordinary edit', () => {
  for (const creator of [OWNER_ID, undefined]) {
    const doc = News.hydrate({
      _id: SUBMISSION_ID, title: 'Original', ...(creator ? { createdByUserId: creator } : {}),
    });
    doc.createdByUserId = OTHER_ID;
    doc.set({ title: 'Edited', createdByUserId: OTHER_ID });
    assert.equal(doc.createdByUserId == null ? undefined : String(doc.createdByUserId), creator);
    assert.equal(JSON.stringify(doc.getChanges()).includes('createdByUserId'), false);
    assert.equal(doc.title, 'Edited');
  }
});

for (const method of ['updateOne', 'updateMany', 'findOneAndUpdate']) {
  test(`ordinary Mongoose ${method} strips creator replacement and removal before the database call`, async context => {
    const writes = [];
    context.mock.method(News.collection, method, async (_filter, update) => {
      writes.push(update);
      return method === 'findOneAndUpdate'
        ? { value: { _id: SUBMISSION_ID, title: 'Edited', createdByUserId: OWNER_ID } }
        : { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    });
    for (const update of [
      { $set: { title: 'Edited', createdByUserId: OTHER_ID } },
      { $set: { title: 'Edited' }, $unset: { createdByUserId: 1 } },
    ]) await News[method]({ _id: SUBMISSION_ID }, update);
    assert.equal(writes.length, 2);
    for (const update of writes) {
      assert.equal(update.$set.title, 'Edited');
      assert.equal(JSON.stringify(update).includes('createdByUserId'), false);
    }
  });
}

for (const prefix of PREFIXES) {
  for (const role of ['founder', 'editor']) {
    for (const language of ['en', 'hi', 'gu']) {
      test(`${prefix}/articles ${role} ${language} creation stamps the verified account instead of forged provenance`, async context => {
        const state = install(context);
        const response = await state.request('post', `${prefix}/articles`, {
          title: TITLES[language], description: 'Synthetic summary', content: `<p>${TITLES[language]}</p>`,
          category: 'national', language, status: 'draft',
          createdByUserId: OTHER_ID, 'createdByUserId.value': OTHER_ID,
          authorId: OTHER_ID, staffId: OTHER_ID, _authUserDoc: { _id: OTHER_ID },
          authorByline: { enabled: true, snapshot: { name: 'Independent public author' } },
        }, role);
        assert.equal(response.status, 201, response.text);
        const doc = state.rows.News.find(row => String(row._id) === String(response.body.article._id));
        assert.equal(String(doc.createdByUserId), String(state.account()._id));
        assert.notEqual(String(doc.createdByUserId), OTHER_ID);
        assert.equal(doc.language, language);
        assert.equal(doc.status, 'draft');
        assert.equal(doc.authorByline.snapshot.name, 'Independent public author');
        assert.equal(response.body.success, true);
      });
    }
  }

  for (const method of ['put', 'patch']) {
    for (const creator of [OWNER_ID, undefined]) {
      test(`${method.toUpperCase()} ${prefix}/articles preserves ${creator ? 'known' : 'unknown'} creator provenance`, async context => {
        const state = install(context);
        const { ids } = seedGroup(state, { status: 'draft', copies: false });
        if (creator) state.rows.News[0].createdByUserId = creator;
        const response = await state.request(method, `${prefix}/articles/${ids[0]}`, {
          title: 'Edited headline', createdByUserId: OTHER_ID, 'createdByUserId.value': OTHER_ID,
        }, 'editor');
        assert.equal(response.status, 200, response.text);
        assert.equal(state.rows.News[0].title, 'Edited headline');
        assert.equal(state.rows.News[0].createdByUserId, creator);
        assert.ok(state.rows.News.slice(1).every(doc => doc.createdByUserId === undefined));
      });
    }
  }
}

test('manual language records belong to their creating account, not the source creator or group', async context => {
  const state = install(context);
  const sourceId = seedSource(state);
  for (const language of ['hi', 'gu']) {
    const response = await state.request('post', '/api/articles', {
      title: TITLES[language], description: 'Manual translation', content: `<p>${TITLES[language]}</p>`,
      category: 'national', language, status: 'draft', sourceArticleId: sourceId,
      translationGroupId: 'story-test-group', createdByUserId: OWNER_ID,
    }, 'editor');
    assert.equal(response.status, 201, response.text);
    const doc = state.rows.News.find(row => String(row._id) === String(response.body.article._id));
    assert.equal(String(doc.createdByUserId), String(state.account()._id));
    assert.notEqual(String(doc.createdByUserId), OWNER_ID);
    assert.equal(String(doc.sourceArticleId), sourceId);
  }
  assert.equal(state.rows.News[0].createdByUserId, OWNER_ID);
});

for (const base of ['/api/news', '/api/api/news']) {
  for (const suffix of ['', '/news']) {
    test(`legacy creation ${base}${suffix} stays unknown without verified authentication`, async context => {
      const state = install(context);
      storeConstructedNews(context, state);
      const response = await state.request('post', `${base}${suffix}`, {
        title: 'Legacy story', description: 'Legacy summary', content: '<p>Legacy body</p>', status: 'draft',
        authorId: OTHER_ID, staffId: OTHER_ID, _authUserDoc: { _id: OTHER_ID },
        workflowHistory: [{ action: 'Created', byUserId: OTHER_ID }],
        $set: { createdByUserId: OTHER_ID }, $setOnInsert: { createdByUserId: OTHER_ID },
        $rename: { title: 'createdByUserId' },
      }, 'editor');
      assert.equal(response.status, 201);
      assert.equal(state.account(), undefined);
      assert.equal(state.rows.News.length, 1);
      assert.equal(state.rows.News[0].createdByUserId, undefined);
    });
  }
  for (const method of ['post', 'put', 'patch']) {
    for (const field of ['createdByUserId', 'createdByUserId.value']) {
      test(`legacy ${method.toUpperCase()} ${base} rejects ${field} before article writes`, async context => {
        const state = install(context);
        const { ids } = seedGroup(state, { status: 'draft', copies: false });
        storeConstructedNews(context, state);
        const before = structuredClone(state.rows.News);
        const response = await state.request(method, method === 'post' ? base : `${base}/${ids[0]}`, {
          title: 'Attempted claim', description: 'Summary', [field]: OTHER_ID,
        }, 'editor');
        assert.equal(response.status, 400);
        assert.deepEqual(response.body, { error: 'Article creator identity is server-controlled' });
        assert.deepEqual(state.rows.News, before);
        assert.equal(state.calls.filter(call => call.name === 'News').length, 0);
      });
    }
  }
  for (const method of ['put', 'patch']) {
    test(`legacy ${method.toUpperCase()} ${base} cannot apply creator claims wrapped in Mongo operators`, async context => {
      const state = install(context);
      const doc = News.hydrate({ _id: SUBMISSION_ID, title: 'Original', slug: 'original', createdByUserId: OWNER_ID });
      context.mock.method(News, 'findById', async () => doc);
      const save = context.mock.method(doc, 'save', async () => doc);
      const response = await state.request(method, `${base}/${SUBMISSION_ID}`, {
        title: 'Edited', $set: { createdByUserId: OTHER_ID }, $unset: { createdByUserId: 1 },
        $rename: { title: 'createdByUserId' },
      }, 'editor');
      assert.equal(response.status, 200);
      assert.equal(String(doc.createdByUserId), OWNER_ID);
      assert.equal(doc.title, 'Edited');
      assert.equal(save.mock.callCount(), 1);
    });
  }
}

for (const base of COMMUNITY_PREFIXES) {
  for (const action of ['approve', 'decision', 'publish-handoff']) {
    test(`Community ${base} ${action} stamps only a newly created draft's authenticated creator`, async context => {
      const state = install(context);
      storeConstructedNews(context, state);
      enableCommunityCreation(context);
      const source = submission();
      context.mock.method(CommunitySubmission, 'findById', async () => source);
      const response = await state.request('post', `${base}/submissions/${SUBMISSION_ID}/${action}`, {
        decision: 'approve', createdByUserId: OTHER_ID,
      }, 'editor');
      assert.equal(response.status, 200, response.text);
      assert.equal(state.rows.News.length, 1);
      const creator = String(state.account()._id);
      assert.equal(String(state.rows.News[0].createdByUserId), creator);
      assert.notEqual(creator, String(source.reporterId));
      assert.equal(String(state.rows.News[0].communityReportId), SUBMISSION_ID);
      assert.equal(state.rows.News[0].status, 'draft');
      const repeated = await state.request('post', `${base}/submissions/${SUBMISSION_ID}/${action}`, {
        decision: 'approve',
      }, 'founder');
      assert.equal(repeated.status, 200, repeated.text);
      assert.equal(state.rows.News.length, 1);
      assert.equal(String(state.rows.News[0].createdByUserId), creator);
    });
  }
}

const YOUTH_PATHS = [
  ...['/api/admin/community', '/admin-api/admin/community', '/admin-api/api/admin/community']
    .flatMap(base => ['create-draft', 'publish'].map(action => `${base}/youth-pulse/submissions/${SUBMISSION_ID}/${action}`)),
  ...COMMUNITY_PREFIXES.flatMap(base => [
    `${base}/youth-pulse/submissions/${SUBMISSION_ID}/create-draft`,
    `${base}/youth-pulse/submissions/${SUBMISSION_ID}/publish-handoff`,
    `${base}/submissions/${SUBMISSION_ID}/publish-handoff`,
  ]),
];
for (const [index, path] of YOUTH_PATHS.entries()) {
  test(`Youth Pulse ${path} records the handoff creator without changing attribution or repeat handling`, async context => {
    const language = ['en', 'hi', 'gu'][index % 3];
    const state = install(context);
    storeConstructedNews(context, state);
    const source = submission({ sourceType: 'youth_pulse', status: 'approved', originalLanguage: language });
    context.mock.method(CommunitySubmission, 'findById', async () => null);
    context.mock.method(YouthPulseSubmission, 'findById', async () => source);
    const response = await state.request('post', path, { createdByUserId: OTHER_ID }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.equal(state.rows.News.length, 1);
    const creator = String(state.account()._id);
    assert.equal(String(state.rows.News[0].createdByUserId), creator);
    assert.equal(state.rows.News[0].language, language);
    assert.equal(state.rows.News[0].sourceType, 'youth_pulse');
    assert.equal(String(state.rows.News[0].youthPulseSubmissionId), SUBMISSION_ID);
    assert.equal(source.status, 'draft_created');
    const repeated = await state.request('post', path, {}, 'founder');
    assert.equal(repeated.status, 200, repeated.text);
    assert.equal(state.rows.News.length, 1);
    assert.equal(String(state.rows.News[0].createdByUserId), creator);
  });
}

test('existing Community and Youth drafts without creator metadata remain unknown after handoff', async context => {
  const state = install(context);
  enableCommunityCreation(context);
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  const community = submission({ linkedArticleId: ids[0] });
  context.mock.method(CommunitySubmission, 'findById', async () => community);
  const response = await state.request('post', `/api/admin/community-reporter/submissions/${SUBMISSION_ID}/approve`, {}, 'editor');
  assert.equal(response.status, 200, response.text);
  const youth = submission({ sourceType: 'youth_pulse', status: 'approved', linkedDraftId: ids[1] });
  await createYouthPulseDraft(youth, { admin: 'Reviewer label', req: { _authUserDoc: { _id: OTHER_ID } } });
  assert.ok(state.rows.News.every(doc => doc.createdByUserId === undefined));
});

test('Youth service calls without verified context do not infer creator from reviewer or submission identity', async context => {
  const state = install(context);
  storeConstructedNews(context, state);
  const source = submission({ sourceType: 'youth_pulse', status: 'approved' });
  const result = await createYouthPulseDraft(source, { admin: OWNER_ID, req: { admin: { id: OWNER_ID, role: 'founder' } } });
  assert.equal(result.article.createdByUserId, undefined);
  assert.equal(state.rows.News[0].createdByUserId, undefined);
  assert.equal(source.approvedBy, OWNER_ID);
});

test('authenticated translation generation stamps the request actor, not the source creator, and preserves it on overwrite', async context => {
  const state = install(context);
  stubTranslationProvider(context);
  const id = seedSource(state);
  const first = await state.request('post', `/api/articles/${id}/translations/generate`, {
    targetLanguages: ['en', 'hi', 'gu'], createdByUserId: OTHER_ID,
  }, 'editor');
  assert.equal(first.status, 200, first.text);
  const creator = String(state.account()._id);
  assert.equal(state.rows.News.length, 3);
  for (const child of state.rows.News.slice(1)) assert.equal(String(child.createdByUserId), creator);
  assert.equal(state.rows.News[0].createdByUserId, OWNER_ID);
  const second = await state.request('post', `/api/articles/${id}/translations/generate`, {
    targetLanguages: ['en', 'hi', 'gu'], overwrite: true,
  }, 'founder');
  assert.equal(second.status, 200, second.text);
  for (const child of state.rows.News.slice(1)) assert.equal(String(child.createdByUserId), creator);
});

test('system translation generation never inherits the source creator or trusts requestedBy', async context => {
  const state = install(context);
  stubTranslationProvider(context);
  const id = seedSource(state);
  const beforeHash = sourceHashForDoc(state.rows.News[0]);
  const result = await generateArticleTranslations(state.newsDoc(id), {
    targetLanguages: ['en', 'hi', 'gu'], requestedBy: OTHER_ID, req: { admin: { id: OTHER_ID, role: 'founder' } },
  });
  assert.equal(result.ok, true);
  assert.equal(state.rows.News.length, 3);
  assert.ok(state.rows.News.slice(1).every(doc => doc.createdByUserId === undefined));
  assert.equal(sourceHashForDoc({ ...state.rows.News[0], createdByUserId: OTHER_ID }), beforeHash);
  const overwritten = await state.request('post', `/api/articles/${id}/translations/generate`, {
    targetLanguages: ['en', 'hi', 'gu'], overwrite: true,
  }, 'founder');
  assert.equal(overwritten.status, 200, overwritten.text);
  assert.ok(state.rows.News.slice(1).every(doc => doc.createdByUserId === undefined));
});

for (const base of ['/api/admin/news', '/admin-api/admin/news', '/admin-api/api/admin/news']) {
  test(`${base} translation-generation compatibility route retains trusted request identity`, async context => {
    const state = install(context);
    stubTranslationProvider(context);
    const id = seedSource(state);
    const previousKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    process.env.GOOGLE_TRANSLATE_API_KEY = 'synthetic-creator-test-only';
    context.after(() => {
      if (previousKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
      else process.env.GOOGLE_TRANSLATE_API_KEY = previousKey;
    });
    const response = await state.request('post', `${base}/${id}/generate-translations`, {
      targetLanguages: ['en', 'hi', 'gu'], createdByUserId: OTHER_ID,
    }, 'editor');
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.success, true);
    assert.equal(state.rows.News.length, 3);
    for (const child of state.rows.News.slice(1)) {
      assert.equal(String(child.createdByUserId), String(state.account()._id));
    }
    assert.equal(JSON.stringify(response.body).includes('createdByUserId'), false);
  });
}

for (const authenticated of [true, false]) {
  test(`${authenticated ? 'Authenticated' : 'System'} cached-translation creation preserves source identity and public projections`, async context => {
    const state = install(context);
    const id = seedSource(state);
    state.rows.News[0].translations = Object.fromEntries(['hi', 'gu'].map(lang => [
      lang, { title: TITLES[lang], summary: `Summary ${lang}`, content: `<p>${TITLES[lang]}</p>`, provider: 'manual' },
    ]));
    context.mock.method(googleTranslation, 'translateText', () => assert.fail('Cached language records must not call a provider'));
    if (authenticated) {
      const response = await state.request('post', `/api/articles/${id}/publish`, {}, 'founder');
      assert.equal(response.status, 200, response.text);
    } else {
      await publishCanonicalArticle(id, { actor: { byUserId: OTHER_ID, byRole: 'SYSTEM' } });
    }
    assert.equal(state.rows.News.length, 3);
    assert.equal(state.rows.News[0].createdByUserId, OWNER_ID);
    for (const child of state.rows.News.slice(1)) {
      assert.equal(child.createdByUserId == null ? undefined : String(child.createdByUserId),
        authenticated ? String(state.account()._id) : undefined);
      assert.equal(child.status, 'published');
    }
    assert.equal(state.rows.Article.length, 3);
    assert.ok(state.rows.Article.every(doc => !Object.hasOwn(doc, 'createdByUserId')));
    for (const doc of state.rows.News) {
      const output = JSON.stringify(serializePublicArticle(doc));
      assert.equal(output.includes('createdByUserId'), false);
      assert.equal(output.includes(OWNER_ID), false);
      if (authenticated) assert.equal(output.includes(String(state.account()._id)), false);
    }
  });
}

test('creator provenance grants no Manage News reads, publication or permanent-deletion access', async context => {
  const state = install(context);
  context.mock.method(SiteSettings, 'findOne', async () => ({
    adminModulePolicy: { modulePolicies: { manageNews: 'available' }, version: 1 },
  }));
  context.mock.method(Role, 'findOne', () => ({ lean: async () => null }));
  const created = await state.request('post', '/api/articles', {
    title: 'Owned draft', description: 'Synthetic summary', content: '<p>Draft body</p>',
    category: 'national', language: 'en', status: 'draft',
  }, 'editor');
  assert.equal(created.status, 201);
  const id = created.body.article._id;
  const before = structuredClone(state.rows.News);
  assert.equal((await state.request('get', `/api/articles/${id}`, undefined, 'editor')).status, 403);
  assert.equal((await state.request('get', '/api/articles?status=draft', undefined, 'editor')).status, 403);
  assert.equal((await state.request('post', `/api/articles/${id}/publish`, {}, 'editor')).status, 403);
  assert.equal((await state.request('delete', `/api/articles/${id}/permanent`, undefined, 'editor')).status, 403);
  assert.deepEqual(state.rows.News, before);
});
