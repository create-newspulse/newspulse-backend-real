require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const google = require('../services/googleTranslationService');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');
const { loadTranslationGroupStatus } = require('../services/translationGroupStatus');
const { slugifyLocalizedTitle } = require('../lib/slug');

const LANGUAGES = ['gu', 'hi', 'en'];
const CONTENT_MODELS = ['News', 'Article', 'TranslationJob', 'PublicConfigVersion'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const IDENTITY_ERROR = 'TRANSLATION_SOURCE_IDENTITY_INVALID';
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);
const paths = [
  id => `/api/articles/${id}/translations/generate`,
  id => `/api/admin/news/${id}/generate-translations`,
];

function withoutGuardFields(doc, source = false) {
  const out = structuredClone(doc);
  delete out.syncVersion;
  delete out.updatedAt;
  if (source) {
    delete out.translationGroupId;
    delete out.translationKey;
  }
  return out;
}

function install(context, { sourceLanguage = 'gu', requestedLanguage = sourceLanguage, layout = 'keyless', status = 'published', staff } = {}) {
  const state = installEditorialFixture(context, {
    staff,
    modulePolicies: { manageNews: 'available', addNews: 'available', draftDesk: 'available' },
  });
  seedGroup(state, { status });
  const source = state.rows.News.find(doc => doc.language === sourceLanguage);
  const heldLanguage = requestedLanguage === sourceLanguage
    ? LANGUAGES.find(lang => lang !== sourceLanguage) : requestedLanguage;
  const missingLanguage = LANGUAGES.find(lang => ![sourceLanguage, heldLanguage].includes(lang));
  state.rows.News = state.rows.News.filter(doc => doc.language !== missingLanguage);
  state.rows.Article = state.rows.Article.filter(doc => doc.language !== missingLanguage);
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    doc.sourceArticleId = source._id;
    doc.sourceLanguage = sourceLanguage;
    doc.createdByUserId = actorId('reporter');
    if (doc.language === heldLanguage) {
      doc.humanEdited = true;
      doc.title = `Human-edited ${heldLanguage} headline`;
      doc.content = `<p>Human-edited ${heldLanguage} body</p>`;
      doc.translationReviewStatus = 'reviewed';
      doc.translationMeta = {
        sourceArticleId: source._id, sourceLanguage, targetLanguage: heldLanguage, humanEdited: true,
      };
    }
    if (layout === 'keyless'
      || (layout === 'source-key-only' && doc.language !== sourceLanguage)
      || (layout === 'child-key-only' && doc.language === sourceLanguage)) {
      delete doc.translationGroupId;
      delete doc.translationKey;
    }
    if (layout === 'placeholders') {
      doc.translationGroupId = 'null';
      doc.translationKey = 'undefined';
    }
  }
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
  const previousDb = mongoose.connection.db;
  const previousKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  mongoose.connection.db = {};
  process.env.GOOGLE_TRANSLATE_API_KEY = 'synthetic-legacy-translation-key';
  context.after(() => {
    mongoose.connection.db = previousDb;
    if (previousKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = previousKey;
  });
  const translate = context.mock.method(google, 'translateText', async (text, from, to) => {
    assert.equal(from, sourceLanguage, 'The provider must receive the verified canonical source language');
    return { ok: true, text: `${to} ${text}` };
  });
  context.mock.method(google, 'detectLanguage', () => assert.fail('Verified legacy generation must not guess a language'));
  const requestedId = state.rows.News.find(doc => doc.language === requestedLanguage)._id;
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(name => [name, structuredClone(state.rows[name])]));
  state.writes = () => state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method));
  return { state, source, requestedId, heldLanguage, missingLanguage, translate };
}

function assertBlocked(state, before, response, translate, expectedStatus = 409) {
  assert.equal(response.status, expectedStatus, response.text);
  assert.equal(response.body.ok, false);
  if (expectedStatus === 409) {
    assert.equal(response.body.code, IDENTITY_ERROR);
    assert.match(response.body.message, /Founder review/);
  }
  assert.deepEqual(state.content(), before);
  assert.equal(state.writes().length, 0);
  assert.equal(translate.mock.callCount(), 0);
  assert.equal(state.invalidations.length, 0);
}

function castIdentityQueries(context) {
  for (const Model of [News, PublicArticle]) for (const method of ['find', 'findOne', 'updateMany']) {
    const original = Model[method];
    context.mock.method(Model, method, (filter, ...args) =>
      original.call(Model, Model.where(filter).cast(Model), ...args));
  }
}

const legacyId = id => ` \t${String(id).toUpperCase()}\n\ufeff`;

for (const layout of ['modern', 'keyless', 'placeholders', 'source-key-only', 'child-key-only']) {
  for (const sourceLanguage of LANGUAGES) for (const requestedLanguage of LANGUAGES) {
    test(`${layout}: ${sourceLanguage} source generates via ${requestedLanguage} without duplicate editions`, async context => {
      const { state, source, requestedId, heldLanguage, missingLanguage, translate } = install(context, {
        sourceLanguage, requestedLanguage, layout,
      });
      const held = state.rows.News.find(doc => doc.language === heldLanguage);
      const beforeSource = withoutGuardFields(source, true);
      const beforeHeld = withoutGuardFields(held);
      const beforeCopies = structuredClone(state.rows.Article);
      const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.sourceLanguage, sourceLanguage);
      assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
      assert.deepEqual(response.body.updated, {});
      assert.deepEqual(response.body.failed, {});
      assert.deepEqual(response.body.skipped[heldLanguage], { reason: 'human_edited', id: held._id });
      assert.equal(state.rows.News.length, 3);
      assert.deepEqual(state.rows.News.map(doc => doc.language).sort(), ['en', 'gu', 'hi']);
      const created = state.rows.News.find(doc => doc.language === missingLanguage);
      assert.equal(response.body.created[missingLanguage], created._id);
      assert.equal(created.sourceArticleId, source._id);
      assert.equal(created.translationMeta.sourceArticleId, source._id);
      assert.equal(created.sourceLanguage, sourceLanguage);
      assert.equal(created.status, 'draft');
      assert.equal(created.publishedAt, null);
      assert.equal(created.translationReviewStatus, 'review_required');
      assert.equal(created.translatedByProvider, 'google_translate');
      assert.equal(created.title, `${missingLanguage} ${source.title}`);
      assert.equal(created.content, `${missingLanguage} ${source.content}`);
      assert.equal(created.createdByUserId, actorId('founder'));
      const key = response.body.translationGroupId;
      if (['keyless', 'placeholders'].includes(layout)) assert.match(key, /^[a-f0-9]{24}$/);
      else assert.equal(key, 'story-test-group');
      assert.equal(created.translationGroupId, key);
      assert.equal(created.translationKey, key);
      const savedSource = state.rows.News.find(doc => doc._id === source._id);
      assert.equal(savedSource.translationGroupId, key);
      assert.equal(savedSource.translationKey, key);
      assert.deepEqual(withoutGuardFields(savedSource, true), beforeSource);
      assert.deepEqual(withoutGuardFields(state.rows.News.find(doc => doc._id === held._id)), beforeHeld);
      assert.deepEqual(state.rows.Article, beforeCopies);
      assert.equal(state.rows.TranslationJob.length, 1);
      assert.equal(state.rows.TranslationJob[0].newsId, source._id);
      assert.equal(state.transactions.length, 1);
      assert.ok(state.transactions[0].committed && state.transactions[0].ended);
      for (const call of state.writes()) assert.equal(call.options?.session, state.transactions[0]);

      const providerCalls = translate.mock.callCount();
      const ids = state.rows.News.map(doc => doc._id);
      const retry = await state.request('post', paths[1](requestedId), { targetLanguages: LANGUAGES });
      assert.equal(retry.status, 200, retry.text);
      assert.equal(retry.body.sourceLanguage, sourceLanguage);
      assert.equal(retry.body.translationKey, key);
      assert.equal(retry.body.translationGroupId, key);
      assert.deepEqual(retry.body.created, {});
      assert.deepEqual(retry.body.updated, {});
      assert.equal(retry.body.skipped[missingLanguage].id, created._id);
      assert.equal(retry.body.skipped[heldLanguage].reason, 'human_edited');
      assert.deepEqual(state.rows.News.map(doc => doc._id), ids);
      assert.equal(translate.mock.callCount(), providerCalls);
      assert.deepEqual(state.rows.Article, beforeCopies);
      const statusResponse = await state.request('get', `/api/admin/articles/${requestedId}/translation-status`);
      assert.equal(statusResponse.status, 200, statusResponse.text);
      assert.equal(statusResponse.body.data.languageStates.sourceArticleId, source._id);
      assert.equal(statusResponse.body.data.languageStates.baseLang, sourceLanguage);
    });
  }
}

for (const variant of ['originalLang only', 'language aliases']) {
  test(`existing legacy child with ${variant} is found by its verified edition ID`, async context => {
    const { state, source, heldLanguage, missingLanguage } = install(context);
    const held = state.rows.News.find(doc => doc.language === heldLanguage);
    if (variant === 'originalLang only') {
      delete held.language;
      delete held.lang;
      delete held.translationMeta.targetLanguage;
    } else {
      held.language = heldLanguage === 'hi' ? 'Hindi' : 'English';
      held.lang = `${heldLanguage}-IN`;
    }
    const before = withoutGuardFields(held);
    const response = await state.request('post', paths[0](source._id), { targetLanguages: LANGUAGES, overwrite: true });
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
    assert.deepEqual(response.body.updated, {});
    assert.equal(response.body.skipped[heldLanguage].reason, 'human_edited');
    assert.deepEqual(withoutGuardFields(state.rows.News.find(doc => doc._id === held._id)), before);
    assert.equal(state.rows.News.length, 3);
  });
}

const invalidCases = {
  'no explicit source identity': ({ state }) => {
    for (const doc of state.rows.News) {
      delete doc.sourceArticleId;
      delete doc.translationMeta;
    }
  },
  'missing canonical source': ({ state, source }) => { state.rows.News = state.rows.News.filter(doc => doc._id !== source._id); },
  'conflicting source links': ({ state }) => { state.rows.News[0].sourceArticleId = '507f1f77bcf86cd799439999'; },
  'conflicting nested source metadata': ({ state, source }) => {
    state.rows.News.find(doc => doc._id !== source._id).translationMeta.sourceArticleId = '507f1f77bcf86cd799439999';
  },
  'multiple self-anchored sources': ({ state, source }) => {
    const child = state.rows.News.find(doc => doc._id !== source._id);
    child.sourceArticleId = child._id;
    delete child.translationMeta;
  },
  'conflicting real group keys': ({ state }) => {
    for (const doc of state.rows.News) doc.translationGroupId = `foreign-${doc.language}`;
  },
  'conflicting group-key aliases': ({ source }) => { source.translationGroupId = 'first-group'; source.translationKey = 'second-group'; },
  'invalid group-key type': ({ source }) => { source.translationGroupId = ['invalid-key']; },
  'invalid metadata shape': ({ state, source }) => {
    state.rows.News.find(doc => doc._id !== source._id).translationMeta = ['invalid'];
  },
  'keyed group with no source identity': ({ state }) => {
    for (const doc of state.rows.News) {
      delete doc.sourceArticleId;
      delete doc.translationMeta;
      doc.translationGroupId = 'unanchored-key';
    }
  },
  'nested source link without canonical child linkage': ({ state, source }) => {
    delete state.rows.News.find(doc => doc._id !== source._id).sourceArticleId;
  },
  'missing child language': ({ state, source }) => {
    const child = state.rows.News.find(doc => doc._id !== source._id);
    delete child.lang;
    delete child.language;
    delete child.originalLang;
    delete child.translationMeta.targetLanguage;
  },
  'invalid source ID': ({ source }) => { source.sourceArticleId = 'not-an-id'; },
  'missing source language': ({ source }) => {
    delete source.lang;
    delete source.language;
    delete source.originalLang;
  },
  'conflicting native language': ({ source }) => { source.lang = 'en'; },
  'conflicting declared source language': ({ source }) => { source.sourceLanguage = 'hi'; },
  'duplicate target editions': ({ state, source }) => {
    state.rows.News.push({ ...structuredClone(state.rows.News.find(doc => doc._id !== source._id)), _id: '507f1f77bcf86cd799439998' });
  },
};

for (const [label, mutate] of Object.entries(invalidCases)) for (const path of paths) {
  test(`${path(':id')} blocks ${label} before provider or content writes`, async context => {
    const setup = install(context, { requestedLanguage: 'hi' });
    mutate(setup);
    const { state, requestedId, translate } = setup;
    const before = state.content();
    const response = await state.request('post', path(requestedId), { targetLanguages: LANGUAGES });
    assertBlocked(state, before, response, translate);
  });
}

for (const [label, staff, role, status, expectedStatus] of [
  ['authorized Editor draft', { specialRightsConfigured: true, specialRightsOverride: ['news_edit'], moduleAccessStates: { manageNews: 'enabled' } }, 'editor', 'draft', 200],
  ['verified own Draft Desk', { specialRightsConfigured: true, specialRightsOverride: [], moduleAccessStates: { manageNews: 'disabled', addNews: 'enabled', draftDesk: 'enabled' } }, 'reporter', 'draft', 200],
  ['staff published story', { specialRightsConfigured: true, specialRightsOverride: ['news_edit'], moduleAccessStates: { manageNews: 'enabled' } }, 'editor', 'published', 403],
  ['module without edit rights', { specialRightsConfigured: true, specialRightsOverride: [], moduleAccessStates: { manageNews: 'enabled', addNews: 'disabled', draftDesk: 'disabled' } }, 'editor', 'draft', 403],
]) {
  test(`verified keyless generation preserves ${label} permissions`, async context => {
    const { state, requestedId, missingLanguage, translate } = install(context, {
      requestedLanguage: 'hi', status, staff,
    });
    const before = state.content();
    const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES }, role);
    if (expectedStatus !== 200) assertBlocked(state, before, response, translate, expectedStatus);
    else {
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
      assert.ok(state.rows.News.every(doc => doc.status === 'draft' && doc.publishedAt === null));
      assert.equal(state.rows.News.length, 3);
    }
  });
}

test('shared placeholder keys cannot adopt an unrelated story or skip its language', async context => {
  const { state, source, missingLanguage } = install(context, { layout: 'placeholders' });
  const other = {
    ...structuredClone(source), _id: '507f1f77bcf86cd799439777', sourceArticleId: '507f1f77bcf86cd799439777',
    title: 'Unrelated story', slug: 'unrelated-story', language: missingLanguage, lang: missingLanguage,
    slugs: { en: 'unrelated-en', hi: 'unrelated-hi', gu: 'unrelated-gu' },
    originalLang: missingLanguage, sourceLanguage: missingLanguage, humanEdited: true,
  };
  state.rows.News.push(other);
  const before = structuredClone(other);
  const response = await state.request('post', paths[0](source._id), { targetLanguages: LANGUAGES });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
  assert.notEqual(response.body.created[missingLanguage], other._id);
  assert.deepEqual(state.rows.News.find(doc => doc._id === other._id), before);
});

for (const failure of ['provider', 'later edition write', 'job completion']) {
  test(`verified legacy generation rolls back key initialization and every edition after ${failure} failure`, async context => {
    const { state, source } = install(context);
    state.rows.News = state.rows.News.filter(doc => doc._id === source._id);
    state.rows.Article = state.rows.Article.filter(doc => doc.sourceNewsId === source._id);
    const before = state.content();
    if (failure === 'provider') context.mock.method(google, 'translateText', async (text, _from, to) =>
      to === 'en' ? { ok: false, error: 'Synthetic provider failure' } : { ok: true, text: `${to} ${text}` });
    if (failure === 'later edition write') {
      const create = News.create;
      context.mock.method(News, 'create', (docs, options) => {
        if (docs[0].language === 'en') throw Object.assign(new Error('Synthetic later write failure'), { statusCode: 503 });
        return create(docs, options);
      });
    }

    if (failure === 'job completion') state.failures['TranslationJob.findByIdAndUpdate'] = { once: true };
    const response = await state.request('post', paths[0](source._id), { targetLanguages: ['hi', 'en'] });
    assert.equal(response.status, failure === 'provider' ? 502 : failure === 'later edition write' ? 503 : 500, response.text);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.committed, undefined);
    assert.deepEqual(state.content(), before);
    assert.equal(state.invalidations.length, 0);
    assert.equal(state.transactions.length, 1);
    assert.ok(state.transactions[0].aborted && state.transactions[0].ended && !state.transactions[0].committed);
    for (const call of state.writes()) assert.equal(call.options?.session, state.transactions[0]);
  });
}

for (const sourceLanguage of LANGUAGES) {
  test(`${sourceLanguage} source reuses a real key even when its other key is a placeholder`, async context => {
    const { state, source, requestedId, missingLanguage } = install(context, { sourceLanguage, layout: 'modern' });
    source.translationGroupId = 'undefined';
    const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES });
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.translationGroupId, 'story-test-group');
    assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
    assert.equal(state.rows.News.length, 3);
    assert.ok(state.rows.News.every(doc => doc.translationGroupId === 'story-test-group'));
  });
}

test('incoming verified child links establish a keyless source without its own self-link', async context => {
  const { state, source, requestedId, missingLanguage } = install(context, { requestedLanguage: 'hi' });
  delete source.sourceArticleId;
  const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.sourceLanguage, 'gu');
  assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.News.find(doc => doc._id === source._id).sourceArticleId, undefined);
  assert.equal(state.rows.News.find(doc => doc.language === missingLanguage).sourceArticleId, source._id);
});

for (const conflict of ['sourceArticleId', 'sourceNewsId', 'translationGroupId']) {
  test(`conflicting linked public-copy ${conflict} blocks legacy generation without repair`, async context => {
    const { state, source, requestedId, translate } = install(context);
    const copy = state.rows.Article.find(doc => doc.language !== source.language);
    copy[conflict] = conflict === 'sourceArticleId' ? '507f1f77bcf86cd799439999'
      : conflict === 'sourceNewsId' ? source._id : 'foreign-copy-group';
    const before = state.content();
    const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES });
    assertBlocked(state, before, response, translate);
  });
}

for (const path of paths) for (const sourceLanguage of LANGUAGES) {
  for (const conflict of ['none', 'sourceArticleId', 'sourceNewsId', 'both source links', 'canonical-only', 'unowned', 'sourceLanguage']) {
    const accepted = conflict === 'none' || conflict === 'canonical-only';
    test(`standalone ${sourceLanguage} ${path(':id')} ${accepted ? `accepts its ${conflict === 'canonical-only' ? 'canonical-only ' : ''}public copy` : `rejects ${conflict}`}`, async context => {
      const setup = install(context, { sourceLanguage, layout: 'modern' });
      const { state, source, requestedId, translate } = setup;
      state.rows.News = state.rows.News.filter(doc => doc._id === source._id);
      state.rows.Article = state.rows.Article.filter(doc => doc.sourceNewsId === source._id);
      delete source.sourceArticleId;
      const copy = state.rows.Article[0];
      if (conflict === 'sourceArticleId') copy.sourceArticleId = '507f1f77bcf86cd799439999';
      if (conflict === 'sourceNewsId') copy.sourceNewsId = '507f1f77bcf86cd799439999';
      if (conflict === 'both source links') {
        copy.sourceArticleId = '507f1f77bcf86cd799439998';
        copy.sourceNewsId = '507f1f77bcf86cd799439999';
      }
      if (conflict === 'canonical-only' || conflict === 'unowned') delete copy.sourceNewsId;
      if (conflict === 'unowned') delete copy.sourceArticleId;
      if (conflict === 'sourceLanguage') copy.sourceLanguage = LANGUAGES.find(lang => lang !== sourceLanguage);
      const before = state.content();
      const target = LANGUAGES.find(lang => lang !== sourceLanguage);
      const response = await state.request('post', path(requestedId), { targetLanguages: [target] });
      if (!accepted) return assertBlocked(state, before, response, translate);
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.sourceLanguage, sourceLanguage);
      assert.deepEqual(Object.keys(response.body.created), [target]);
      assert.equal(state.rows.News.length, 2);
      assert.equal(state.rows.News.find(doc => doc.language === target).sourceArticleId, source._id);
      assert.deepEqual(state.rows.Article, before.Article);
      assert.ok(state.transactions[0].committed && !state.transactions[0].aborted);
    });
  }
}

for (const conflict of ['foreign sourceNewsId', 'missing sourceNewsId']) {
  test(`grouped generation ${conflict === 'missing sourceNewsId' ? 'accepts' : 'rejects'} a public copy with ${conflict} linked by sourceArticleId`, async context => {
    const setup = install(context, { requestedLanguage: 'hi' });
    const { state, requestedId, translate } = setup;
    const copy = state.rows.Article[0];
    if (conflict === 'foreign sourceNewsId') copy.sourceNewsId = '507f1f77bcf86cd799439999';
    else delete copy.sourceNewsId;
    const before = state.content();
    const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES });
    if (conflict === 'foreign sourceNewsId') assertBlocked(state, before, response, translate);
    else {
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(Object.keys(response.body.created), [setup.missingLanguage]);
      assert.deepEqual(state.rows.Article, before.Article);
    }
  });
}

test('transaction retry reloads verified source identity and reuses a concurrently created missing edition', async context => {
  const { state, source, requestedId, missingLanguage } = install(context, { requestedLanguage: 'hi' });
  const initial = structuredClone(state.rows);
  const startSession = mongoose.startSession;
  const concurrentId = '507f1f77bcf86cd799439888';
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await startSession();
    session.withTransaction = async work => {
      await work();
      state.rows = structuredClone(initial);
      const currentSource = state.rows.News.find(doc => doc._id === source._id);
      currentSource.translationGroupId = 'concurrent-known-group';
      currentSource.translationKey = 'concurrent-known-group';
      state.rows.News.push({
        ...structuredClone(currentSource), _id: concurrentId, language: missingLanguage, lang: missingLanguage,
        originalLang: missingLanguage, sourceArticleId: source._id, slug: currentSource.slugs[missingLanguage],
        status: 'draft', publishedAt: null, workflowStage: 'DRAFT', title: 'Concurrent edition',
      });
      await work();
      session.committed = true;
    };
    return session;
  });
  const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.created, {});
  assert.deepEqual(response.body.updated, {});
  assert.equal(response.body.skipped[missingLanguage].id, concurrentId);
  assert.equal(response.body.translationGroupId, 'concurrent-known-group');
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.News.filter(doc => doc.language === missingLanguage).length, 1);
  assert.equal(state.rows.TranslationJob.length, 1);
  assert.equal(state.rows.TranslationJob[0].newsId, source._id);
  assert.deepEqual(state.rows.Article, initial.Article);
});

for (const reason of ['foreign-owned sibling', 'published sibling', 'published sibling copy']) {
  test(`keyless source cannot initialize its key across an indirectly linked ${reason}`, async context => {
    const ownsDrafts = reason === 'foreign-owned sibling';
    const role = ownsDrafts ? 'reporter' : 'editor';
    const staff = {
      specialRightsConfigured: true, specialRightsOverride: ownsDrafts ? [] : ['news_edit'],
      moduleAccessStates: { manageNews: ownsDrafts ? 'disabled' : 'enabled', addNews: 'enabled', draftDesk: 'enabled' },
    };
    const { state, source, heldLanguage, missingLanguage, translate } = install(context, {
      layout: 'child-key-only', status: 'draft', staff,
    });
    const held = state.rows.News.find(doc => doc.language === heldLanguage);
    const sibling = {
      ...structuredClone(held), _id: '507f1f77bcf86cd799439666',
      language: missingLanguage, lang: missingLanguage, originalLang: missingLanguage,
      slug: held.slugs[missingLanguage], createdByUserId: ownsDrafts ? actorId('editor') : actorId('reporter'),
    };
    delete sibling.sourceArticleId;
    delete sibling.translationMeta;
    if (reason === 'published sibling') {
      sibling.status = 'published';
      sibling.workflowStage = 'PUBLISHED';
      sibling.publishedAt = new Date('2026-09-01T08:00:00.000Z');
    }
    state.rows.News.push(sibling);
    if (reason === 'published sibling copy') state.rows.Article.push({
      ...structuredClone(sibling), _id: sibling._id.replace(/^5/, '6'),
      sourceNewsId: sibling._id, sourceArticleId: source._id,
      status: 'published', publishedAt: new Date('2026-09-01T08:00:00.000Z'),
    });
    const before = state.content();
    const response = await state.request('post', paths[0](source._id), { targetLanguages: LANGUAGES }, role);
    assertBlocked(state, before, response, translate, 403);
  });
}

for (const field of ['sourceArticleId', 'translationMeta.sourceArticleId']) for (const value of [false, 0]) {
  test(`keyed standalone original cannot bypass invalid ${field}=${value}`, async context => {
    const { state, source, translate } = install(context, { layout: 'modern' });
    state.rows.News = [source];
    state.rows.Article = state.rows.Article.filter(doc => doc.sourceNewsId === source._id);
    delete source.sourceArticleId;
    if (field === 'sourceArticleId') source.sourceArticleId = value;
    else source.translationMeta = { sourceArticleId: value };
    const before = state.content();
    const response = await state.request('post', paths[0](source._id), { targetLanguages: LANGUAGES });
    assertBlocked(state, before, response, translate);
  });
}

for (const markers of [
  { machineGenerated: true },
  { humanEdited: true },
  { translatedByProvider: 'google_translate' },
  { translationJobId: '707f1f77bcf86cd799439111' },
  { translationMeta: { targetLanguage: 'gu' } },
  { translationMeta: { machineGenerated: true } },
  { translationMeta: { humanEdited: true } },
]) {
  test(`unanchored standalone translation markers require source review: ${JSON.stringify(markers)}`, async context => {
    const { state, source, translate } = install(context, { layout: 'modern' });
    state.rows.News = [source];
    state.rows.Article = state.rows.Article.filter(doc => doc.sourceNewsId === source._id);
    delete source.sourceArticleId;
    Object.assign(source, markers);
    const before = state.content();
    const response = await state.request('post', paths[0](source._id), { targetLanguages: LANGUAGES });
    assertBlocked(state, before, response, translate);
  });
}

test('legacy nested human-edit flag prevents unconfirmed overwrite while generating the missing edition', async context => {
  const { state, requestedId, heldLanguage, missingLanguage } = install(context);
  const held = state.rows.News.find(doc => doc.language === heldLanguage);
  delete held.humanEdited;
  const before = withoutGuardFields(held);
  const publicBefore = structuredClone(state.rows.Article);
  const response = await state.request('post', paths[0](requestedId), { targetLanguages: LANGUAGES, overwrite: true });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body.updated, {});
  assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
  assert.equal(response.body.skipped[heldLanguage].reason, 'human_edited');
  assert.deepEqual(withoutGuardFields(state.rows.News.find(doc => doc._id === held._id)), before);
  assert.deepEqual(state.rows.Article, publicBefore);
});

test('legacy compatibility: canonical-only shared copy retains its URL, dates and cached languages', async context => {
  const { state, source, heldLanguage, missingLanguage } = install(context);
  state.rows.Article = state.rows.Article.filter(copy => copy.sourceNewsId === source._id);
  const copy = state.rows.Article[0];
  delete copy.sourceNewsId;
  copy.slug = 'historical-public-url';
  copy.slugs = { [source.language]: copy.slug };
  copy.publishedAt = new Date('2026-08-15T08:00:00.000Z');
  copy.translations[missingLanguage] = {
    title: 'Existing cached headline', summary: 'Existing cached summary', content: '<p>Existing cached body</p>',
  };
  const before = state.content();
  castIdentityQueries(context);
  const response = await state.request('post', paths[1](source._id), { targetLanguages: [missingLanguage] });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
  assert.deepEqual(response.body.targetLanguages, [missingLanguage]);
  assert.deepEqual(state.rows.Article, before.Article);
  for (const language of [source.language, heldLanguage]) {
    assert.deepEqual(
      withoutGuardFields(state.rows.News.find(doc => doc.language === language), language === source.language),
      withoutGuardFields(before.News.find(doc => doc.language === language), language === source.language),
    );
  }
  const created = state.rows.News.find(doc => doc.language === missingLanguage);
  assert.equal(created.status, 'draft');
  assert.equal(created.publishedAt, null);
  assert.equal(created.sourceArticleId, source._id);
});

test('legacy compatibility: padded public owner accepted by strict identity validation remains supported', async context => {
  const { state, source, requestedId, heldLanguage, missingLanguage } = install(context, { requestedLanguage: 'hi' });
  const copy = state.rows.Article.find(doc => doc.language === heldLanguage);
  copy.sourceNewsId = legacyId(copy.sourceNewsId);
  castIdentityQueries(context);
  const { groupStatus } = await loadTranslationGroupStatus(copy, { publicCopy: true });
  assert.equal(groupStatus.sourceArticleId, source._id);
  const before = structuredClone(state.rows.Article);
  const response = await state.request('post', paths[0](requestedId), { targetLanguages: [missingLanguage] });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
  assert.deepEqual(state.rows.Article, before);
});

for (const field of ['sourceNewsId', 'sourceArticleId', 'translationMeta.sourceArticleId']) {
  test(`legacy compatibility: unkeyed ${field} copy conflicts are discovered before writes`, async context => {
    const { state, source, missingLanguage, translate } = install(context);
    const copy = state.rows.Article.find(doc => doc.language === source.language);
    state.rows.Article = [copy];
    delete copy.sourceNewsId;
    delete copy.sourceArticleId;
    delete copy.translationKey;
    delete copy.translationGroupId;
    if (field === 'translationMeta.sourceArticleId') copy.translationMeta = { sourceArticleId: legacyId(source._id) };
    else copy[field] = legacyId(source._id);
    copy.sourceLanguage = missingLanguage;
    castIdentityQueries(context);
    const before = state.content();
    const response = await state.request('post', paths[0](source._id), { targetLanguages: [missingLanguage] });
    assertBlocked(state, before, response, translate);
  });
}

for (const targetLanguage of LANGUAGES) for (const layout of ['modern', 'keyless']) {
  test(`legacy compatibility: ${layout} padded CMS references reuse the human-edited ${targetLanguage} edition`, async context => {
    const sourceLanguage = LANGUAGES.find(lang => lang !== targetLanguage);
    const { state, source, translate } = install(context, { sourceLanguage, requestedLanguage: targetLanguage, layout });
    state.rows.Article = [];
    const held = state.rows.News.find(doc => doc.language === targetLanguage);
    held.sourceArticleId = legacyId(source._id);
    held.translationMeta.sourceArticleId = held.sourceArticleId;
    delete held.humanEdited;
    held.slug = `legacy-human-${targetLanguage}`;
    held.slugs = { [targetLanguage]: held.slug };
    const before = withoutGuardFields(held);
    const beforeSource = withoutGuardFields(source, true);
    castIdentityQueries(context);
    for (const path of paths) {
      const response = await state.request('post', path(source._id), { targetLanguages: [targetLanguage], overwrite: true });
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(response.body.created, {});
      assert.deepEqual(response.body.updated, {});
      assert.deepEqual(response.body.targetLanguages, [targetLanguage]);
      assert.equal(response.body.skipped[targetLanguage].reason, 'human_edited');
      assert.equal(response.body.skipped[targetLanguage].id, held._id);
      assert.equal(state.rows.News.length, 2);
      assert.equal(state.rows.News.filter(doc => doc.language === targetLanguage).length, 1);
      assert.deepEqual(withoutGuardFields(state.rows.News.find(doc => doc._id === held._id)), before);
      assert.deepEqual(withoutGuardFields(state.rows.News.find(doc => doc._id === source._id), true), beforeSource);
    }
    assert.equal(translate.mock.callCount(), 0);
    const status = await state.request('get', `/api/articles/${source._id}/translation-status`);
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.data.perLang[targetLanguage].articleId, held._id);
  });
}

for (const [role, ownsDrafts] of [['editor', false], ['reporter', true]]) {
  test(`legacy compatibility: ${role} generates only the selected missing draft beside a padded human edition`, async context => {
    const staff = {
      specialRightsConfigured: true, specialRightsOverride: ownsDrafts ? [] : ['news_edit'],
      moduleAccessStates: { manageNews: ownsDrafts ? 'disabled' : 'enabled', addNews: 'enabled', draftDesk: 'enabled' },
    };
    const { state, source, heldLanguage, missingLanguage, translate } = install(context, { status: 'draft', staff });
    state.rows.Article = [];
    const held = state.rows.News.find(doc => doc.language === heldLanguage);
    held.sourceArticleId = legacyId(source._id);
    held.translationMeta.sourceArticleId = held.sourceArticleId;
    const before = withoutGuardFields(held);
    castIdentityQueries(context);
    const response = await state.request('post', paths[1](held._id), { targetLanguages: [missingLanguage] }, role);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
    assert.deepEqual(response.body.targetLanguages, [missingLanguage]);
    assert.ok(translate.mock.calls.every(call => call.arguments[2] === missingLanguage));
    assert.deepEqual(withoutGuardFields(state.rows.News.find(doc => doc._id === held._id)), before);
    assert.equal(state.rows.News.length, 3);
    assert.ok(state.rows.News.every(doc => doc.status === 'draft' && doc.publishedAt === null));
  });
}

for (const reason of ['foreign-owned edition', 'published edition']) {
  test(`legacy compatibility: padded discovery cannot hide a ${reason} from Staff authorization`, async context => {
    const ownsDrafts = reason === 'foreign-owned edition';
    const staff = {
      specialRightsConfigured: true, specialRightsOverride: ownsDrafts ? [] : ['news_edit'],
      moduleAccessStates: { manageNews: ownsDrafts ? 'disabled' : 'enabled', addNews: 'enabled', draftDesk: 'enabled' },
    };
    const { state, source, heldLanguage, missingLanguage, translate } = install(context, { status: 'draft', staff });
    state.rows.Article = [];
    const held = state.rows.News.find(doc => doc.language === heldLanguage);
    held.sourceArticleId = legacyId(source._id);
    held.translationMeta.sourceArticleId = held.sourceArticleId;
    if (ownsDrafts) held.createdByUserId = actorId('editor');
    else {
      held.status = 'published';
      held.publishedAt = new Date('2026-09-01T08:00:00.000Z');
      held.workflowStage = 'PUBLISHED';
    }
    castIdentityQueries(context);
    const before = state.content();
    const response = await state.request('post', paths[0](source._id), {
      targetLanguages: [missingLanguage],
    }, ownsDrafts ? 'reporter' : 'editor');
    assertBlocked(state, before, response, translate, 403);
  });
}

for (const path of paths) for (const role of ['founder', 'editor']) {
  test(`legacy compatibility: ${role} human-overwrite confirmation on ${path(':id')} retains its authority`, async context => {
    const { state, source, heldLanguage, translate } = install(context, { status: 'draft', layout: 'modern' });
    const held = state.rows.News.find(doc => doc.language === heldLanguage);
    const before = state.content();
    castIdentityQueries(context);
    const response = await state.request('post', path(source._id), {
      targetLanguages: [heldLanguage], overwrite: true, confirmOverwriteHumanEdited: true,
    }, role);
    if (role !== 'founder') return assertBlocked(state, before, response, translate, 403);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.created, {});
    assert.deepEqual(Object.keys(response.body.updated), [heldLanguage]);
    const after = state.rows.News.find(doc => doc._id === held._id);
    const previous = before.News.find(doc => doc._id === held._id);
    for (const field of ['_id', 'slug', 'slugs', 'createdAt', 'publishedAt', 'status']) {
      assert.deepEqual(after[field], previous[field], field);
    }
    assert.deepEqual(state.rows.Article, before.Article);
  });
}

test('legacy compatibility: verified legacy member exclusion does not bypass foreign slug conflicts', async context => {
  const { state, source, heldLanguage, missingLanguage } = install(context);
  state.rows.Article = [];
  const held = state.rows.News.find(doc => doc.language === heldLanguage);
  held.sourceArticleId = legacyId(source._id);
  held.translationMeta.sourceArticleId = held.sourceArticleId;
  const foreignId = '507f1f77bcf86cd799439999';
  const generatedSlug = slugifyLocalizedTitle(`${missingLanguage} ${source.title}`, missingLanguage);
  state.rows.News.push({
    ...structuredClone(source), _id: foreignId, sourceArticleId: foreignId,
    language: missingLanguage, lang: missingLanguage, originalLang: missingLanguage, sourceLanguage: missingLanguage,
    translationGroupId: 'foreign-story', translationKey: 'foreign-story',
    slug: generatedSlug, slugs: { [missingLanguage]: generatedSlug },
  });
  castIdentityQueries(context);
  const before = state.content();
  const response = await state.request('post', paths[0](source._id), { targetLanguages: [missingLanguage] });
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.code, 'SLUG_CONFLICT');
  assert.deepEqual(state.content(), before);
  assert.deepEqual(state.invalidations, []);
});

for (const foreign of [false, true]) {
  test(`legacy compatibility: own-draft generation ${foreign ? 'rejects foreign' : 'accepts verified'} padded public owners`, async context => {
    const staff = {
      specialRightsConfigured: true, specialRightsOverride: [],
      moduleAccessStates: { manageNews: 'disabled', addNews: 'enabled', draftDesk: 'enabled' },
    };
    const { state, source, missingLanguage, translate } = install(context, { status: 'draft', layout: 'modern', staff });
    const copy = state.rows.Article[0];
    copy.sourceNewsId = legacyId(foreign ? '507f1f77bcf86cd799439999' : copy.sourceNewsId);
    castIdentityQueries(context);
    const before = state.content();
    const response = await state.request('post', paths[0](source._id), { targetLanguages: [missingLanguage] }, 'reporter');
    if (foreign) return assertBlocked(state, before, response, translate, 403);
    assert.equal(response.status, 200, response.text);
    assert.deepEqual(Object.keys(response.body.created), [missingLanguage]);
    assert.deepEqual(state.rows.Article, before.Article);
  });
}

test('legacy compatibility: Staff identity guards retain the exact stored legacy source reference', async context => {
  const staff = {
    specialRightsConfigured: true, specialRightsOverride: ['news_edit'],
    moduleAccessStates: { manageNews: 'enabled' },
  };
  const { state, source, heldLanguage, missingLanguage, translate } = install(context, { status: 'draft', staff });
  state.rows.Article = [];
  const held = state.rows.News.find(doc => doc.language === heldLanguage);
  held.sourceArticleId = legacyId(source._id);
  held.translationMeta.sourceArticleId = held.sourceArticleId;
  castIdentityQueries(context);
  const updateMany = News.updateMany;
  context.mock.method(News, 'updateMany', (filter, update, options) => {
    if (update.$inc?.syncVersion) {
      state.rows.News.find(doc => doc._id === held._id).sourceArticleId = ` ${source._id} `;
    }
    return updateMany.call(News, filter, update, options);
  });
  const before = state.content();
  const response = await state.request('post', paths[0](source._id), { targetLanguages: [missingLanguage] }, 'editor');
  assert.equal(response.status, 409, response.text);
  assert.equal(response.body.code, 'TRANSLATION_SOURCE_CHANGED');
  assert.deepEqual(state.content(), before);
  assert.equal(translate.mock.callCount(), 0);
  assert.deepEqual(state.invalidations, []);
});
