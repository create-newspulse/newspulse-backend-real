const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const { serializeNewsArticle } = require('../services/articleLifecycle.service');
const PublicSiteSettings = require('../models/PublicSiteSettings');

const draft = {
  title: 'Compatibility draft', description: 'Compatibility summary', content: '<p>Compatibility body</p>',
  category: 'business', language: 'en', slug: 'compatibility-draft', status: 'draft',
};

function enableJobStorage(context) {
  const previous = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previous; });
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: ['en', 'hi', 'gu'] } },
  }));
}

function assertCompatibleArticle(article, expectedId, expectedContent) {
  assert.equal(article.id, String(expectedId));
  assert.equal(String(article._id), String(expectedId));
  assert.equal(article.content, expectedContent);
  assert.equal(article.body, expectedContent);
}

function assertTransactionWrites(state, session, start = 0) {
  const transactionalModels = new Set(['News', 'Article', 'TranslationJob']);
  const mutations = new Set(['save', 'create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteMany']);
  const writes = state.calls.slice(start).filter(call => transactionalModels.has(call.name) && mutations.has(call.method));
  assert.ok(writes.length > 0);
  for (const call of writes) assert.equal(call.options?.session, session, `${call.name}.${call.method} must use the outer transaction`);
}

function beforeNextArticleTransaction(context, effect) {
  const start = mongoose.startSession;
  let pending = true;
  context.mock.method(mongoose, 'startSession', async () => {
    if (pending) {
      pending = false;
      await effect();
    }
    return start();
  });
}

test('lean mutation serialization matches the existing real News body/id virtuals', () => {
  const doc = new models.News({ ...draft, _id: '507f1f77bcf86cd79943a001' });
  const original = doc.toJSON();
  const lean = doc.toObject({ virtuals: false });
  const serialized = serializeNewsArticle(lean);
  for (const field of ['id', 'body', 'content']) assert.equal(serialized[field], original[field]);
  assert.equal(String(serialized._id), String(original._id));
  assert.deepEqual(serializeNewsArticle(doc), doc.toObject({ virtuals: true }));
});

for (const entry of [
  { method: 'put', path: '/api/articles/:id', body: { title: 'Edited headline' }, message: 'Article updated' },
  { method: 'patch', path: '/api/articles/:id', body: { content: '<p>Edited body</p>' }, message: 'Article updated' },
  { method: 'post', path: '/api/articles/:id/publish', body: {}, status: 'draft', message: 'Article published' },
  { method: 'put', path: '/api/articles/:id', body: { status: 'published' }, status: 'draft', message: 'Article updated' },
  { method: 'post', path: '/api/articles/:id/unpublish', body: {}, message: 'Article unpublished' },
  { method: 'put', path: '/api/articles/:id', body: { status: 'draft' }, message: 'Article unpublished' },
  { method: 'post', path: '/api/articles/:id/archive', body: {}, message: 'Article archived' },
  { method: 'post', path: '/api/articles/:id/schedule', body: { scheduledAt: '2099-01-01T00:00:00.000Z' }, message: 'Article scheduled' },
  { method: 'delete', path: '/api/articles/:id', message: 'Article deleted' },
  { method: 'post', path: '/api/articles/:id/restore', body: {}, status: 'deleted', message: 'Article restored' },
]) {
  test(`${entry.method.toUpperCase()} ${entry.path} ${entry.message} retains mutation envelope and News virtuals`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: entry.status || 'published' });
    if (entry.status === 'deleted') state.rows.News.forEach(doc => { doc.deletedFromStatus = 'published'; });
    const expectedContent = entry.body?.content || state.rows.News[0].content;
    const response = await state.request(entry.method, entry.path.replace(':id', ids[0]), entry.body);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.equal(response.body.success, true);
    assert.equal(response.body.message, entry.message);
    assert.deepEqual(response.body.article, response.body.data.article);
    assertCompatibleArticle(response.body.article, ids[0], expectedContent);
  });
}

for (const action of ['delete', 'restore']) {
  test(`legacy draft ${action} retains the data document body/id virtuals`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: action === 'restore' ? 'deleted' : 'draft' });
    const response = await state.request('post', `/api/admin/drafts/${ids[0]}/${action}`, {});
    assert.equal(response.statusCode, 200);
    assertCompatibleArticle(response.body.data, ids[0], '<p>en body</p>');
  });
}

for (const [method, suffix] of [
  ['delete', '/permanent'], ['delete', '/hard-delete'], ['delete', '/hard'],
  ['delete', '/forever'], ['delete', '?hard=true'], ['post', '/hard-delete'], ['post', '/hard'],
]) {
  test(`${method.toUpperCase()} permanent-delete alias ${suffix} retains numeric status and the original message`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'deleted' });
    const response = await state.request(method, `/api/articles/${ids[0]}${suffix}`);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      Object.fromEntries(['ok', 'success', 'status', 'message'].map(key => [key, response.body[key]])),
      { ok: true, success: true, status: 200, message: 'Article permanently deleted.' }
    );
    assert.equal(typeof response.body.status, 'number');
    assert.equal(response.body.deletedCount, 3);
    assert.equal(response.body.publicDeletedCount, 3);
    assert.deepEqual(response.body.deletedIds, ids);
  });
}

for (const path of ['/api/news', '/api/news/news']) {
  test(`legacy POST ${path} preserves unauthenticated input handling and its message-only envelope`, async context => {
    const state = installEditorialFixture(context);
    let saved;
    context.mock.method(models.News.prototype, 'save', async function () {
      await this.validate();
      saved = this.toObject();
      return this;
    });
    const response = await state.request('post', path, {
      title: draft.title, description: draft.description, body: draft.content,
      category: 'business', lang: 'not-a-language', language: 'hi',
      status: 'draft', imageURL: '/uploads/legacy.jpg', translationKey: 'legacy-key',
    }, null);
    assert.equal(response.statusCode, 201);
    assert.deepEqual(response.body, { message: 'News created successfully' });
    assert.equal(saved.content, draft.content);
    assert.equal(saved.language, 'hi');
    assert.equal(saved.lang, 'hi');
    assert.equal(saved.translationKey, 'legacy-key');
    assert.ok(saved.translationGroupId);
    assert.equal(saved.slug, 'compatibility-draft');
    assert.match(saved.coverImageUrl, /\/uploads\/legacy\.jpg$/);
    assert.equal(state.transactions.length, 0);
  });
}

for (const method of ['put', 'patch']) {
  test(`legacy ${method.toUpperCase()} preserves unauthenticated edits, language fallback and the legacy envelope`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'draft' });
    const response = await state.request(method, `/api/news/${ids[0]}`, {
      title: 'Legacy edit title', lang: 'invalid', language: 'invalid',
      translationGroupId: '', translationKey: '', content: '<p>Legacy edit</p>',
    }, null);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { message: 'News updated successfully' });
    assert.equal(state.rows.News[0].language, 'en');
    assert.equal(state.rows.News[0].translationGroupId, 'story-test-group');
    assert.equal(state.rows.News[0].translationKey, 'story-test-group');
    assert.equal(state.rows.News[0].slug, 'story-en');
    assert.equal(state.rows.News[0].slugs.en, 'legacy-edit-title');
    assert.equal(state.rows.News[1].title, 'hi headline');
    assert.equal(state.transactions.length, 0);
  });
}

test('legacy mutations keep their author-byline rejection and error envelopes', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft' });
  for (const [method, path] of [['post', '/api/news'], ['put', `/api/news/${ids[0]}`]]) {
    const rejected = await state.request(method, path, { 'authorByline.enabled': true }, null);
    assert.equal(rejected.statusCode, 400);
    assert.deepEqual(rejected.body, { error: 'Author bylines must be saved through the authenticated articles API' });
  }
  const missing = await state.request('patch', '/api/news/507f1f77bcf86cd79943ffff', { title: 'Missing' }, null);
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, { error: 'Not found' });
  context.mock.method(models.News, 'findById', () => { throw new Error('Legacy storage failure'); });
  const failed = await state.request('put', `/api/news/${ids[0]}`, { title: 'Error' }, null);
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.body, { error: 'Legacy storage failure' });
});

for (const failure of ['News.save', 'News.updateMany', 'Article.findOneAndUpdate']) {
  test(`draft creation rolls back ${failure} and a retry creates exactly one News record`, async context => {
    const state = installEditorialFixture(context);
    state.failures[failure] = { once: true };
    const failed = await state.request('post', '/api/articles', draft);
    assert.ok(failed.statusCode >= 400);
    assert.equal(state.rows.News.length, 0);
    assert.equal(state.rows.Article.length, 0);
    assert.equal(state.rows.TranslationJob.length, 0);
    assert.equal(state.invalidations.length, 0);
    assert.ok(state.transactions[0].aborted);
    const retried = await state.request('post', '/api/articles', draft);
    assert.equal(retried.statusCode, 201, JSON.stringify(retried.body));
    assert.equal(retried.body.message, 'Article created');
    assert.equal(state.rows.News.length, 1);
    assertCompatibleArticle(retried.body.article, state.rows.News[0]._id, draft.content);
    assert.deepEqual(retried.body.data.article, retried.body.article);
  });
}

test('creation fails closed before writing when transactions are unavailable', async context => {
  const state = installEditorialFixture(context);
  context.mock.method(mongoose, 'startSession', async () => { throw new Error('Transaction unavailable'); });
  const response = await state.request('post', '/api/articles', draft);
  assert.equal(response.statusCode, 500);
  assert.equal(state.rows.News.length, 0);
  assert.equal(state.rows.Article.length, 0);
});

test('direct create-and-publish rolls back newly generated editions, jobs and copies on publication failure', async context => {
  const state = installEditorialFixture(context);
  enableJobStorage(context);
  const google = require('../services/googleTranslationService');
  context.mock.method(google, 'translateText', async (text, _from, to) => ({ ok: true, text: `${to} ${text}` }));
  state.failures['Article.updateMany'] = { once: true };
  const body = { ...draft, status: 'published' };
  const failed = await state.request('post', '/api/articles', body);
  assert.equal(failed.statusCode, 503, JSON.stringify(failed.body));
  for (const model of ['News', 'Article', 'TranslationJob', 'PushHistory']) assert.equal(state.rows[model].length, 0, model);
  assert.equal(state.invalidations.length, 0);
  assert.ok(state.transactions[0].aborted);
  assert.equal(state.transactions.length, 1);
  assertTransactionWrites(state, state.transactions[0]);
  const retryStart = state.calls.length;
  const retried = await state.request('post', '/api/articles', body);
  assert.equal(retried.statusCode, 201, JSON.stringify(retried.body));
  assert.equal(retried.body.message, 'Article created and published');
  assert.equal(state.rows.News.length, 3);
  assert.equal(state.rows.Article.length, 3);
  assert.equal(state.transactions.length, 2);
  assertTransactionWrites(state, state.transactions[1], retryStart);
  assertCompatibleArticle(retried.body.article, retried.body.article._id, draft.content);
});

test('combined edit + publish shares its transaction with every generated translation write', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'draft', copies: false });
  state.rows.News = state.rows.News.filter(doc => doc.language === 'en');
  enableJobStorage(context);
  const google = require('../services/googleTranslationService');
  context.mock.method(google, 'translateText', async (text, _from, to) => ({ ok: true, text: `${to} ${text}` }));
  const before = JSON.stringify(state.rows);
  state.failures['Article.updateMany'] = { once: true };
  const response = await state.request('put', `/api/articles/${ids[0]}`, { title: 'Atomic translated edit', status: 'published' });
  assert.equal(response.statusCode, 503, JSON.stringify(response.body));
  assert.equal(JSON.stringify(state.rows), before);
  assert.equal(state.transactions.length, 1);
  assert.ok(state.transactions[0].aborted);
  assertTransactionWrites(state, state.transactions[0]);
  assert.equal(state.invalidations.length, 0);
});

for (const status of ['draft', 'archived', 'scheduled', 'published']) {
  test(`combined edit + ${status} rolls back both content and lifecycle on storage failure`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: status === 'published' ? 'draft' : 'published' });
    const before = JSON.stringify(state.rows);
    state.failures['Article.updateMany'] = { once: true };
    const body = { title: 'Must roll back', content: '<p>Must roll back</p>', status };
    if (status === 'scheduled') body.scheduledAt = '2099-01-01T00:00:00.000Z';
    const response = await state.request('put', `/api/articles/${ids[0]}`, body);
    assert.equal(response.statusCode, status === 'published' ? 503 : 500, JSON.stringify(response.body));
    assert.equal(JSON.stringify(state.rows), before);
    assert.equal(state.invalidations.length, 0);
    assert.ok(state.transactions[0].aborted);
    assert.equal(state.transactions.length, 1);
  });
}

for (const failure of ['WorkflowEvent.create', 'AuditLog.create', 'PushHistory.create']) {
  test(`workflow publication and metadata roll back together when ${failure} fails`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'draft' });
    const before = JSON.stringify(state.rows);
    state.failures[failure] = { once: true };
    const response = await state.request('patch', `/api/admin/workflow/articles/${ids[0]}/stage`, {
      action: 'set', toStage: 'published', note: 'Atomic workflow',
    });
    assert.equal(response.statusCode, 500, JSON.stringify(response.body));
    assert.equal(JSON.stringify(state.rows), before);
    assert.equal(state.invalidations.length, 0);
    assert.ok(state.transactions[0].aborted);
  });
}

test('Founder Edit Published with an explicit Publish retains the old content if its public copy write fails', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const before = JSON.stringify(state.rows);
  state.failures['Article.findOneAndUpdate'] = { once: true };
  const response = await state.request('put', `/api/articles/${ids[0]}`, {
    title: 'Rollback live edit', status: 'published', publishedAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(response.statusCode, 503);
  assert.equal(JSON.stringify(state.rows), before);
  assert.equal(state.invalidations.length, 0);
});

for (const [role, method] of [['founder', 'put'], ['editor', 'patch']]) {
  test(`B1 ${role} stale ${method.toUpperCase()} cannot republish one edition after whole-story Unpublish`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    let withdrawn;
    beforeNextArticleTransaction(context, async () => {
      const response = await state.request('post', `/api/articles/${ids[0]}/unpublish`, {});
      assert.equal(response.statusCode, 200, JSON.stringify(response.body));
      withdrawn = JSON.stringify([state.rows.News, state.rows.Article]);
    });
    const response = await state.request(method, `/api/articles/${ids[0]}`, {
      content: '<p>Stale published edit</p>', status: 'published',
    }, role);
    assert.equal(response.statusCode, 409, JSON.stringify(response.body));
    assert.match(response.body.message, /changed.*reload/i);
    assert.equal(JSON.stringify([state.rows.News, state.rows.Article]), withdrawn);
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'draft'));
    assert.ok(state.rows.News.every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
    assert.ok(state.transactions.at(-1).aborted);
  });

  test(`B1 ${role} ordinary Edit Published still preserves its successful ${method.toUpperCase()} contract`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    const content = '<p>Current published edit</p>';
    const response = await state.request(method, `/api/articles/${ids[0]}`, { content, status: 'published' }, role);
    assert.equal(response.statusCode, 200, JSON.stringify(response.body));
    assert.equal(response.body.message, 'Article updated');
    assert.equal(response.body.success, true);
    assert.deepEqual(response.body.article, response.body.data.article);
    assertCompatibleArticle(response.body.article, ids[0], content);
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'published'));
    assert.ok(state.rows.News.every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
    assert.equal(state.rows.News[1].content, '<p>hi body</p>');
    assert.equal(state.rows.News[2].content, '<p>gu body</p>');
  });

  test(`B1 a genuine ${role} Publish retains whole-story Founder authorization`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    assert.equal((await state.request('post', `/api/articles/${ids[0]}/unpublish`, {})).statusCode, 200);
    const response = await state.request(method, `/api/articles/${ids[0]}`, {
      content: '<p>Explicit publication</p>', status: 'published',
    }, role);
    assert.equal(response.statusCode, role === 'founder' ? 200 : 403, JSON.stringify(response.body));
    const status = role === 'founder' ? 'published' : 'draft';
    assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === status));
    assert.ok(state.rows.News.every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
    if (role === 'founder') assert.deepEqual([...response.body.publishedLanguages].sort(), ['en', 'gu', 'hi']);
    else assert.equal(state.rows.News[0].content, '<p>en body</p>');
  });
}

for (const action of ['publish', 'unpublish', 'delete', 'delete/restore']) {
  test(`B1 a content-only edit cannot overwrite an intervening ${action}`, async context => {
    const state = installEditorialFixture(context);
    const status = action === 'publish' ? 'draft' : 'published';
    const { ids } = seedGroup(state, { status });
    let afterLifecycle;
    beforeNextArticleTransaction(context, async () => {
      for (const step of action.split('/')) {
        const response = step === 'delete'
          ? await state.request('delete', `/api/articles/${ids[0]}`)
          : await state.request('post', `/api/articles/${ids[0]}/${step}`, {});
        assert.equal(response.statusCode, 200, JSON.stringify(response.body));
      }
      afterLifecycle = JSON.stringify([state.rows.News, state.rows.Article]);
    });
    const response = await state.request('put', `/api/articles/${ids[0]}`, { content: '<p>Stale content-only edit</p>' }, 'editor');
    assert.equal(response.statusCode, 409, JSON.stringify(response.body));
    assert.equal(JSON.stringify([state.rows.News, state.rows.Article]), afterLifecycle);
    assert.equal(new Set(state.rows.News.map(doc => doc.status)).size, 1);
  });
}

test('B1 a current content-only edit preserves lifecycle state and publication chronology', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const lifecycleState = () => [...state.rows.News, ...state.rows.Article].map(doc => ({
    id: doc._id, status: doc.status, publishedAt: doc.publishedAt, deletedAt: doc.deletedAt,
    workflowStage: doc.workflowStage, workflowHistory: doc.workflowHistory,
  }));
  const before = JSON.stringify(lifecycleState());
  const response = await state.request('put', `/api/articles/${ids[0]}`, { content: '<p>Content only</p>' }, 'editor');
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assertCompatibleArticle(response.body.article, ids[0], '<p>Content only</p>');
  assert.equal(JSON.stringify(lifecycleState()), before);
});

for (const [label, patch] of [
  ['lock', { locked: true }],
  ['embargo', { embargoUntil: new Date('2099-01-01T00:00:00.000Z') }],
  ['status', { status: 'scheduled' }],
]) {
  test(`workflow rechecks a concurrent ${label} inside the transaction`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state, { status: 'draft' });
    const start = mongoose.startSession;
    context.mock.method(mongoose, 'startSession', async () => {
      Object.assign(state.rows.News[0], patch);
      return start();
    });
    const response = await state.request('patch', `/api/admin/workflow/articles/${ids[0]}/stage`, {
      action: 'set', toStage: 'copy_edit',
    }, 'admin');
    assert.equal(response.statusCode, 409);
    assert.equal(state.rows.News[0].workflowStage, 'DRAFT');
    assert.equal(state.rows.WorkflowEvent.length, 0);
    assert.equal(state.rows.PushHistory.length, 0);
    assert.equal(state.invalidations.length, 0);
  });
}

test('ordinary source edits preserve automatic translation enqueue and human-edited sibling protection', async context => {
  const state = installEditorialFixture(context);
  const { ids, publication } = seedGroup(state);
  enableJobStorage(context);
  state.rows.News[1].machineGenerated = true;
  state.rows.News[1].humanEdited = false;
  state.rows.News[2].machineGenerated = true;
  state.rows.News[2].humanEdited = true;
  const response = await state.request('put', `/api/articles/${ids[0]}`, { content: '<p>Updated source</p>' });
  assert.equal(response.statusCode, 200, JSON.stringify(response.body));
  assert.equal(state.rows.TranslationJob.length, 1);
  assert.equal(state.rows.TranslationJob[0].newsId, ids[0]);
  assert.equal(state.rows.TranslationJob[0].status, 'translating');
  assert.deepEqual(state.rows.TranslationJob[0].targetLanguages, ['hi', 'gu']);
  assert.equal(state.rows.News[1].translationReviewStatus, 'translation_outdated');
  assert.notEqual(state.rows.News[2].translationReviewStatus, 'translation_outdated');
  assert.ok(state.rows.News.every(doc => new Date(doc.publishedAt).getTime() === publication.getTime()));
});

test('translation enqueue failure reports a saved edit, not a failed or duplicate-able mutation', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  enableJobStorage(context);
  state.failures['TranslationJob.findOneAndUpdate'] = { once: true };
  const response = await state.request('put', `/api/articles/${ids[0]}`, { content: '<p>Saved despite enqueue failure</p>' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.postCommitWarnings[0].code, 'ARTICLE_FOLLOW_UP_FAILED');
  assert.equal(state.rows.News[0].content, '<p>Saved despite enqueue failure</p>');
  assert.equal(state.rows.News.length, 3);
});

test('post-commit topic lookup failure retains successful destructive mutation metadata', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  state.failures['EditorialTopic.find'] = { once: true };
  const response = await state.request('delete', `/api/articles/${ids[0]}`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.deletedCount, 3);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.revalidation.ok, false);
  assert.deepEqual(response.body.revalidation.failures, ['TOPIC_REVALIDATION_LOOKUP_FAILED']);
  assert.ok(state.rows.News.every(doc => doc.status === 'deleted'));
});

test('post-commit public version failure retains numeric permanent-delete success and a delivery warning', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  state.failures['PublicConfigVersion.findOneAndUpdate'] = { once: true };
  const response = await state.request('delete', `/api/articles/${ids[0]}/forever`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 200);
  assert.equal(response.body.committed, true);
  assert.equal(response.body.revalidation.ok, false);
  assert.equal(response.body.deletedCount, 3);
  assert.equal(state.rows.News.length, 0);
  assert.equal(state.rows.Article.length, 0);
});

test('standalone generation reports editions already committed when a later language write fails', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  state.rows.News = state.rows.News.filter(doc => doc.language === 'en');
  const google = require('../services/googleTranslationService');
  context.mock.method(google, 'translateText', async (text, _from, to) => ({ ok: true, text: `${to} ${text}` }));
  const create = models.News.create;
  context.mock.method(models.News, 'create', (payload, options) => {
    if (payload[0].language === 'gu') throw Object.assign(new Error('Later edition failed'), { statusCode: 503 });
    return create(payload, options);
  });
  const response = await state.request('post', `/api/articles/${ids[0]}/translations/generate`, { targetLanguages: ['hi', 'gu'] });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.committed, true);
  assert.ok(response.body.translationResult.created.hi);
  assert.equal(state.rows.News.find(doc => doc.language === 'hi')._id, response.body.translationResult.created.hi);
  assert.equal(state.rows.News.some(doc => doc.language === 'gu'), false);
});

for (const scenario of [
  { name: 'HI commits and GU fails', failedLanguage: 'gu', committed: ['hi'] },
  { name: 'all editions commit', committed: ['hi', 'gu'] },
  { name: 'the first edition fails', failedLanguage: 'hi', committed: [] },
  { name: 'partial success has a revalidation delivery failure', failedLanguage: 'gu', committed: ['hi'], deliveryFails: true },
]) {
  test(`B2 invalidates only committed public editions once when ${scenario.name}`, async context => {
    const state = installEditorialFixture(context);
    const { ids, publication } = seedGroup(state);
    enableJobStorage(context);
    const originalContent = Object.fromEntries(state.rows.News.map(doc => [doc.language, doc.content]));
    const google = require('../services/googleTranslationService');
    context.mock.method(google, 'translateText', async (text, _from, to) => ({ ok: true, text: `${to} ${text}` }));
    const update = models.News.findOneAndUpdate;
    context.mock.method(models.News, 'findOneAndUpdate', (filter, patch, options) => {
      if (scenario.failedLanguage && patch.$set?.language === scenario.failedLanguage
        && patch.$set?.content === `${scenario.failedLanguage} ${originalContent.en}`) {
        throw Object.assign(new Error('Translation edition could not be persisted'), { statusCode: 503 });
      }
      return update(filter, patch, options);
    });
    const cacheInvalidations = [];
    const { onArticleCachesInvalidated } = require('../lib/cache');
    context.after(onArticleCachesInvalidated(event => cacheInvalidations.push(event)));
    if (scenario.deliveryFails) context.mock.method(global, 'fetch', async (_url, options) => {
      state.invalidations.push(JSON.parse(options.body));
      return { ok: false, status: 502 };
    });
    const response = await state.request('post', `/api/articles/${ids[0]}/translations/generate`, {
      targetLanguages: ['hi', 'gu'], overwrite: true,
    });
    assert.equal(response.statusCode, scenario.failedLanguage ? 503 : 200, JSON.stringify(response.body));
    const result = scenario.failedLanguage ? response.body.translationResult : response.body;
    assert.deepEqual(Object.keys(result.updated), scenario.committed);
    assert.deepEqual(result.created, {});
    if (scenario.failedLanguage) {
      assert.equal(response.body.ok, false);
      assert.equal(response.body.committed, scenario.committed.length ? true : undefined);
    }
    assert.equal(state.rows.TranslationJob[0].status, scenario.failedLanguage ? 'failed' : 'review_required');
    assert.equal(state.rows.News.length, 3);
    assert.equal(state.rows.Article.length, 3);
    for (const [index, language] of ['en', 'hi', 'gu'].entries()) {
      const committed = scenario.committed.includes(language);
      const doc = state.rows.News.find(row => row.language === language);
      const copy = state.rows.Article.find(row => row.sourceNewsId === ids[index]);
      const content = committed ? `${language} ${originalContent.en}` : originalContent[language];
      assert.equal(doc._id, ids[index]);
      assert.equal(doc.content, content);
      assert.equal(copy.content, content);
      assert.equal(doc.status, 'published');
      assert.equal(copy.status, 'published');
      assert.equal(new Date(doc.publishedAt).getTime(), publication.getTime());
      assert.equal(new Date(copy.publishedAt).getTime(), publication.getTime());
      if (committed) assert.equal(result.updated[language], ids[index]);
    }
    assert.equal(cacheInvalidations.length, scenario.committed.length ? 1 : 0);
    assert.equal(state.invalidations.length, scenario.committed.length ? 1 : 0);
    if (scenario.committed.length) {
      const tags = state.invalidations[0].tags.filter(tag => tag.startsWith('article:')).sort();
      const committedIds = state.rows.News.filter(doc => scenario.committed.includes(doc.language)).map(doc => `article:${doc._id}`).sort();
      assert.deepEqual(tags, committedIds);
      assert.equal(result.revalidation.ok, !scenario.deliveryFails);
    }
  });
}

test('async translation follow-up rolls back source readiness when group synchronization fails', async context => {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state);
  const previousKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  process.env.GOOGLE_TRANSLATE_API_KEY = 'isolated-worker-test-only';
  context.after(() => {
    if (previousKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
    else process.env.GOOGLE_TRANSLATE_API_KEY = previousKey;
  });
  const google = require('../services/googleTranslate.service');
  const { translateAndSave } = require('../services/publishAsyncTranslation.service');
  context.mock.method(google, 'translateMany', async values => ({ ok: true, items: values.map(value => `Translated ${value}`) }));
  state.failures['Article.findOneAndUpdate'] = {};
  await assert.rejects(translateAndSave(ids[0]), /Public article synchronization failed/);
  assert.equal(state.rows.News[0].translationStatus.hi, 'pending');
  assert.equal(state.rows.News[0].translations.hi, undefined);
  assert.ok(state.rows.Article.every(doc => Object.keys(doc.translations).length === 0));
  assert.ok(state.transactions.every(session => session.aborted));
  assert.equal(state.invalidations.length, 0);
});

for (const action of ['unpublish', 'delete', 'edit']) {
  test(`async translation follow-up cannot overwrite a concurrent ${action}`, async context => {
    const state = installEditorialFixture(context);
    const { ids } = seedGroup(state);
    const previousKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    process.env.GOOGLE_TRANSLATE_API_KEY = 'isolated-worker-test-only';
    context.after(() => {
      if (previousKey === undefined) delete process.env.GOOGLE_TRANSLATE_API_KEY;
      else process.env.GOOGLE_TRANSLATE_API_KEY = previousKey;
    });
    const google = require('../services/googleTranslate.service');
    const { translateAndSave } = require('../services/publishAsyncTranslation.service');
    let changed = false;
    context.mock.method(google, 'translateMany', async values => {
      if (!changed) {
        changed = true;
        const response = action === 'delete'
          ? await state.request('delete', `/api/articles/${ids[0]}`)
          : action === 'unpublish'
            ? await state.request('post', `/api/articles/${ids[0]}/unpublish`, {})
            : await state.request('put', `/api/articles/${ids[0]}`, { content: '<p>New source revision</p>' });
        assert.equal(response.statusCode, 200);
      }
      return { ok: true, items: values.map(value => `Translated ${value}`) };
    });
    if (action === 'unpublish') {
      await translateAndSave(ids[0]);
      assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'draft'));
    } else {
      await assert.rejects(translateAndSave(ids[0]), { code: 'TRANSLATION_SOURCE_CHANGED', statusCode: 409 });
      if (action === 'delete') assert.ok([...state.rows.News, ...state.rows.Article].every(doc => doc.status === 'deleted'));
      else assert.equal(state.rows.News[0].content, '<p>New source revision</p>');
    }
  });
}
