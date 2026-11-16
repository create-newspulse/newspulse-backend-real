require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const mongoose = require('mongoose');
const News = require('../models/News');
const google = require('../services/googleTranslationService');
const { getStoryKeys } = require('../services/articleSlugUniqueness.service');
const { issueNewsPublishGrant } = require('../lib/newsPublishGrant');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

const LANGUAGES = ['gu', 'hi', 'en'];
const LAYOUTS = ['modern', 'keyless', 'placeholders', 'source-key-only', 'child-key-only'];
const CONTENT_MODELS = ['News', 'Article', 'TranslationJob', 'PublicConfigVersion'];
const WRITES = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
const actorId = role => crypto.createHash('sha256').update(role).digest('hex').slice(0, 24);

function publishStaff(role = 'editor', rights = ['news_edit', 'news_publish']) {
  return {
    specialRightsConfigured: true,
    specialRightsOverride: rights,
    moduleAccessStates: role === 'reporter'
      ? { manageNews: 'disabled', addNews: 'enabled', draftDesk: 'enabled' }
      : { manageNews: 'enabled', addNews: 'disabled', draftDesk: 'disabled' },
    newsPublishGrant: issueNewsPublishGrant({
      _authUserDoc: { _id: actorId('founder'), role: 'founder' },
      admin: { id: actorId('founder') },
    }, actorId(role)),
  };
}

function install(context, {
  sourceLanguage = 'gu', requestedLanguage = 'hi', layout = 'modern', mode = 'provider',
  status = 'draft', staff, copies = status === 'published',
} = {}) {
  const state = installEditorialFixture(context, {
    staff, modulePolicies: { manageNews: 'available', addNews: 'available', draftDesk: 'available' },
  });
  if (staff) state.token('founder');
  seedGroup(state, { status, copies });
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
      doc.title = `Human-edited ${heldLanguage} headline`;
      doc.content = `<p>Human-edited ${heldLanguage} body</p>`;
      doc.humanEdited = true;
      doc.translationReviewStatus = 'reviewed';
      doc.translationMeta = {
        sourceArticleId: source._id, sourceLanguage, targetLanguage: heldLanguage, humanEdited: true,
      };
      doc.coverImage = { url: `/uploads/human-${heldLanguage}.jpg`, alt: 'Human cover' };
      doc.coverImageUrl = doc.coverImage.url;
    }
    if (layout === 'keyless'
      || (layout === 'source-key-only' && doc.language !== sourceLanguage)
      || (layout === 'child-key-only' && doc.language === sourceLanguage)) {
      delete doc.translationGroupId;
      delete doc.translationKey;
    } else if (layout === 'placeholders') {
      doc.translationGroupId = 'null';
      doc.translationKey = 'undefined';
    }
  }
  const requested = state.rows.News.find(doc => doc.language === requestedLanguage);
  const bucket = { title: `Cached ${missingLanguage} title`, summary: 'Cached summary', content: '<p>Cached body</p>' };
  if (mode === 'cached') requested.translations[missingLanguage] = bucket;
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  const translate = context.mock.method(google, 'translateText', async (text, from, to) => {
    assert.notEqual(mode, 'cached', 'A complete requested-edition cache must not invoke the provider');
    return { ok: true, text: `${to} ${text}` };
  });
  context.mock.method(google, 'detectLanguage', () => assert.fail('Publication must not guess the source language'));
  state.content = () => Object.fromEntries(CONTENT_MODELS.map(name => [name, structuredClone(state.rows[name])]));
  state.writes = () => state.calls.filter(call => CONTENT_MODELS.includes(call.name) && WRITES.has(call.method));
  return {
    state, source: structuredClone(source), requestedId: requested._id, sourceLanguage, requestedLanguage,
    heldLanguage, missingLanguage, mode, layout, bucket, translate,
    originals: structuredClone(state.rows.News), copies: structuredClone(state.rows.Article),
  };
}

async function assertPublished(setup, response, { group = false } = {}) {
  const { state, source, requestedId, sourceLanguage, originals, copies, layout } = setup;
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.ok, true);
  const requested = group ? response.body.articles.find(doc => doc._id === requestedId) : response.body.article;
  assert.equal(requested._id, requestedId, 'The response must still describe the requested edition');
  if (!group) assert.deepEqual(response.body.data.article, response.body.article);
  assert.deepEqual([...response.body.publishedLanguages].sort(), ['en', 'gu', 'hi']);
  assert.deepEqual(response.body.publicSync, { ok: true, failedArticleIds: [] });
  const key = response.body.translationGroupId;
  if (['keyless', 'placeholders'].includes(layout)) assert.match(key, /^[a-f0-9]{24}$/);
  else assert.equal(key, 'story-test-group');
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.Article.length, 3);
  assert.deepEqual(state.rows.News.map(doc => doc.language).sort(), ['en', 'gu', 'hi']);
  assert.deepEqual([...new Set(state.rows.News.flatMap(getStoryKeys))], [key]);
  const savedSource = state.rows.News.find(doc => doc._id === source._id);
  assert.equal(savedSource.translationGroupId, key);
  assert.equal(savedSource.translationKey, key);
  for (const doc of state.rows.News) {
    assert.equal(doc.sourceArticleId, source._id);
    assert.equal(doc.sourceLanguage, sourceLanguage);
    if (doc.translationMeta?.sourceArticleId) assert.equal(doc.translationMeta.sourceArticleId, source._id);
    assert.equal(doc.status, 'published');
    assert.ok(doc.publishedAt);
    const copy = state.rows.Article.find(item => item.sourceNewsId === doc._id);
    assert.ok(copy, `Missing native public copy for ${doc.language}`);
    assert.equal(copy.sourceArticleId, source._id);
    assert.equal(copy.title, doc.title);
    assert.equal(copy.content, doc.content);
    assert.equal(copy.status, 'published');
    const oldCopy = copies.find(item => item.sourceNewsId === doc._id);
    if (oldCopy) {
      assert.equal(copy._id, oldCopy._id);
      assert.equal(new Date(copy.publishedAt).getTime(), new Date(oldCopy.publishedAt).getTime());
    }
    const old = originals.find(item => item._id === doc._id);
    if (old) {
      for (const field of ['title', 'description', 'content', 'slug', 'slugs', 'coverImage', 'coverImageUrl', 'humanEdited', 'translationMeta']) {
        assert.deepEqual(doc[field], old[field], `${doc.language}: preserve ${field}`);
      }
      if (old.publishedAt) assert.equal(new Date(doc.publishedAt).getTime(), new Date(old.publishedAt).getTime());
      if (doc._id !== source._id) {
        assert.equal(doc.translationGroupId, doc._id === requestedId ? key : old.translationGroupId);
        assert.equal(doc.translationKey, doc._id === requestedId ? key : old.translationKey);
      }
    }
    const status = await state.request('get', `/api/articles/${doc._id}/translation-status`);
    assert.equal(status.status, 200, status.text);
    assert.equal(status.body.data.id, doc._id);
    assert.equal(status.body.data.languageStates.sourceArticleId, source._id);
    assert.equal(status.body.data.baseLang, sourceLanguage);
    assert.equal(status.body.data.translationGroupKey, key);
    for (const lang of LANGUAGES) {
      const entry = status.body.data.perLang[lang];
      assert.equal(entry.articleId, state.rows.News.find(item => item.language === lang)._id);
      assert.equal(entry.presence, lang === sourceLanguage ? 'source' : 'translated');
    }
    const detail = await state.request('get', `/api/admin/articles/${copy._id}`);
    assert.equal(detail.status, 200, detail.text);
    assert.equal(detail.body.translationGroupStatus.sourceArticleId, source._id);
  }
}

function assertBlocked(setup, before, response, expectedStatus = 409) {
  const { state, translate } = setup;
  assert.equal(response.status, expectedStatus, response.text);
  assert.equal(response.body.ok, false);
  if (expectedStatus === 409) assert.match(response.body.message, /Founder review/);
  assert.deepEqual(state.content(), before);
  assert.equal(state.writes().length, 0);
  assert.equal(translate.mock.callCount(), 0);
  assert.equal(state.invalidations.length, 0);
}

for (const mode of ['cached', 'provider']) for (const layout of LAYOUTS) {
  for (const sourceLanguage of LANGUAGES) for (const requestedLanguage of LANGUAGES) {
    test(`${mode}/${layout}: ${sourceLanguage} source publishes through ${requestedLanguage}`, async context => {
      const setup = install(context, { mode, layout, sourceLanguage, requestedLanguage });
      const { state, source, requestedId, missingLanguage, bucket, translate } = setup;
      const response = await state.request('post', `/api/articles/${requestedId}/publish`);
      await assertPublished(setup, response);
      const created = state.rows.News.find(doc => doc.language === missingLanguage);
      assert.equal(created.title, mode === 'cached' ? bucket.title : `${missingLanguage} ${source.title}`);
      assert.equal(created.content, mode === 'cached' ? bucket.content : `${missingLanguage} ${source.content}`);
      assert.equal(created.translationMeta.sourceArticleId, source._id);
      assert.equal(created.translationMeta.sourceLanguage, sourceLanguage);
      assert.equal(created.createdByUserId, actorId('founder'));
      if (mode === 'provider') {
        assert.ok(translate.mock.callCount() > 0);
        for (const call of translate.mock.calls) {
          assert.equal(call.arguments[1], sourceLanguage);
          assert.equal(call.arguments[2], missingLanguage);
        }
        assert.equal(state.rows.TranslationJob[0].newsId, source._id);
      } else assert.equal(translate.mock.callCount(), 0);
      assert.equal(state.rows.PushHistory[0].articleId, requestedId);
      assert.equal(state.transactions.length, 1);
      assert.ok(state.transactions[0].committed && state.transactions[0].ended);
      assert.ok(state.writes().filter(call => call.name !== 'PublicConfigVersion')
        .every(call => call.options?.session === state.transactions[0]));
      const beforeRepeat = state.rows.News.map(doc => ({ id: doc._id, publishedAt: doc.publishedAt }));
      const publicIds = state.rows.Article.map(doc => doc._id);
      const providerCalls = translate.mock.callCount();
      const repeat = await state.request('post', `/api/articles/${requestedId}/publish`);
      await assertPublished(setup, repeat);
      assert.deepEqual(state.rows.News.map(doc => ({ id: doc._id, publishedAt: doc.publishedAt })), beforeRepeat);
      assert.deepEqual(state.rows.Article.map(doc => doc._id), publicIds);
      assert.equal(translate.mock.callCount(), providerCalls);
      assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'create').length, 1);
    });
  }
}

for (const mode of ['cached', 'provider']) for (const sourceLanguage of LANGUAGES) {
  for (const requestedLanguage of LANGUAGES) {
    test(`${mode}: ${sourceLanguage} shared metadata is canonical when publishing through ${requestedLanguage}`, async context => {
      const setup = install(context, { mode, sourceLanguage, requestedLanguage, status: 'published' });
      const { state, requestedId, missingLanguage } = setup;
      const source = state.rows.News.find(doc => doc._id === setup.source._id);
      const child = state.rows.News.find(doc => doc._id !== source._id);
      Object.assign(source, {
        category: 'national', editorialType: 'special_story', track: 'campus-buzz', topic: 'canonical-topic',
        tags: ['canonical-tag'], stateTags: ['gujarat'], stateNames: ['Gujarat'],
        geo: { state: 'gujarat', district: 'ahmedabad', city: 'ahmedabad' },
        location: { state: 'Gujarat', district: 'Ahmedabad', city: 'Ahmedabad' },
        externalUrls: ['https://example.invalid/canonical'], embeds: ['canonical-embed'], gallery: ['canonical-image'],
        seo: { canonicalUrl: 'https://example.invalid/canonical' }, authorByline: { enabled: false },
        sponsorName: 'Canonical sponsor', sponsorDisclosure: 'Canonical disclosure', sponsorCtaText: 'Canonical CTA',
      });
      Object.assign(child, {
        category: 'business', editorialType: 'editorial', track: 'student-voices', topic: 'child-topic',
        tags: ['child-tag'], stateTags: ['maharashtra'], stateNames: ['Maharashtra'],
        geo: { state: 'maharashtra', district: 'pune', city: 'pune' },
        location: { state: 'Maharashtra', district: 'Pune', city: 'Pune' },
        externalUrls: ['https://example.invalid/child'], embeds: ['child-embed'], gallery: ['child-image'],
        seo: { canonicalUrl: 'https://example.invalid/child' }, sponsorName: 'Child sponsor',
        sponsorDisclosure: 'Child disclosure', sponsorCtaText: 'Child CTA',
      });
      setup.source = structuredClone(source);
      setup.originals = structuredClone(state.rows.News);
      setup.copies = structuredClone(state.rows.Article);
      const response = await state.request('post', `/api/articles/${requestedId}/publish`);
      await assertPublished(setup, response);
      const created = state.rows.News.find(doc => doc.language === missingLanguage);
      for (const field of ['category', 'editorialType', 'track', 'topic', 'tags', 'stateTags', 'stateNames', 'geo',
        'location', 'externalUrls', 'embeds', 'gallery', 'authorByline', 'sponsorName', 'sponsorDisclosure', 'sponsorCtaText']) {
        assert.deepEqual(created[field], source[field], `new edition must use canonical ${field}`);
      }
      assert.equal(created.seo.canonicalUrl, source.seo.canonicalUrl);
      assert.equal(created.coverImageUrl, source.coverImageUrl);
      const copy = state.rows.Article.find(doc => doc.sourceNewsId === created._id);
      assert.equal(copy.category, source.category);
      assert.deepEqual(copy.geo, source.geo);
      assert.deepEqual(copy.stateTags, source.stateTags);
      assert.deepEqual(copy.stateNames, source.stateNames);
      assert.equal(copy.seo.canonicalUrl, source.seo.canonicalUrl);
      assert.equal(created.title, mode === 'cached' ? setup.bucket.title : `${missingLanguage} ${source.title}`);
      assert.equal(created.description, mode === 'cached' ? setup.bucket.summary : `${missingLanguage} ${source.description}`);
      assert.equal(created.content, mode === 'cached' ? setup.bucket.content : `${missingLanguage} ${source.content}`);
    });
  }
}

for (const mode of ['cached', 'provider']) for (const sourceLanguage of LANGUAGES) {
  test(`${mode}: ${sourceLanguage} published story retains dates, public IDs, human edits and media`, async context => {
    const requestedLanguage = LANGUAGES.find(lang => lang !== sourceLanguage);
    const setup = install(context, { mode, sourceLanguage, requestedLanguage, status: 'published', layout: 'child-key-only' });
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    await assertPublished(setup, response);
  });
}

for (const [method, action] of [['post', 'publish-group'], ['post', 'publish-all-languages'], ['put', ''], ['patch', '']]) {
  for (const mode of ['cached', 'provider']) {
    test(`${method} ${action || 'status'} preserves the requested child (${mode})`, async context => {
      const setup = install(context, { mode, layout: 'child-key-only' });
      const response = await setup.state.request(method,
        `/api/articles/${setup.requestedId}${action ? `/${action}` : ''}`, action ? {} : { status: 'published' });
      await assertPublished(setup, response, { group: Boolean(action) });
    });
  }
}

const invalidIdentities = [
  ['conflicting source links', setup => { setup.state.rows.News[0].sourceArticleId = setup.requestedId; }],
  ['conflicting nested source', setup => { setup.state.rows.News[0].translationMeta = { sourceArticleId: setup.requestedId }; }],
  ['missing canonical source', setup => { setup.state.rows.News = setup.state.rows.News.filter(doc => doc._id !== setup.source._id); }],
  ['conflicting group aliases', setup => { setup.state.rows.News[0].translationKey = 'different-real-group'; }],
  ['foreign child key', setup => {
    const child = setup.state.rows.News.find(doc => doc._id === setup.requestedId);
    child.translationKey = child.translationGroupId = 'different-real-group';
  }],
  ['conflicting native languages', setup => { setup.state.rows.News[0].lang = setup.missingLanguage; }],
  ['conflicting source language', setup => { setup.state.rows.News[0].sourceLanguage = setup.missingLanguage; }],
  ['invalid metadata', setup => { setup.state.rows.News[0].translationMeta = []; }],
  ['duplicate native language', setup => {
    const child = setup.state.rows.News.find(doc => doc._id === setup.requestedId);
    setup.state.rows.News.push({ ...structuredClone(child), _id: '707f1f77bcf86cd79943a002', slug: 'duplicate-edition' });
  }],
  ['unanchored group', setup => {
    for (const doc of setup.state.rows.News) {
      delete doc.sourceArticleId;
      delete doc.translationMeta;
    }
  }],
];

for (const [label, mutate] of invalidIdentities) for (const mode of ['cached', 'provider']) {
  test(`${mode}: ${label} fails before writes or provider calls`, async context => {
    const setup = install(context, { mode });
    mutate(setup);
    const before = setup.state.content();
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    assertBlocked(setup, before, response);
  });
}

for (const field of ['sourceArticleId', 'sourceLanguage', 'translationKey']) {
  test(`conflicting linked public ${field} fails before publication`, async context => {
    const setup = install(context, { status: 'published' });
    const copy = setup.state.rows.Article.find(doc => doc.sourceNewsId === setup.requestedId);
    copy[field] = field === 'sourceArticleId' ? setup.requestedId : field === 'sourceLanguage' ? 'en' : 'foreign-group';
    const before = setup.state.content();
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    assertBlocked(setup, before, response);
  });
}

for (const mode of ['cached', 'provider']) {
  test(`${mode}: standalone publication rejects a conflicting linked public copy before generation`, async context => {
    const setup = install(context, { mode, sourceLanguage: 'en', requestedLanguage: 'en', status: 'published' });
    const { state, source, requestedId } = setup;
    state.rows.News = state.rows.News.filter(doc => doc._id === source._id);
    state.rows.Article = state.rows.Article.filter(doc => doc.sourceNewsId === source._id);
    delete state.rows.News[0].sourceArticleId;
    state.rows.Article[0].sourceArticleId = '507f1f77bcf86cd799439999';
    const before = state.content();
    const response = await state.request('post', `/api/articles/${requestedId}/publish`);
    assertBlocked(setup, before, response);
  });
}

for (const role of ['editor', 'reporter']) for (const mode of ['cached', 'provider']) {
  test(`${role} retains verified Publish rights through a child (${mode})`, async context => {
    const setup = install(context, {
      mode, layout: 'child-key-only', staff: publishStaff(role, role === 'editor' ? ['news_edit', 'news_publish'] : ['news_publish']),
    });
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`, {}, role);
    await assertPublished(setup, response);
  });
}

for (const [label, staff, mutate] of [
  ['missing Founder grant', { specialRightsConfigured: true, specialRightsOverride: ['news_edit', 'news_publish'] }, () => {}],
  ['foreign canonical owner', publishStaff('reporter', ['news_publish']), setup => {
    setup.state.rows.News.find(doc => doc._id === setup.source._id).createdByUserId = actorId('editor');
  }],
  ['protected canonical source', publishStaff('reporter', ['news_publish']), setup => {
    setup.state.rows.News.find(doc => doc._id === setup.source._id).locked = true;
  }],
]) {
  test(`child resolution does not bypass ${label}`, async context => {
    const setup = install(context, { layout: 'child-key-only', staff });
    mutate(setup);
    const before = setup.state.content();
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`, {}, 'reporter');
    assertBlocked(setup, before, response, 403);
  });
}

function retryOnce(context, state, beforeRetry) {
  const startSession = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await startSession();
    const transact = session.withTransaction.bind(session);
    session.withTransaction = async work => {
      await assert.rejects(transact(async () => {
        await work();
        throw new Error('Synthetic publication retry');
      }), /Synthetic publication retry/);
      delete session.aborted;
      await beforeRetry();
      return transact(work);
    };
    return session;
  });
}

for (const mode of ['cached', 'provider']) {
  test(`${mode}: transaction retry adopts a concurrently created human edition without duplicates`, async context => {
    const setup = install(context, { mode, layout: 'keyless' });
    const { state, source, missingLanguage, requestedId, translate } = setup;
    const concurrentId = '707f1f77bcf86cd799439888';
    const concurrentKey = '707f1f77bcf86cd799439889';
    let callsBeforeRetry;
    retryOnce(context, state, () => {
      callsBeforeRetry = translate.mock.callCount();
      state.rows.News.push({
        ...structuredClone(source), _id: concurrentId, language: missingLanguage, lang: missingLanguage,
        originalLang: missingLanguage, slug: source.slugs[missingLanguage],
        translationGroupId: concurrentKey, translationKey: concurrentKey,
        title: 'Concurrent human edition', content: '<p>Concurrent human body</p>', humanEdited: true,
        translationMeta: { sourceArticleId: source._id, sourceLanguage: setup.sourceLanguage, targetLanguage: missingLanguage, humanEdited: true },
      });
    });
    const response = await state.request('post', `/api/articles/${requestedId}/publish`);
    await assertPublished(setup, response);
    assert.equal(response.body.translationGroupId, concurrentKey);
    const edition = state.rows.News.find(doc => doc.language === missingLanguage);
    assert.equal(edition._id, concurrentId);
    assert.equal(edition.title, 'Concurrent human edition');
    assert.equal(edition.content, '<p>Concurrent human body</p>');
    assert.equal(translate.mock.callCount(), callsBeforeRetry);
    assert.equal(state.calls.filter(call => call.name === 'News' && call.method === 'create').length, 1);
    assert.equal(state.rows.TranslationJob.length, 0, 'The aborted translation job must not survive');
    assert.equal(state.rows.PushHistory.length, 1);
    assert.equal(state.invalidations.length, 1, 'Only the committed attempt may revalidate');
    assert.ok(state.transactions[0].committed && !state.transactions[0].aborted && state.transactions[0].ended);
  });

  for (const failure of ['News.create', 'Article.findOneAndUpdate', ...(mode === 'provider' ? ['TranslationJob.findByIdAndUpdate'] : [])]) {
    test(`${mode}: ${failure} rolls back canonical preparation, editions and public copies`, async context => {
      const setup = install(context, { mode, layout: 'placeholders', status: 'published' });
      const { state, requestedId } = setup;
      const before = state.content();
      state.failures[failure] = { once: true };
      const response = await state.request('post', `/api/articles/${requestedId}/publish`);
      assert.equal(response.status, failure === 'Article.findOneAndUpdate' ? 503 : 500, response.text);
      assert.equal(response.body.ok, false);
      assert.deepEqual(state.content(), before);
      assert.equal(state.invalidations.length, 0);
      assert.equal(state.rows.PushHistory.length, 0);
      assert.ok(state.transactions[0].aborted && !state.transactions[0].committed && state.transactions[0].ended);
    });
  }

  test(`${mode}: a conflicting persisted edition cannot produce false publication success`, async context => {
    const setup = install(context, { mode, layout: 'child-key-only' });
    const { state, requestedId } = setup;
    const before = state.content();
    const create = News.create;
    context.mock.method(News, 'create', async (...args) => {
      const docs = await create(...args);
      state.rows.News.find(doc => doc._id === String(docs[0]._id)).sourceArticleId = requestedId;
      return docs;
    });
    const response = await state.request('post', `/api/articles/${requestedId}/publish`);
    assert.equal(response.status, 409, response.text);
    assert.match(response.body.message, /Founder review/);
    assert.deepEqual(state.content(), before);
    assert.equal(state.invalidations.length, 0);
    assert.ok(state.transactions[0].aborted && !state.transactions[0].committed);
  });

  test(`${mode}: revalidation failure reports committed publication without duplicate retry`, async context => {
    const setup = install(context, { mode });
    setup.state.failures['EditorialTopic.find'] = { once: true };
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    await assertPublished(setup, response);
    assert.equal(response.body.committed, true);
    assert.equal(response.body.revalidation.ok, false);
    assert.deepEqual(response.body.revalidation.failures, ['TOPIC_REVALIDATION_LOOKUP_FAILED']);
    const ids = setup.state.rows.News.map(doc => doc._id);
    const repeat = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    await assertPublished(setup, repeat);
    assert.deepEqual(setup.state.rows.News.map(doc => doc._id), ids);
  });

  test(`${mode}: real Mongoose documents retain canonical identity through child publication`, async context => {
    const setup = install(context, { mode, layout: 'child-key-only' });
    const { state, source, requestedId, missingLanguage } = setup;
    state.realNewsDocuments = true;
    context.mock.method(News.collection, 'updateOne', (filter, update, options) => News.updateOne(filter, update, options));
    context.mock.method(News.collection, 'findOne', (filter, options) => News.findOne(filter, null, options).lean());
    const response = await state.request('post', `/api/articles/${requestedId}/publish`);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.article._id, requestedId);
    assert.equal(state.rows.News.length, 3);
    for (const doc of state.rows.News) {
      assert.equal(String(doc.sourceArticleId), source._id);
      const status = await state.request('get', `/api/articles/${doc._id}/translation-status`);
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.data.languageStates.sourceArticleId, source._id);
    }
    assert.equal(state.rows.News.find(doc => doc._id === requestedId).content, '<p>Human-edited hi body</p>');
    assert.equal(state.rows.News.find(doc => doc.language === missingLanguage).translationMeta.sourceLanguage, 'gu');
  });
}

test('provider failure rolls back legacy child publication without publishing existing human edits', async context => {
  const setup = install(context, { layout: 'child-key-only', status: 'published' });
  const before = setup.state.content();
  context.mock.method(google, 'translateText', async () => ({ ok: false, error: 'Synthetic provider failure' }));
  const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
  assert.equal(response.status, 502, response.text);
  assert.equal(response.body.ok, false);
  assert.deepEqual(setup.state.content(), before);
  assert.equal(setup.state.invalidations.length, 0);
});

for (const phase of ['provider completion', 'transaction retry']) {
  test(`Founder grant revocation at ${phase} still cancels child publication atomically`, async context => {
    const staff = publishStaff('reporter', ['news_publish']);
    const setup = install(context, { layout: 'child-key-only', staff });
    const before = setup.state.content();
    if (phase === 'transaction retry') retryOnce(context, setup.state, () => { staff.newsPublishGrant = null; });
    else {
      const translate = google.translateText;
      context.mock.method(google, 'translateText', async (...args) => {
        const result = await translate(...args);
        staff.newsPublishGrant = null;
        return result;
      });
    }
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`, {}, 'reporter');
    assert.equal(response.status, 403, response.text);
    assert.deepEqual(setup.state.content(), before);
    assert.equal(setup.state.invalidations.length, 0);
    assert.equal(setup.state.rows.PushHistory.length, 0);
  });
}

for (const layout of ['keyless', 'placeholders']) {
  test(`Staff placeholder identity protection is preserved for ${layout} publication`, async context => {
    const setup = install(context, { layout, staff: publishStaff('reporter', ['news_publish']) });
    const before = setup.state.content();
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`, {}, 'reporter');
    if (layout === 'keyless') await assertPublished(setup, response);
    else {
      assert.equal(response.status, 409, response.text);
      assert.match(response.body.message, /scope changed/i);
      assert.deepEqual(setup.state.content(), before);
      assert.equal(setup.state.writes().length, 0);
      assert.equal(setup.translate.mock.callCount(), 0);
    }
  });
}

for (const sourceLanguage of LANGUAGES) {
  test(`${sourceLanguage}: verified group-only child is not self-anchored by publication`, async context => {
    const requestedLanguage = LANGUAGES.find(lang => lang !== sourceLanguage);
    const setup = install(context, { sourceLanguage, requestedLanguage, mode: 'cached' });
    const requested = setup.state.rows.News.find(doc => doc._id === setup.requestedId);
    delete requested.sourceArticleId;
    delete requested.translationMeta;
    setup.originals = structuredClone(setup.state.rows.News);
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    await assertPublished(setup, response);
  });

  test(`${sourceLanguage}: incoming child linkage identifies a source without a self-link`, async context => {
    const requestedLanguage = LANGUAGES.find(lang => lang !== sourceLanguage);
    const setup = install(context, { sourceLanguage, requestedLanguage, layout: 'child-key-only' });
    delete setup.state.rows.News.find(doc => doc._id === setup.source._id).sourceArticleId;
    const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
    await assertPublished(setup, response);
  });

  for (const anchored of [false, true]) {
    test(`${sourceLanguage}: ${anchored ? 'self-linked keyless' : 'keyed standalone'} original generates both missing editions`, async context => {
      const setup = install(context, { sourceLanguage, requestedLanguage: sourceLanguage, layout: anchored ? 'keyless' : 'modern' });
      setup.state.rows.News = setup.state.rows.News.filter(doc => doc._id === setup.source._id);
      if (!anchored) delete setup.state.rows.News[0].sourceArticleId;
      setup.originals = structuredClone(setup.state.rows.News);
      const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
      await assertPublished(setup, response);
      assert.equal(setup.state.calls.filter(call => call.name === 'News' && call.method === 'create').length, 2);
    });
  }
}

test('requested child cache takes precedence without changing canonical identity', async context => {
  const setup = install(context, { mode: 'cached' });
  setup.state.rows.News.find(doc => doc._id === setup.source._id).translations[setup.missingLanguage] = {
    title: 'Older canonical cache', summary: 'Older summary', content: '<p>Older body</p>',
  };
  const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
  await assertPublished(setup, response);
  assert.equal(setup.state.rows.News.find(doc => doc.language === setup.missingLanguage).title, setup.bucket.title);
});

test('canonical cached content is reused when the requested child has no complete cache', async context => {
  const setup = install(context, { mode: 'cached' });
  setup.state.rows.News.find(doc => doc._id === setup.source._id).translations[setup.missingLanguage] = setup.bucket;
  setup.state.rows.News.find(doc => doc._id === setup.requestedId).translations = {};
  const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
  await assertPublished(setup, response);
  assert.equal(setup.state.rows.News.find(doc => doc.language === setup.missingLanguage).title, setup.bucket.title);
});

test('publishing through a later child retains each original date and uses canonical chronology for the new edition', async context => {
  const setup = install(context, { status: 'published' });
  const { state, source, requestedId, missingLanguage } = setup;
  for (const doc of [...state.rows.News, ...state.rows.Article]) {
    doc.publishedAt = new Date(doc.language === setup.sourceLanguage ? '2020-01-01' : '2020-02-01');
  }
  setup.originals = structuredClone(state.rows.News);
  setup.copies = structuredClone(state.rows.Article);
  const response = await state.request('post', `/api/articles/${requestedId}/publish`);
  await assertPublished(setup, response);
  assert.equal(new Date(state.rows.News.find(doc => doc.language === missingLanguage).publishedAt).getTime(),
    new Date(state.rows.News.find(doc => doc._id === source._id).publishedAt).getTime());
});

test('legacy originalLang hints cannot replace verified native source or requested languages', async context => {
  const setup = install(context);
  setup.state.rows.News.find(doc => doc._id === setup.source._id).originalLang = 'en';
  setup.state.rows.News.find(doc => doc._id === setup.requestedId).originalLang = 'gu';
  const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`);
  await assertPublished(setup, response);
  assert.equal(response.body.article.language, 'hi');
  assert.equal(response.body.article.originalLang, 'gu');
  assert.equal(setup.state.rows.News.find(doc => doc._id === setup.source._id).language, 'gu');
});

for (const blocker of ['foreign owner', 'locked sibling', 'foreign public copy']) {
  test(`canonical resolution cannot expand Staff access to an indirectly linked ${blocker}`, async context => {
    const setup = install(context, { layout: 'child-key-only', staff: publishStaff('reporter', ['news_publish']) });
    const { state, source, missingLanguage } = setup;
    const held = state.rows.News.find(doc => doc._id === setup.requestedId);
    const sibling = {
      ...structuredClone(held), _id: '707f1f77bcf86cd79943a008',
      language: missingLanguage, lang: missingLanguage, originalLang: missingLanguage,
      slug: source.slugs[missingLanguage],
    };
    delete sibling.sourceArticleId;
    delete sibling.translationMeta;
    if (blocker === 'foreign owner') sibling.createdByUserId = actorId('editor');
    if (blocker === 'locked sibling') sibling.locked = true;
    state.rows.News.push(sibling);
    if (blocker === 'foreign public copy') state.rows.Article.push({
      ...structuredClone(sibling), _id: '707f1f77bcf86cd79943a009', sourceNewsId: '707f1f77bcf86cd79943a010',
    });
    const before = state.content();
    const response = await state.request('post', `/api/articles/${source._id}/publish`, {}, 'reporter');
    assertBlocked(setup, before, response, 403);
  });
}

test('unauthenticated child publication cannot read or mutate a translation group', async context => {
  const setup = install(context);
  const before = setup.state.content();
  const response = await setup.state.request('post', `/api/articles/${setup.requestedId}/publish`, {}, null);
  assertBlocked(setup, before, response, 401);
  assert.equal(setup.state.calls.filter(call => ['News', 'Article'].includes(call.name)).length, 0);
});

test('trusted publication returns the stored requested ID after ObjectId casing normalization', async context => {
  const setup = install(context);
  const findById = News.findById;
  context.mock.method(News, 'findById', (id, ...args) => findById(String(id).toLowerCase(), ...args));
  const { publishCanonicalArticle } = require('../services/articlePublishing.service');
  const result = await publishCanonicalArticle(setup.requestedId.toUpperCase(), { actor: { byRole: 'SYSTEM' } });
  assert.equal(result.ok, true);
  assert.equal(String(result.article._id), setup.requestedId);
  assert.equal(setup.state.rows.News.length, 3);
  assert.ok(setup.state.rows.News.every(doc => doc.sourceArticleId === setup.source._id));
});

for (const sourceLanguage of LANGUAGES) for (const initialStatus of ['draft', 'published']) {
  test(`${sourceLanguage}: create ${initialStatus}, Save Draft, Publish and published edits retain their contracts`, async context => {
    const { state } = install(context, { sourceLanguage, requestedLanguage: sourceLanguage });
    state.rows.News = [];
    state.rows.Article = [];
    const created = await state.request('post', '/api/articles', {
      title: `Fresh ${sourceLanguage} story`, description: 'Fresh summary', content: '<p>Fresh body</p>',
      slug: `fresh-${sourceLanguage}-story`, language: sourceLanguage, category: 'national', status: initialStatus,
    });
    assert.equal(created.status, 201, created.text);
    const id = created.body.article._id;
    assert.deepEqual(created.body.data.article, created.body.article);
    assert.equal(created.body.article.status, initialStatus);
    if (initialStatus === 'draft') {
      const draft = await state.request('patch', `/api/articles/${id}`, { status: 'draft', description: 'Saved draft summary' });
      assert.equal(draft.status, 200, draft.text);
      assert.equal(draft.body.article._id, id);
      assert.equal(draft.body.article.status, 'draft');
      assert.equal(state.rows.News.length, 1);
    }
    const published = await state.request('post', `/api/articles/${id}/publish`);
    assert.equal(published.status, 200, published.text);
    assert.equal(published.body.article._id, id);
    assert.equal(state.rows.News.length, 3);
    const identities = state.rows.News.map(doc => ({
      id: doc._id, sourceArticleId: doc.sourceArticleId, key: doc.translationGroupId, publishedAt: doc.publishedAt,
    }));
    const publicIds = state.rows.Article.map(doc => ({ id: doc._id, sourceNewsId: doc.sourceNewsId }));
    const edited = await state.request('patch', `/api/articles/${id}`, {
      description: 'Published summary edit', publishedAt: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(edited.status, 200, edited.text);
    assert.equal(edited.body.article._id, id);
    assert.deepEqual(state.rows.News.map(doc => ({
      id: doc._id, sourceArticleId: doc.sourceArticleId, key: doc.translationGroupId, publishedAt: doc.publishedAt,
    })), identities);
    assert.deepEqual(state.rows.Article.map(doc => ({ id: doc._id, sourceNewsId: doc.sourceNewsId })), publicIds);
    for (const doc of state.rows.News) {
      assert.equal(doc.sourceArticleId, id);
      const status = await state.request('get', `/api/articles/${doc._id}/translation-status`);
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.data.baseLang, sourceLanguage);
      assert.equal(status.body.data.languageStates.sourceArticleId, id);
    }
  });
}
