require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { installEditorialFixture, seedGroup, models } = require('./helpers/editorialLifecycleFixture');
const { createBackgroundTasks } = require('../lib/backgroundTasks');
const { createTranslationJobLease, TRANSLATION_LEASE_MS } = require('../services/translationJobLease.service');
const { createPublishTranslationWorker, translateAndSave, enqueueTranslateAndSave } = require('../services/publishAsyncTranslation.service');
const { publishDueScheduledArticles, refreshDuePublicArticleVisibility } = require('../services/scheduledPublication.service');
const googleTranslate = require('../services/googleTranslate.service');

process.env.GOOGLE_TRANSLATE_API_KEY = 'worker-fixture-only';
const quiet = { info() {}, log() {}, warn() {}, error() {} };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function install(context, { status = 'published', ready = true } = {}) {
  const state = installEditorialFixture(context);
  const { ids } = seedGroup(state, { status });
  const clock = { time: Date.now(), now: () => new Date(clock.time) };
  const source = state.rows.News[0];
  if (ready) {
    for (const lang of ['en', 'hi', 'gu']) {
      source.translations[lang] = {
        title: `${lang} title`, summary: `${lang} summary`, content: `<p>${lang} content</p>`,
        provider: 'google', generatedAt: new Date(),
      };
      source.translationStatus[lang] = 'ready';
    }
  }
  const job = {
    _id: '807f1f77bcf86cd79943a001', type: 'news-publish-translate',
    newsId: ids[0], status: 'queued', runAt: clock.now(),
    attempts: 0, lockedAt: null, lockedBy: null,
  };
  state.rows.TranslationJob.push(job);
  for (const Model of [models.News, models.Article, models.TranslationJob]) {
    for (const method of ['createCollection', 'syncIndexes', 'createIndexes', 'ensureIndexes']) {
      context.mock.method(Model, method, () => assert.fail('Worker execution must not change indexes or collections'));
    }
  }
  let tail = Promise.resolve();
  context.mock.method(mongoose, 'startSession', async () => {
    const session = {
      async withTransaction(work) {
        const previous = tail;
        let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        const before = structuredClone(state.rows);
        try { await work(); session.committed = true; }
        catch (error) { state.rows = before; session.aborted = true; throw error; }
        finally { release(); }
      },
      async endSession() { session.ended = true; },
    };
    state.transactions.push(session);
    return session;
  });
  return { state, ids, job, source, clock };
}

function ownedLease(context, fixture, owner = 'owner-a') {
  Object.assign(fixture.job, {
    status: 'running', lockedAt: fixture.clock.now(), lockedBy: owner, attempts: 1,
  });
  const tasks = createBackgroundTasks();
  const lease = createTranslationJobLease(structuredClone(fixture.job), {
    owner, signal: tasks.signal, now: fixture.clock.now, logger: quiet,
  });
  context.after(() => lease.dispose());
  return { lease, tasks };
}

function worker(context, fixture, options = {}) {
  const tasks = options.tasks || createBackgroundTasks();
  const instance = createPublishTranslationWorker({
    logger: quiet, tasks, now: fixture.clock.now, isConfigured: () => true,
    translate: async () => ({ ok: true }), ...options,
  });
  context.after(() => instance.stop());
  return instance;
}

function overlapCandidateReads(context, status) {
  const selected = deferred();
  let count = 0;
  const find = models.News.find;
  context.mock.method(models.News, 'find', (filter, ...args) => {
    const query = find(filter, ...args);
    if (filter?.status !== status) return query;
    const then = query.then.bind(query);
    const lean = query.lean.bind(query);
    const waitForBoth = async rows => {
      count += 1;
      if (count === 2) selected.resolve();
      await selected.promise;
      return rows;
    };
    query.then = (resolve, reject) => then(waitForBoth).then(resolve, reject);
    query.lean = () => lean().then(waitForBoth);
    return query;
  });
  return () => count;
}

for (const field of ['_id', 'newsId', 'status', 'type', 'lockedAt', 'lockedBy', 'attempts']) {
  test(`malformed claims without ${field} never acquire local worker authority`, context => {
    const fixture = install(context);
    ownedLease(context, fixture);
    const invalid = structuredClone(fixture.job);
    delete invalid[field];
    assert.throws(() => createTranslationJobLease(invalid, { owner: 'owner-a' }), {
      code: 'TRANSLATION_JOB_CLAIM_INVALID',
    });
  });
}

test('overlapping workers claim a queued translation only once', async context => {
  const fixture = install(context);
  let calls = 0;
  const options = { translate: async () => { calls += 1; await turn(); return { ok: true }; } };
  const a = worker(context, fixture, options);
  const b = worker(context, fixture, options);
  await Promise.all([a.tick(), b.tick()]);
  await Promise.all([a.stop(), b.stop()]);
  assert.equal(calls, 1);
  assert.equal(fixture.state.rows.TranslationJob[0].status, 'done');
  assert.equal(fixture.state.rows.TranslationJob[0].attempts, 1);
});

test('a stale execution cannot acknowledge a job reclaimed and completed by a newer worker', async context => {
  const fixture = install(context);
  const entered = deferred();
  const finish = deferred();
  context.after(() => finish.resolve());
  const a = worker(context, fixture, {
    translate: async () => { entered.resolve(); await finish.promise; return { ok: true }; },
  });
  await a.tick();
  await entered.promise;
  const oldOwner = fixture.state.rows.TranslationJob[0].lockedBy;
  fixture.clock.time += TRANSLATION_LEASE_MS;
  const b = worker(context, fixture);
  await b.tick();
  await b.stop();
  const completed = structuredClone(fixture.state.rows.TranslationJob[0]);
  assert.equal(completed.status, 'done');
  assert.equal(completed.attempts, 2);
  finish.resolve();
  await a.stop();
  assert.deepEqual(fixture.state.rows.TranslationJob[0], completed);
  const claims = fixture.state.calls.filter(call => call.name === 'TranslationJob' && call.method === 'updateOne');
  assert.ok(claims.some(call => call.filter.lockedBy === oldOwner && call.filter.attempts === 1));
});

test('reenqueue revokes a running claim without letting its late result overwrite the new owner', async context => {
  const fixture = install(context);
  const entered = deferred();
  const finish = deferred();
  context.after(() => finish.resolve());
  const a = worker(context, fixture, {
    translate: async () => { entered.resolve(); await finish.promise; return { ok: true }; },
  });
  await a.tick();
  await entered.promise;
  await enqueueTranslateAndSave(fixture.ids[0], { throwOnError: true, logger: quiet });
  fixture.clock.time = Math.max(Date.now(), fixture.clock.time);
  const b = worker(context, fixture);
  await b.tick();
  await b.stop();
  const newer = structuredClone(fixture.state.rows.TranslationJob[0]);
  assert.equal(newer.attempts, 2);
  finish.resolve();
  await a.stop();
  assert.deepEqual(fixture.state.rows.TranslationJob[0], newer);
});

test('polling is single-flight and slow claims cannot exceed the per-process concurrency limit', async context => {
  const fixture = install(context);
  for (let index = 2; index <= 4; index += 1) {
    fixture.state.rows.TranslationJob.push({
      ...structuredClone(fixture.job), _id: `807f1f77bcf86cd79943a00${index}`,
    });
  }
  const claimGate = deferred();
  const workGate = deferred();
  context.after(() => { claimGate.resolve(); workGate.resolve(); });
  const find = models.TranslationJob.findOneAndUpdate;
  let pendingClaims = 0;
  let maxClaims = 0;
  context.mock.method(models.TranslationJob, 'findOneAndUpdate', (...args) => ({
    async lean() {
      pendingClaims += 1;
      maxClaims = Math.max(maxClaims, pendingClaims);
      await claimGate.promise;
      try { return await find(...args).lean(); }
      finally { pendingClaims -= 1; }
    },
  }));
  const instance = worker(context, fixture, {
    concurrency: 2, translate: async () => { await workGate.promise; return { ok: true }; },
  });
  const first = instance.tick();
  assert.equal(instance.tick(), first);
  await turn();
  assert.equal(pendingClaims, 1);
  claimGate.resolve();
  await first;
  assert.equal(instance.activeCount, 2);
  assert.equal(maxClaims, 1);
  assert.equal(fixture.state.rows.TranslationJob.filter(job => job.status === 'running').length, 2);
  workGate.resolve();
  await instance.stop();
});

test('shutdown during an outstanding claim returns it without starting translation', async context => {
  const fixture = install(context);
  const gate = deferred();
  context.after(() => gate.resolve());
  const find = models.TranslationJob.findOneAndUpdate;
  context.mock.method(models.TranslationJob, 'findOneAndUpdate', (...args) => ({
    async lean() { await gate.promise; return find(...args).lean(); },
  }));
  let translated = 0;
  const instance = worker(context, fixture, { translate: async () => { translated += 1; } });
  const polling = instance.tick();
  await turn();
  const stopped = instance.stop();
  gate.resolve();
  await Promise.all([polling, stopped]);
  assert.equal(translated, 0);
  assert.equal(fixture.state.rows.TranslationJob[0].status, 'queued');
  assert.equal(fixture.state.rows.TranslationJob[0].lockedBy, null);
  await instance.tick();
  assert.equal(translated, 0);
});

test('graceful worker stop drains its accepted job without releasing the lease early', async context => {
  const fixture = install(context);
  const gate = deferred();
  context.after(() => gate.resolve());
  const instance = worker(context, fixture, { translate: async () => { await gate.promise; return { ok: true }; } });
  await instance.tick();
  let drained = false;
  const stopped = instance.stop().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  assert.equal(fixture.state.rows.TranslationJob[0].status, 'running');
  assert.ok(fixture.state.rows.TranslationJob[0].lockedBy);
  gate.resolve();
  await stopped;
  assert.equal(fixture.state.rows.TranslationJob[0].status, 'done');
});

test('a failed source reload is retried and is never reported as a completed translation', async context => {
  const fixture = install(context);
  fixture.state.failures['News.findById'] = { code: 'SYNTHETIC_READ_FAILED' };
  const instance = worker(context, fixture);
  await instance.tick();
  await instance.stop();
  const saved = fixture.state.rows.TranslationJob[0];
  assert.equal(saved.status, 'queued');
  assert.equal(new Date(saved.runAt).getTime(), fixture.clock.time + 120_000);
  assert.ok(saved.lastError);
});

test('failed translation results are retried rather than silently marked done', async context => {
  const fixture = install(context);
  const instance = worker(context, fixture, { translate: async () => ({ ok: false, error: 'Synthetic provider failure' }) });
  await instance.tick();
  await instance.stop();
  assert.equal(fixture.state.rows.TranslationJob[0].status, 'queued');
  assert.equal(fixture.state.rows.TranslationJob[0].lastError, 'Synthetic provider failure');
});

for (const change of ['owner', 'attempt', 'status', 'expiry', 'source', 'type']) {
  test(`translation write fencing rejects a changed ${change}`, async context => {
    const fixture = install(context);
    const { lease } = ownedLease(context, fixture);
    if (change === 'owner') fixture.job.lockedBy = 'owner-b';
    if (change === 'attempt') fixture.job.attempts += 1;
    if (change === 'status') fixture.job.status = 'queued';
    if (change === 'expiry') fixture.clock.time += TRANSLATION_LEASE_MS;
    if (change === 'source') fixture.job.newsId = fixture.ids[1];
    if (change === 'type') fixture.job.type = 'article-translation-generate';
    const before = structuredClone(fixture.state.rows);
    await assert.rejects(lease.fence({}), { code: 'TRANSLATION_JOB_LEASE_LOST' });
    assert.deepEqual(fixture.state.rows, before);
  });
}

test('lease heartbeat renews long work and stops after ownership is lost', async context => {
  const fixture = install(context);
  const { lease } = ownedLease(context, fixture);
  context.mock.timers.enable({ apis: ['setInterval'] });
  lease.startHeartbeat();
  fixture.clock.time += TRANSLATION_LEASE_MS / 3;
  context.mock.timers.tick(TRANSLATION_LEASE_MS / 3);
  await turn();
  assert.equal(new Date(fixture.job.lockedAt).getTime(), fixture.clock.time);
  fixture.job.lockedBy = 'owner-b';
  fixture.clock.time += TRANSLATION_LEASE_MS / 3;
  context.mock.timers.tick(TRANSLATION_LEASE_MS / 3);
  await turn();
  assert.equal(lease.signal.aborted, true);
  assert.equal(fixture.job.lockedBy, 'owner-b');
  await lease.stopHeartbeat();
});

for (const mode of ['pending', 'cached-repair', 'stuck-pending']) {
  test(`stale ${mode} translation work cannot persist any News or Article changes`, async context => {
    const fixture = install(context, { ready: mode === 'cached-repair' });
    const { lease } = ownedLease(context, fixture);
    if (mode === 'cached-repair') fixture.source.translations.hi.provider = null;
    if (mode === 'stuck-pending') {
      fixture.source.translationStatus.hi = 'pending';
      fixture.source.translationUpdatedAt = { hi: new Date(Date.now() - 11 * 60_000) };
    }
    fixture.job.lockedBy = 'owner-b';
    const before = structuredClone(fixture.state.rows);
    context.mock.method(googleTranslate, 'translateMany', () => assert.fail('A stale claim must not call the provider'));
    await assert.rejects(translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet }), { code: 'TRANSLATION_JOB_LEASE_LOST' });
    assert.deepEqual(fixture.state.rows, before);
    assert.equal(fixture.state.calls.some(call => ['News', 'Article'].includes(call.name)
      && ['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate'].includes(call.method)), false);
  });
}

for (const outcome of ['success', 'failure']) {
  test(`an in-flight provider ${outcome} cannot overwrite a newer owner's edition data`, async context => {
    const fixture = install(context, { ready: false });
    const { lease } = ownedLease(context, fixture);
    const entered = deferred();
    const provider = deferred();
    context.after(() => provider.resolve({ ok: false, error: 'interrupted fixture' }));
    context.mock.method(googleTranslate, 'translateMany', async () => { entered.resolve(); return provider.promise; });
    const running = translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet });
    await entered.promise;
    const currentJob = fixture.state.rows.TranslationJob[0];
    currentJob.lockedBy = 'owner-b';
    currentJob.attempts += 1;
    fixture.state.rows.News[0].translations.hi = { title: 'Newer title', summary: 'Newer summary', content: 'Newer content' };
    const before = structuredClone(fixture.state.rows);
    provider.resolve(outcome === 'success'
      ? { ok: true, items: ['Old title', 'Old summary', 'Old content'] }
      : { ok: false, error: 'Synthetic provider error' });
    await assert.rejects(running, { code: 'TRANSLATION_JOB_LEASE_LOST' });
    assert.deepEqual(fixture.state.rows, before);
  });
}

test('forced interruption retains a recoverable claim and rejects late translation results', async context => {
  const fixture = install(context, { ready: false });
  const { lease, tasks } = ownedLease(context, fixture);
  const entered = deferred();
  const provider = deferred();
  context.after(() => provider.resolve({ ok: false, error: 'interrupted fixture' }));
  context.mock.method(googleTranslate, 'translateMany', async () => { entered.resolve(); return provider.promise; });
  const running = translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet });
  await entered.promise;
  tasks.abort();
  const before = structuredClone(fixture.state.rows);
  provider.resolve({ ok: true, items: ['Old title', 'Old summary', 'Old content'] });
  await assert.rejects(running, { code: 'WORKER_SHUTDOWN' });
  assert.deepEqual(fixture.state.rows, before);
  assert.equal(fixture.state.rows.TranslationJob[0].status, 'running');
  fixture.clock.time += TRANSLATION_LEASE_MS;
  const replacement = worker(context, fixture);
  await replacement.tick();
  await replacement.stop();
  assert.equal(fixture.state.rows.TranslationJob[0].attempts, 2);
});

test('an in-flight translation cannot overwrite a changed base-language identity', async context => {
  const fixture = install(context, { ready: false });
  const { lease } = ownedLease(context, fixture);
  const entered = deferred();
  const provider = deferred();
  context.after(() => provider.resolve({ ok: false, error: 'interrupted fixture' }));
  context.mock.method(googleTranslate, 'translateMany', async () => { entered.resolve(); return provider.promise; });
  const running = translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet });
  await entered.promise;
  fixture.state.rows.News[0].originalLang = 'gu';
  const before = structuredClone(fixture.state.rows);
  provider.resolve({ ok: true, items: ['Stale title', 'Stale summary', 'Stale content'] });
  await assert.rejects(running, { code: 'TRANSLATION_SOURCE_CHANGED' });
  assert.deepEqual(fixture.state.rows, before);
});

test('authorized translation changes retain identities and fence every edition/copy write in its transaction', async context => {
  const fixture = install(context, { ready: false });
  const { lease } = ownedLease(context, fixture);
  const ids = fixture.state.rows.News.map(doc => doc._id);
  const copyIds = fixture.state.rows.Article.map(doc => doc._id);
  const dates = fixture.state.rows.News.map(doc => doc.publishedAt);
  let calls = 0;
  context.mock.method(googleTranslate, 'translateMany', async (q, language) => {
    calls += 1;
    const text = language === 'hi' ? '\u0939\u093f\u0902\u0926\u0940' : '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0';
    return { ok: true, items: q.map((_value, index) => `${text} ${index}`) };
  });
  await translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet });
  assert.equal(calls, 1, 'Group synchronization reuses the existing GU edition rather than translating it again');
  assert.equal(fixture.state.rows.News[0].translationStatus.gu, 'ready');
  assert.deepEqual(fixture.state.rows.News.map(doc => doc._id), ids);
  assert.deepEqual(fixture.state.rows.Article.map(doc => doc._id), copyIds);
  assert.deepEqual(fixture.state.rows.News.map(doc => doc.publishedAt), dates);
  for (const transaction of fixture.state.transactions) {
    const writes = fixture.state.calls.filter(call => call.options?.session === transaction
      && ['save', 'updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate'].includes(call.method));
    assert.equal(writes[0]?.name, 'TranslationJob');
    assert.equal(writes[0]?.filter.lockedBy, 'owner-a');
    assert.ok(transaction.committed);
  }
  assert.ok(fixture.state.calls.some(call => call.name === 'Article' && call.options?.session));
});

test('transaction retries recheck ownership and discard effects from an aborted translation attempt', async context => {
  const fixture = install(context, { ready: false });
  const { lease } = ownedLease(context, fixture);
  context.mock.method(googleTranslate, 'translateMany', async q => ({ ok: true, items: q.map(() => 'Synthetic translated text') }));
  let retried = false;
  let winner;
  context.mock.method(mongoose, 'startSession', async () => ({
    async withTransaction(work) {
      const before = structuredClone(fixture.state.rows);
      const callIndex = fixture.state.calls.length;
      await work();
      const translated = fixture.state.calls.slice(callIndex).some(call => call.name === 'News' && call.method === 'findByIdAndUpdate');
      if (!translated || retried) return;
      retried = true;
      fixture.state.rows = before;
      Object.assign(fixture.state.rows.TranslationJob[0], { lockedBy: 'owner-b', attempts: 2 });
      fixture.state.rows.News[0].translations.hi = { title: 'Winning title', summary: 'Winning summary', content: 'Winning content' };
      winner = structuredClone(fixture.state.rows);
      try { await work(); } catch (error) { fixture.state.rows = structuredClone(winner); throw error; }
    },
    async endSession() {},
  }));
  await assert.rejects(translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet }), { code: 'TRANSLATION_JOB_LEASE_LOST' });
  assert.equal(retried, true);
  assert.deepEqual(fixture.state.rows, winner);
  assert.equal(fixture.state.invalidations.length, 0);
});

test('shutdown aborts and rolls back a transaction after its fence but before commit', async context => {
  const fixture = install(context, { ready: false });
  const { lease, tasks } = ownedLease(context, fixture);
  const before = structuredClone(fixture.state.rows);
  const update = models.News.updateOne;
  context.mock.method(models.News, 'updateOne', async (...args) => {
    const result = await update(...args);
    tasks.abort();
    return result;
  });
  context.mock.method(googleTranslate, 'translateMany', () => assert.fail('An aborted pending transaction must not translate'));
  await assert.rejects(translateAndSave(fixture.ids[0], { jobLease: lease, logger: quiet }), { code: 'WORKER_SHUTDOWN' });
  assert.deepEqual(fixture.state.rows, before);
  assert.equal(fixture.state.transactions[0].aborted, true);
  assert.equal(fixture.state.transactions[0].ended, true);
});

test('unacknowledged ownership updates fail closed', async context => {
  const fixture = install(context);
  const { lease } = ownedLease(context, fixture);
  context.mock.method(models.TranslationJob, 'updateOne', async () => ({ acknowledged: false, matchedCount: 1 }));
  await assert.rejects(lease.fence({}), { code: 'TRANSLATION_JOB_LEASE_LOST' });
  assert.equal(lease.signal.aborted, true);
});

test('overlapping scheduler snapshots publish a GU/HI/EN group only once', async context => {
  const fixture = install(context, { status: 'scheduled' });
  for (const doc of fixture.state.rows.News) doc.scheduledAt = new Date('2020-01-01T00:00:00Z');
  const reads = overlapCandidateReads(context, 'scheduled');
  const ids = fixture.state.rows.News.map(doc => doc._id);
  const copies = fixture.state.rows.Article.map(doc => doc._id);
  const results = await Promise.all([
    publishDueScheduledArticles({ logger: quiet }),
    publishDueScheduledArticles({ logger: quiet }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.published, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);
  assert.equal(reads(), 2);
  assert.deepEqual(fixture.state.rows.News.map(doc => doc._id), ids);
  assert.deepEqual(fixture.state.rows.Article.map(doc => doc._id), copies);
  assert.ok(fixture.state.rows.News.every(doc => doc.status === 'published'
    && doc.workflowHistory.filter(event => event.action === 'PUBLISH').length === 1));
});

test('overlapping visibility refreshes act once and stale candidates perform no writes', async context => {
  const fixture = install(context);
  for (const doc of fixture.state.rows.News) {
    doc.publicVisibilityRefreshAt = new Date('2020-01-01T00:00:00Z');
    doc.embargoUntil = new Date('2020-01-01T00:00:00Z');
  }
  const reads = overlapCandidateReads(context, 'published');
  const results = await Promise.all([
    refreshDuePublicArticleVisibility({ logger: quiet }),
    refreshDuePublicArticleVisibility({ logger: quiet }),
  ]);
  assert.equal(results.reduce((sum, result) => sum + result.refreshed, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.failed, 0), 0);
  assert.equal(reads(), 2);
  assert.ok(fixture.state.rows.News.every(doc => doc.publicVisibilityRefreshAt === null));
  const writingTransactions = fixture.state.transactions.filter(session => fixture.state.calls.some(call =>
    call.name === 'News' && call.options?.session === session && call.method === 'updateMany'));
  assert.equal(writingTransactions.length, 1);
});

for (const change of ['published', 'archived', 'deleted', 'rescheduled', 'locked', 'embargoed']) {
  test(`the scheduler skips a ${change} candidate before making any writes`, async context => {
    const fixture = install(context, { status: 'scheduled' });
    fixture.source.scheduledAt = new Date('2020-01-01T00:00:00Z');
    const candidate = structuredClone(fixture.source);
    if (['published', 'archived', 'deleted'].includes(change)) fixture.source.status = change;
    if (change === 'rescheduled') fixture.source.scheduledAt = new Date(Date.now() + 60_000);
    if (change === 'locked') fixture.source.locked = true;
    if (change === 'embargoed') fixture.source.embargoUntil = new Date(Date.now() + 60_000);
    const before = structuredClone(fixture.state.rows);
    const stats = await publishDueScheduledArticles({
      logger: quiet, News: { find: () => ({ limit: () => [candidate] }) },
      publishCanonicalArticle: () => assert.fail('A stale candidate must not reach publication'),
    });
    assert.deepEqual(stats, { processed: 1, published: 0, failed: 0, skipped: 1 });
    assert.deepEqual(fixture.state.rows, before);
    assert.equal(fixture.state.calls.some(call => ['save', 'updateOne', 'updateMany', 'findOneAndUpdate'].includes(call.method)), false);
  });
}

test('scheduler retries do not reuse a stale scheduled decision or emit rolled-back publication effects', async context => {
  const fixture = install(context, { status: 'scheduled' });
  for (const doc of fixture.state.rows.News) doc.scheduledAt = new Date('2020-01-01T00:00:00Z');
  let interrupted = false;
  context.mock.method(mongoose, 'startSession', async () => ({
    async withTransaction(work) {
      const before = structuredClone(fixture.state.rows);
      await work();
      if (interrupted) return;
      interrupted = true;
      fixture.state.rows = before;
      for (const doc of [...fixture.state.rows.News, ...fixture.state.rows.Article]) doc.status = 'archived';
      await work();
    },
    async endSession() {},
  }));
  const stats = await publishDueScheduledArticles({ logger: quiet });
  assert.equal(stats.published, 0);
  assert.equal(stats.failed, 0);
  assert.ok(fixture.state.rows.News.every(doc => doc.status === 'archived' && doc.workflowHistory.length === 0));
  assert.equal(fixture.state.invalidations.length, 0);
});

test('a stopping scheduler finishes its current group but starts no further groups', async context => {
  const fixture = install(context, { status: 'scheduled' });
  for (const [index, doc] of fixture.state.rows.News.entries()) {
    doc.translationGroupId = `separate-${index}`;
    doc.translationKey = `separate-${index}`;
    doc.sourceArticleId = doc._id;
    doc.scheduledAt = new Date('2020-01-01T00:00:00Z');
  }
  let stopping = false;
  let calls = 0;
  const stats = await publishDueScheduledArticles({
    logger: quiet, isStopping: () => stopping,
    publishCanonicalArticle: async (_doc, options) => {
      assert.ok(options.session);
      assert.deepEqual(options.actor, { byUserId: null, byRole: 'SYSTEM' });
      stopping = true;
      calls += 1;
    },
  });
  assert.equal(calls, 1);
  assert.equal(stats.processed, 1);
});
