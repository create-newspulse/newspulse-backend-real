const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const { onArticleCachesInvalidated } = require('../lib/cache');

const EMPTY_COUNTS = { published: 0, draft: 0, scheduled: 0, deleted: 0, archived: 0, mixed: 0 };
const COUNT_SELECT = '_id sourceArticleId translationGroupId translationKey status deletedAt';

function installCountsFixture(context) {
  const state = installEditorialFixture(context);
  state.reads = [];
  state.transactionOptions = [];
  state.sequence = 0;
  const find = models.News.find;
  context.mock.method(models.News, 'find', (...args) => {
    const query = find(...args);
    const read = { filter: args[0], options: args[2] };
    state.reads.push(read);
    const select = query.select.bind(query);
    query.select = value => { read.select = value; return select(value); };
    const maxTimeMS = query.maxTimeMS.bind(query);
    query.maxTimeMS = value => { read.maxTimeMS = value; return maxTimeMS(value); };
    const lean = query.lean.bind(query);
    query.lean = async () => (await lean()).map(row => {
      // The shared fixture serializes BSON IDs; restore the types returned by a real lean read.
      const doc = { ...row, _id: new mongoose.Types.ObjectId(row._id) };
      if (row.sourceArticleId != null) doc.sourceArticleId = new mongoose.Types.ObjectId(row.sourceArticleId);
      return doc;
    });
    return query;
  });
  const startSession = mongoose.startSession;
  context.mock.method(mongoose, 'startSession', async () => {
    const session = await startSession();
    const transaction = session.withTransaction.bind(session);
    session.withTransaction = (work, options) => {
      state.transactionOptions.push(options);
      return transaction(work);
    };
    return session;
  });
  return state;
}

function seedStory(state, { languages = ['en'], status = 'draft', identity = 'both', ...overrides } = {}) {
  const ids = languages.map(() => (++state.sequence).toString(16).padStart(24, '0'));
  const key = `story-${ids[0]}`;
  const docs = languages.map((language, index) => {
    const links = identity === 'both'
      ? { sourceArticleId: ids[0], translationKey: key, translationGroupId: key }
      : identity === 'source' ? { sourceArticleId: ids[0] }
        : identity === 'key' ? { translationKey: key }
          : identity === 'group' ? { translationGroupId: key }
            : identity === 'cross' ? { [index % 2 ? 'translationGroupId' : 'translationKey']: key }
              : {};
    return {
      _id: ids[index], ...links, lang: language, language, originalLang: language,
      title: `${language} headline ${key}`, description: `${language} summary`, content: `<p>${language} body</p>`,
      slug: `${key}-${language}`, category: 'national', status,
      createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-02-01T00:00:00.000Z'),
      publishedAt: new Date('2025-09-01T00:00:00.000Z'),
      deletedAt: status === 'deleted' ? new Date('2026-03-01T00:00:00.000Z') : null,
      syncVersion: 7, ...overrides,
    };
  });
  state.rows.News.push(...docs);
  return docs;
}

function assertCounts(response, expected) {
  const counts = { ...EMPTY_COUNTS, ...expected };
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  assert.equal(response.statusCode, 200, response.text);
  assert.deepEqual(response.body, { ok: true, success: true, data: { unit: 'logical-story', total, counts } });
  assert.equal(response.body.data.total, Object.values(response.body.data.counts).reduce((sum, count) => sum + count, 0));
}

function assertReadOnly(state, before) {
  assert.deepEqual(state.rows, before);
  assert.equal(state.invalidations.length, 0);
  assert.ok(state.calls.every(call => call.name === 'News' && call.method === 'find'), JSON.stringify(state.calls));
  for (const read of state.reads) {
    assert.equal(read.select, COUNT_SELECT);
    assert.equal(read.maxTimeMS, 2500);
    assert.equal(read.options.session, state.transactions[0]);
  }
  assert.deepEqual(state.transactionOptions, [{ readConcern: { level: 'snapshot' }, readPreference: 'primary' }]);
  assert.equal(state.transactions[0].ended, true);
}

for (const languages of [['en'], ['en', 'hi'], ['en', 'hi', 'gu'], ['gu', 'hi']]) {
  test(`${languages.join('+')} editions count as one story without requiring missing translations`, async context => {
    const state = installCountsFixture(context);
    seedStory(state, { languages, status: 'published' });
    const before = structuredClone(state.rows);
    assertCounts(await state.request('get', '/api/articles/counts'), { published: 1 });
    assertReadOnly(state, before);
  });
}

for (const identity of ['source', 'key', 'group', 'cross', 'none']) {
  test(`lifecycle identity supports ${identity} linkage without a scalar fallback`, async context => {
    const state = installCountsFixture(context);
    const docs = seedStory(state, { identity, languages: identity === 'none' ? ['en'] : ['en', 'hi', 'gu'] });
    if (identity === 'source') delete docs[0].sourceArticleId;
    assertCounts(await state.request('get', '/api/articles/counts'), { draft: 1 });
  });
}

test('both grouping keys participate in supported cross-field identity matches', async context => {
  const state = installCountsFixture(context);
  const docs = seedStory(state, { identity: 'none', languages: ['en', 'hi'] });
  Object.assign(docs[0], { translationGroupId: 'first-key', translationKey: 'second-key' });
  Object.assign(docs[1], { translationGroupId: 'second-key', translationKey: 'first-key' });
  assertCounts(await state.request('get', '/api/articles/counts'), { draft: 1 });
});

test('source-linked legacy siblings without modern keys remain with their keyed source', async context => {
  const state = installCountsFixture(context);
  const docs = seedStory(state, { languages: ['en', 'hi', 'gu'], status: 'scheduled' });
  for (const doc of docs.slice(1)) {
    delete doc.translationGroupId;
    delete doc.translationKey;
  }
  assertCounts(await state.request('get', '/api/articles/counts?lang=hi'), { scheduled: 1 });
});

test('placeholder keys, matching slugs, titles and content do not merge standalone records', async context => {
  const state = installCountsFixture(context);
  for (const key of [null, undefined, '', '  ', 'null', ' NULL ', 'undefined', ' UnDeFiNeD ']) {
    seedStory(state, {
      identity: 'none', translationKey: key, translationGroupId: key,
      title: 'Same title', slug: 'same-slug', content: 'Same content',
    });
  }
  assertCounts(await state.request('get', '/api/articles/counts'), { draft: 8 });
});

test('a string group key equal to an ObjectId does not become a source-identity link', async context => {
  const state = installCountsFixture(context);
  const [source] = seedStory(state, { identity: 'source' });
  seedStory(state, { identity: 'none', translationKey: source._id });
  assertCounts(await state.request('get', '/api/articles/counts'), { draft: 2 });
});

test('extra legacy editions and public compatibility copies do not add logical counts', async context => {
  const state = installCountsFixture(context);
  const docs = seedStory(state, { languages: ['en', 'hi', 'gu', 'hi'], status: 'published' });
  state.rows.Article.push(...docs.map(doc => ({ ...doc, sourceNewsId: doc._id })));
  const before = structuredClone(state.rows);
  assertCounts(await state.request('get', '/api/articles/counts'), { published: 1 });
  assertReadOnly(state, before);
});

for (const status of ['published', 'draft', 'scheduled', 'deleted', 'archived']) {
  test(`a uniform ${status} group occupies only its own lifecycle bucket`, async context => {
    const state = installCountsFixture(context);
    seedStory(state, { languages: ['en', 'hi', 'gu'], status });
    assertCounts(await state.request('get', '/api/articles/counts'), { [status]: 1 });
  });
}

test('only an absent status receives the existing legacy Draft fallback', async context => {
  const state = installCountsFixture(context);
  const docs = seedStory(state, { languages: ['en', 'hi'] });
  delete docs[0].status;
  for (const status of [null, '', 'PUBLISHED', 'unknown']) seedStory(state, { status });
  assertCounts(await state.request('get', '/api/articles/counts'), { draft: 1, mixed: 4 });
  assertCounts(await state.request('get', '/api/articles/counts?status=draft'), { draft: 1 });
});

test('scheduled clocks and historical publishedAt do not replace persisted editorial status', async context => {
  const state = installCountsFixture(context);
  seedStory(state, { status: 'draft', publishedAt: new Date('2020-01-01') });
  seedStory(state, { status: 'scheduled', scheduledAt: new Date('2020-01-01') });
  seedStory(state, { status: 'published', publishAt: new Date('2099-01-01'), embargoUntil: new Date('2099-01-01') });
  assertCounts(await state.request('get', '/api/articles/counts'), { draft: 1, scheduled: 1, published: 1 });
});

for (const statuses of [
  ['published', 'draft'], ['published', 'scheduled'], ['draft', 'scheduled'],
  ['deleted', 'published'], ['deleted', 'draft'], ['archived', 'published'],
]) {
  test(`${statuses.join('+')} is counted once as mixed, not an error or several buckets`, async context => {
    const state = installCountsFixture(context);
    const docs = seedStory(state, { languages: ['gu', 'en'] });
    statuses.forEach((status, index) => {
      docs[index].status = status;
      docs[index].deletedAt = status === 'deleted' ? new Date('2026-03-01') : null;
    });
    assertCounts(await state.request('get', '/api/articles/counts'), { mixed: 1 });
  });
}

test('all-deleted legacy editions count once despite missing dates and different previous statuses', async context => {
  const state = installCountsFixture(context);
  const docs = seedStory(state, { languages: ['en', 'hi', 'gu'], status: 'deleted' });
  docs[0].deletedFromStatus = 'published';
  docs[1].deletedFromStatus = 'draft';
  docs[2].deletedFromStatus = 'scheduled';
  delete docs[0].deletedAt;
  docs[1].deletedAt = null;
  assertCounts(await state.request('get', '/api/articles/counts?status=deleted'), { deleted: 1 });
});

test('a deletion marker on a non-deleted edition is mixed, not live or fully deleted', async context => {
  const state = installCountsFixture(context);
  const docs = seedStory(state, { languages: ['en', 'hi'], status: 'published' });
  docs[1].deletedAt = new Date('2026-03-01');
  assertCounts(await state.request('get', '/api/articles/counts?status=published'), { mixed: 1 });
});

test('actual restored mixed state remains untouched and is counted once', async context => {
  const state = installCountsFixture(context);
  const { ids } = seedGroup(state, { status: 'deleted' });
  ['published', 'draft', 'scheduled'].forEach((status, index) => {
    state.rows.News[index].deletedFromStatus = status;
  });
  const restored = await state.request('post', `/api/articles/${ids[0]}/restore`, {});
  assert.equal(restored.statusCode, 200, restored.text);
  assert.deepEqual(state.rows.News.map(doc => doc.status), ['published', 'draft', 'scheduled']);
  state.calls.length = 0;
  state.reads.length = 0;
  state.transactions.length = 0;
  state.transactionOptions.length = 0;
  state.invalidations.length = 0;
  const before = structuredClone(state.rows);
  assertCounts(await state.request('get', '/api/articles/counts'), { mixed: 1 });
  assertReadOnly(state, before);
});

for (const query of ['lang=en', 'language=en&status=published', 'q=only-selected-edition', 'status=deleted']) {
  test(`selection ${query} cannot hide conflicting sibling status`, async context => {
    const state = installCountsFixture(context);
    const docs = seedStory(state, { languages: ['en', 'hi'], status: 'published' });
    docs[0].title = 'only-selected-edition';
    docs[1].status = query === 'status=deleted' ? 'deleted' : 'draft';
    if (docs[1].status === 'deleted') docs[1].deletedAt = new Date('2026-03-01');
    assertCounts(await state.request('get', `/api/articles/counts?${query}`), { mixed: 1 });
  });
}

for (const query of ['', '?lang=en', '?lang=gu']) {
  test(`overlapping nonidentical lifecycle membership fails explicitly for selection ${query || 'all'}`, async context => {
    const state = installCountsFixture(context);
    const docs = seedStory(state, { languages: ['en', 'hi'], identity: 'source' });
    docs[0].translationKey = 'first';
    docs[1].translationKey = 'second';
    seedStory(state, { languages: ['gu'], identity: 'none', translationKey: 'second' });
    const before = structuredClone(state.rows);
    const response = await state.request('get', `/api/articles/counts${query}`);
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.code, 'ARTICLE_LOGICAL_IDENTITY_CONFLICT');
    assert.equal(response.body.data, undefined);
    assert.ok(!response.text.includes(docs[0]._id));
    assertReadOnly(state, before);
  });
}

for (const field of ['translationKey', 'translationGroupId']) {
  test(`legacy array membership in ${field} cannot silently split an overlapping identity`, async context => {
    const state = installCountsFixture(context);
    const docs = seedStory(state, { identity: 'none', languages: ['en', 'hi'] });
    docs[0][field] = 'shared-key';
    docs[1][field] = ['shared-key'];
    const response = await state.request('get', '/api/articles/counts?lang=en');
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, 'ARTICLE_LOGICAL_IDENTITY_CONFLICT');
    assert.equal(response.body.data, undefined);
  });
}

function seedFilterStories(state) {
  const [first] = seedStory(state, {
    languages: ['en', 'hi', 'gu'], status: 'published', category: 'tech', createdAt: new Date('2026-01-10'),
    location: { state: 'Gujarat', stateSlug: 'gujarat', district: 'Ahmedabad', city: 'Ahmedabad' },
  });
  first.title = 'Needle [v1]';
  const [second] = seedStory(state, {
    languages: ['en', 'hi'], category: 'science-and-technology', createdAt: new Date('2026-01-20'),
    location: { state: 'Gujarat', district: 'Surat', city: 'Surat' },
  });
  second.description = 'Summary marker';
  seedStory(state, {
    status: 'scheduled', category: 'regional', createdAt: new Date('2026-02-01'),
    location: { state: 'Maharashtra', district: 'Pune', city: 'Pune' },
  });
  seedStory(state, {
    languages: ['hi'], status: 'published', category: 'breaking', createdAt: new Date('2026-02-05'),
    location: { state: ' Gujarat ', district: ' Surat ', city: 'Surat' },
  });
  seedStory(state, {
    languages: ['gu'], status: 'deleted', category: 'business', createdAt: new Date('2026-03-10'),
    location: { state: 'Gujarat', district: 'Surat', city: 'Surat' },
  });
  seedStory(state, { status: 'archived', category: 'national', createdAt: new Date('2026-03-20') });
  const [legacy] = seedStory(state, { identity: 'none', createdAt: new Date('2026-04-01') });
  delete legacy.status;
  seedStory(state, {
    status: 'published', category: 'tech', createdAt: new Date('2026-05-01'),
    content: '<p>Content marker</p>', location: { state: 'Assam' },
  });
}

for (const [query, stories, records] of [
  ['', 8, 11],
  ['status=all', 8, 11],
  ['status=published', 3, 5],
  ['status=draft', 2, 3],
  ['status=scheduled', 1, 1],
  ['status=deleted', 1, 1],
  ['status=archived', 1, 1],
  ['status=published,draft', 5, 8],
  ['status=%20PUBLISHED%20', 3, 5],
  ['lang=hi', 3, 3],
  ['language=gujarati', 2, 2],
  ['lang=en&language=hi', 6, 6],
  ['lang=invalid', 8, 11],
  ['category=science_and_technology', 3, 6],
  ['category=regional', 2, 2],
  ['category=business', 1, 1],
  ['category=all', 0, 0],
  ['q=needle%20%5Bv1%5D', 1, 1],
  ['q=Needle.*', 0, 0],
  ['q=Summary%20marker', 1, 1],
  ['q=Content%20marker', 1, 1],
  ['lang=hi&q=needle%20%5Bv1%5D', 0, 0],
  ['from=2026-01-15&to=2026-02-05', 3, 4],
  ['to=2026-01-10', 1, 3],
  ['from=invalid&to=invalid', 8, 11],
  ['state=Gujarat', 2, 4],
  ['state=Gujarat&status=all', 4, 7],
  ['state=Gujarat&status=draft', 1, 2],
  ['district=Surat', 1, 1],
  ['city=Ahmedabad', 1, 3],
  ['state=Maharashtra', 0, 0],
  ['state=Maharashtra&status=all', 1, 1],
  ['state=Gujarat&district=Surat&city=Surat&status=all&lang=hi', 2, 2],
  ['deleted=1', 8, 11],
]) {
  test(`counts preserve list filter semantics for ${query || 'the default selection'}`, async context => {
    const state = installCountsFixture(context);
    seedFilterStories(state);
    const counts = await state.request('get', `/api/articles/counts?${query}`);
    assert.equal(counts.statusCode, 200, counts.text);
    assert.equal(counts.body.data.total, stories);
    assert.equal(Object.values(counts.body.data.counts).reduce((sum, value) => sum + value, 0), stories);
    const selection = state.reads[0].filter;
    state.reads.length = 0;
    const list = await state.request('get', `/api/articles?${query}&limit=100`);
    assert.equal(list.statusCode, 200, list.text);
    assert.deepEqual(state.reads[0].filter, selection);
    assert.equal(list.body.total, records);
    assert.equal(list.body.data.total, records);
    assert.equal(list.body.items.length, records);
  });
}

for (const status of ['mixed', 'invalid', 'draft,invalid', 'all,published']) {
  test(`invalid status selection ${status} retains the list's 400 response`, async context => {
    const state = installCountsFixture(context);
    for (const path of ['/api/articles', '/api/articles/counts']) {
      const response = await state.request('get', `${path}?status=${status}`);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body, { ok: false, success: false, message: 'Invalid status filter' });
    }
    assert.equal(state.reads.length, 0);
    assert.equal(state.transactions.length, 0);
  });
}

test('an empty valid selection returns all six explicit zero buckets', async context => {
  const state = installCountsFixture(context);
  seedStory(state);
  const before = structuredClone(state.rows);
  assertCounts(await state.request('get', '/api/articles/counts?q=no-matching-content'), {});
  assert.equal(state.reads.length, 1);
  assertReadOnly(state, before);
});

test('full-dataset counts ignore pagination and batch identity reads without changing list totals', async context => {
  const state = installCountsFixture(context);
  for (let index = 0; index < 230; index += 1) {
    seedStory(state, { languages: ['en', 'hi', 'gu'].slice(0, index % 3 + 1), status: 'published' });
  }
  const before = structuredClone(state.rows);
  assertCounts(await state.request('get', '/api/articles/counts?status=published&page=17&pageSize=7&sort=createdAt'), { published: 230 });
  assert.ok(state.reads.length <= 6, `${state.reads.length} reads for 230 stories`);
  assertReadOnly(state, before);
  const list = await state.request('get', '/api/articles?status=published&page=17&pageSize=7&sort=createdAt');
  assert.equal(list.statusCode, 200, list.text);
  assert.equal(list.body.total, 459);
  assert.equal(list.body.data.total, 459);
  assert.equal(list.body.page, 17);
  assert.equal(list.body.limit, 7);
  assert.equal(list.body.items.length, 7);
  assert.deepEqual(list.body.sort, { publishedAt: -1, _id: -1 });
  const expectedIds = state.rows.News.map(doc => doc._id).sort().reverse().slice(112, 119);
  assert.deepEqual(list.body.items.map(doc => doc._id), expectedIds);
  assert.deepEqual(state.rows, before);
});

test('list parsing retains malformed-sort handling before the Published-only override', async context => {
  const state = installCountsFixture(context);
  seedStory(state, { status: 'published' });
  const before = structuredClone(state.rows);
  const query = '?status=published&sort[toString]=invalid';
  const list = await state.request('get', `/api/articles${query}`);
  assert.equal(list.statusCode, 500, list.text);
  assert.equal(state.reads.length, 0);
  assertCounts(await state.request('get', `/api/articles/counts${query}`), { published: 1 });
  assertReadOnly(state, before);
});

for (const path of ['/api/articles', '/admin-api/admin/articles', '/admin-api/articles']) {
  test(`authenticated ${path} retains page=0, record totals and updatedAt sorting`, async context => {
    const state = installCountsFixture(context);
    const docs = seedStory(state, { languages: ['en', 'hi', 'gu'] });
    docs[0].updatedAt = new Date('2026-01-01');
    docs[1].updatedAt = new Date('2026-02-01');
    docs[2].updatedAt = new Date('2026-03-01');
    const response = await state.request('get', `${path}?page=0&limit=2&sort=-updatedAt`);
    assert.equal(response.statusCode, 200, response.text);
    assert.equal(response.body.page, 1);
    assert.equal(response.body.limit, 2);
    assert.equal(response.body.total, 3);
    assert.equal(response.body.data.total, 3);
    assert.deepEqual(response.body.sort, { updatedAt: -1 });
    assert.deepEqual(response.body.items.map(doc => doc._id), [docs[2]._id, docs[1]._id]);
    assertCounts(await state.request('get', `${path}/counts?page=0&limit=2&sort=-updatedAt`), { draft: 1 });
  });
}

for (const path of [
  '/articles/counts', '/api/articles/counts', '/api/admin/articles/counts',
  '/admin-api/admin/articles/counts', '/admin-api/api/admin/articles/counts',
  '/admin-api/articles/counts', '/admin-api/api/articles/counts',
]) {
  test(`static ${path} precedes article-ID handling and retains Admin authentication`, async context => {
    const state = installCountsFixture(context);
    seedStory(state, { languages: ['en', 'hi'], status: 'published' });
    const denied = await state.request('get', path, undefined, null);
    assert.equal(denied.statusCode, 401);
    assert.equal(state.reads.length, 0);
    const response = await state.request('get', path, undefined, 'editor');
    assertCounts(response, { published: 1 });
    assert.equal(response.headers['cache-control'], 'private, no-store');
    assert.ok(state.calls.every(call => call.method === 'find'));
  });
}

for (const [failure, status, code] of [
  [{ name: 'MongoNetworkError' }, 503, 'ARTICLES_UNAVAILABLE'],
  [{ name: 'MongoServerError', code: 50 }, 503, 'ARTICLES_UNAVAILABLE'],
  [{ name: 'Error', message: 'Private query detail' }, 500, 'ARTICLES_QUERY_FAILED'],
]) {
  test(`a ${failure.name} query failure is explicit, never successful zero counts`, async context => {
    const state = installCountsFixture(context);
    seedStory(state);
    state.failures['News.find'] = { ...failure, once: true };
    const before = structuredClone(state.rows);
    const response = await state.request('get', '/api/articles/counts');
    assert.equal(response.statusCode, status);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.success, false);
    assert.equal(response.body.code, code);
    assert.equal(response.body.data, undefined);
    assert.ok(!response.text.includes('Private query detail'));
    assert.deepEqual(state.rows, before);
    assert.equal(state.transactions[0].ended, true);
  });
}

test('failure while expanding sibling membership cannot return partial counts', async context => {
  const state = installCountsFixture(context);
  seedStory(state, { languages: ['en', 'hi'], status: 'published' });
  const find = models.News.find;
  context.mock.method(models.News, 'find', (...args) => {
    if (state.reads.length === 1) throw Object.assign(new Error('Synthetic read failure'), { name: 'MongoNetworkError' });
    return find(...args);
  });
  const response = await state.request('get', '/api/articles/counts?lang=en');
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.data, undefined);
});

test('snapshot-session and session-cleanup failures remain explicit', async context => {
  const state = installCountsFixture(context);
  context.mock.method(mongoose, 'startSession', async () => {
    throw Object.assign(new Error('Synthetic session failure'), { name: 'MongoNotConnectedError' });
  });
  let response = await state.request('get', '/api/articles/counts');
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.ok, false);
  context.mock.method(mongoose, 'startSession', async () => ({
    async withTransaction(work) { await work(); },
    async endSession() { throw new Error('Synthetic session cleanup failure'); },
  }));
  response = await state.request('get', '/api/articles/counts');
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.data, undefined);
});

test('disconnected authentication/database is an explicit failure without article reads', async context => {
  const state = installCountsFixture(context);
  mongoose.connection.readyState = 0;
  const response = await state.request('get', '/api/articles/counts');
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.data, undefined);
  assert.equal(state.reads.length, 0);
});

test('counts do not write articles, timestamps, jobs, public copies, audit rows or invalidations', async context => {
  const state = installCountsFixture(context);
  for (const status of ['published', 'draft', 'scheduled', 'deleted', 'archived']) {
    seedStory(state, { languages: ['en', 'hi', 'gu'], status });
  }
  const mixed = seedStory(state, { languages: ['en', 'hi'] });
  mixed[0].status = 'published';
  state.rows.TranslationJob.push({ _id: 'existing-job', status: 'review_required' });
  state.rows.Article.push({ _id: 'existing-public-copy', status: 'draft', publishedAt: new Date('2020-01-01') });
  state.rows.AuditLog.push({ _id: 'existing-audit' });
  const before = structuredClone(state.rows);
  const invalidations = [];
  context.after(onArticleCachesInvalidated(event => invalidations.push(event)));
  assertCounts(await state.request('get', '/api/articles/counts'), {
    published: 1, draft: 1, scheduled: 1, deleted: 1, archived: 1, mixed: 1,
  });
  assertReadOnly(state, before);
  assert.deepEqual(invalidations, []);
});
