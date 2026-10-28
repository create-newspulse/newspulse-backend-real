// PowerShell opt-in: $env:NP_REAL_MONGO_TESTS='1'; $env:NODE_OPTIONS=''; $env:NODE_PATH=''
// node --test --test-concurrency=1 .\tests\integration\editorial_mongodb_transactions.test.js
const sandbox = require('../helpers/realMongoIsolation');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { mongoose, runId, commands } = sandbox;

let News, Article, User, lifecycle, publisher, founder, staff;
let sequence = 0;
const writeCommands = new Set(['insert', 'update', 'delete', 'findAndModify']);
const logger = console;
const plain = value => JSON.parse(JSON.stringify(value));

before(async () => {
  const preflight = await sandbox.open();
  console.log('REAL_MONGO_PREFLIGHT', JSON.stringify(preflight));
  News = require('../../models/News');
  Article = require('../../models/Article');
  User = require('../../models/User');
  publisher = require('../../services/articlePublishing.service');
  lifecycle = require('../../services/articleLifecycle.service');
  await sandbox.initializeModels();
  for (const role of ['founder', 'editor']) {
    const user = await User.create({
      email: `${runId}-${role}@example.invalid`, name: `Synthetic ${role}`,
      passwordHash: crypto.randomBytes(32).toString('hex'), staffId: `${runId}-${role}`,
      role, isFounder: role === 'founder', status: 'active', accountStatus: 'active',
      loginAllowed: true, sessionStatus: 'active', tokenVersion: 0,
      specialRightsConfigured: true, specialRightsOverride: [],
      moduleAccessStates: { manageNews: 'enabled', addNews: 'enabled', draftDesk: 'enabled' },
      isTestAccount: true, testAccountReason: 'Disposable real MongoDB transaction test',
    });
    if (role === 'founder') founder = user.toObject();
    else staff = user.toObject();
  }
});

beforeEach(() => {
  assert.deepEqual(sandbox.violations, [], 'Stop after any isolation violation');
});

after(async () => {
  const totals = {
    commits: commands.filter(event => event.name === 'commitTransaction' && event.succeeded).length,
    aborts: commands.filter(event => event.name === 'abortTransaction' && event.succeeded).length,
    writeConflicts: commands.filter(event => event.errorCode === 112).length,
  };
  const cleanup = await sandbox.cleanup();
  console.log('REAL_MONGO_RESULT', JSON.stringify({ ...totals, ...cleanup, isolationViolations: sandbox.violations.length }));
  assert.deepEqual(sandbox.violations, []);
});

function requestFor(user) {
  const admin = { id: String(user._id), role: user.role, tokenVersion: user.tokenVersion };
  return {
    admin, user: admin, _authUserDoc: user, body: {}, method: 'POST',
    originalUrl: '/synthetic-service-integration', headers: {},
  };
}

async function seedGroup(status = 'draft', historicalPublication = false) {
  const key = `${runId}-${++sequence}`;
  const ids = ['en', 'hi', 'gu'].map(() => new mongoose.Types.ObjectId());
  const copyIds = ids.map(() => new mongoose.Types.ObjectId());
  const languages = ['en', 'hi', 'gu'];
  const slugs = Object.fromEntries(languages.map(language => [language, `np-${key}-${language}`]));
  const publication = status === 'published' || historicalPublication ? new Date('2026-03-01T10:00:00Z') : null;
  const text = {
    en: 'Synthetic English editorial content for transaction verification',
    hi: '\u0939\u093f\u0928\u094d\u0926\u0940 '.repeat(5),
    gu: '\u0a97\u0ac1\u0a9c\u0ab0\u0abe\u0aa4\u0ac0 '.repeat(5),
  };
  for (const [index, language] of languages.entries()) {
    const common = {
      title: text[language], content: `<p>${text[language]}</p>`, category: 'business',
      slug: slugs[language], slugs, language, originalLang: language, sourceLanguage: 'en',
      translationGroupId: key, translationKey: key, sourceArticleId: ids[0],
      status, publishedAt: publication, deletedAt: null, syncVersion: 1,
      createdAt: new Date('2026-02-01T10:00:00Z'), updatedAt: new Date('2026-03-01T10:00:00Z'),
      coverImage: { url: `/uploads/${key}/${language}.jpg`, alt: `Synthetic ${language} cover` },
      coverImageUrl: `/uploads/${key}/${language}.jpg`,
    };
    await News.create({
      ...common, _id: ids[index], description: text[language], lang: language,
      createdByUserId: founder._id, workflowStage: status === 'published' ? 'PUBLISHED' : 'DRAFT',
      humanEdited: true, workflowHistory: [],
    });
    await Article.create({ ...common, _id: copyIds[index], summary: text[language], sourceNewsId: ids[index] });
  }
  return { ids, copyIds, publication, key };
}

async function snapshot(group) {
  return plain({
    news: await News.find({ _id: { $in: group.ids } }).sort({ _id: 1 }).lean(),
    copies: await Article.find({ _id: { $in: group.copyIds } }).sort({ _id: 1 }).lean(),
  });
}

async function sideEffects() {
  const rows = {};
  for (const name of ['TranslationJob', 'PublicConfigVersion', 'PushHistory']) {
    rows[name] = await mongoose.models[name].find({}).sort({ _id: 1 }).lean();
  }
  return plain(rows);
}

function protectedWritesSince(start) {
  const names = new Set(['News', 'Article', 'TranslationJob', 'PublicConfigVersion']
    .map(name => mongoose.models[name]?.collection.name).filter(Boolean));
  return commands.slice(start).filter(event => writeCommands.has(event.name) && names.has(event.collection));
}

function injectAfterWrite(context, model, method, failAt) {
  const original = model[method];
  let written = 0;
  context.mock.method(model, method, function (...args) {
    const query = original.apply(this, args);
    const execute = query.exec;
    query.exec = async function (...execArgs) {
      const result = await execute.apply(this, execArgs);
      assert.ok(this.getOptions().session?.inTransaction(), 'Fault injection must follow a real transactional write');
      if (++written === failAt) {
        throw Object.assign(new Error('Synthetic failure after a real MongoDB write'), { code: 'INJECTED_AFTER_WRITE' });
      }
      return result;
    };
    return query;
  });
  return () => written;
}

test('real transaction commits News and public-copy changes together', async () => {
  const group = await seedGroup();
  const start = commands.length;
  let effects = 0;
  const result = await lifecycle.inArticleTransaction(async (session, transaction) => {
    assert.equal(session.constructor.name, 'ClientSession');
    await News.updateOne({ _id: group.ids[0] }, { $inc: { syncVersion: 1 } }, { session });
    await Article.updateOne({ _id: group.copyIds[0] }, { $inc: { syncVersion: 1 } }, { session });
    transaction.afterCommit.push(() => { effects += 1; });
    return { ok: true };
  });
  assert.equal(result.ok, true);
  assert.equal((await News.findById(group.ids[0]).lean()).syncVersion, 2);
  assert.equal((await Article.findById(group.copyIds[0]).lean()).syncVersion, 2);
  assert.equal(effects, 1);
  const writes = protectedWritesSince(start);
  assert.equal(writes.length, 2);
  assert.ok(writes.every(event => event.transactional && event.succeeded));
  assert.equal(new Set(writes.map(event => `${event.session}:${event.transaction}`)).size, 1);
  assert.ok(commands.slice(start).some(event => event.name === 'commitTransaction' && event.succeeded));
});

test('real rollback restores all EN HI GU records and public copies and discards post-commit work', async () => {
  const group = await seedGroup();
  const before = await snapshot(group);
  const start = commands.length;
  let effects = 0;
  await assert.rejects(lifecycle.inArticleTransaction(async (session, transaction) => {
    await News.updateMany({ _id: { $in: group.ids } }, { $set: { status: 'published' } }, { session });
    await Article.updateMany({ _id: { $in: group.copyIds } }, { $set: { status: 'published' } }, { session });
    assert.deepEqual(await snapshot(group), before, 'Uncommitted changes must not be visible outside the session');
    transaction.afterCommit.push(() => { effects += 1; });
    throw Object.assign(new Error('Requested synthetic rollback'), { code: 'EXPECTED_ROLLBACK' });
  }), { code: 'EXPECTED_ROLLBACK' });
  assert.deepEqual(await snapshot(group), before);
  assert.equal(effects, 0);
  assert.equal(protectedWritesSince(start).filter(event => event.succeeded).length, 2);
  assert.ok(commands.slice(start).some(event => event.name === 'abortTransaction' && event.succeeded));
});

test('overlapping real transactions reject a stale article write with MongoDB WriteConflict', async () => {
  const group = await seedGroup();
  const sessions = [await mongoose.startSession(), await mongoose.startSession()];
  try {
    for (const session of sessions) session.startTransaction({ readConcern: { level: 'snapshot' } });
    for (const session of sessions) {
      assert.equal((await News.findById(group.ids[0], null, { session }).lean()).syncVersion, 1);
    }
    await News.updateOne({ _id: group.ids[0] }, { $inc: { syncVersion: 1 } }, { session: sessions[0] });
    await sessions[0].commitTransaction();
    await assert.rejects(
      News.updateOne({ _id: group.ids[0] }, { $inc: { syncVersion: 1 } }, { session: sessions[1] }).exec(),
      error => error.code === 112 && error.hasErrorLabel('TransientTransactionError'),
    );
    assert.equal((await News.findById(group.ids[0]).lean()).syncVersion, 2);
  } finally {
    for (const session of sessions) {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  }
});

test('Backend transaction wrapper retries a real conflict and runs post-commit work only once', async () => {
  const group = await seedGroup();
  const start = commands.length;
  let attempts = 0;
  let effects = 0;
  await lifecycle.inArticleTransaction(async (session, transaction) => {
    attempts += 1;
    const current = await News.findById(group.ids[0], null, { session }).lean();
    transaction.afterCommit.push(() => { effects += 1; });
    if (attempts === 1) {
      await News.updateOne({ _id: group.ids[0] }, { $inc: { syncVersion: 1 } });
    }
    await News.updateOne({ _id: group.ids[0] }, { $set: { syncVersion: current.syncVersion + 1 } }, { session });
    return { attempts };
  });
  assert.equal(attempts, 2);
  assert.equal(effects, 1);
  assert.equal((await News.findById(group.ids[0]).lean()).syncVersion, 3);
  assert.ok(commands.slice(start).some(event => event.errorCode === 112));
});

test('Founder publication commits all languages while preserving IDs, slugs, media and publication chronology', async () => {
  const group = await seedGroup('draft', true);
  const before = await snapshot(group);
  const result = await publisher.publishCanonicalArticle(group.ids[0], { req: requestFor(founder), logger });
  assert.equal(result.ok, true);
  assert.equal(result.publicSync.ok, true);
  assert.equal(result.revalidation.ok, true);
  assert.equal(result.revalidation.delivered, false);
  assert.deepEqual(result.postCommitWarnings || [], []);
  assert.deepEqual([...result.publishedLanguages].sort(), ['en', 'gu', 'hi']);
  const after = await snapshot(group);
  for (const type of ['news', 'copies']) {
    assert.equal(after[type].length, 3);
    for (const previous of before[type]) {
      const current = after[type].find(doc => doc._id === previous._id);
      assert.equal(current.status, 'published');
      for (const field of ['_id', 'slug', 'language', 'originalLang', 'sourceArticleId',
        'translationGroupId', 'translationKey', 'sourceNewsId', 'publishedAt', 'createdAt', 'coverImage']) {
        assert.deepEqual(current[field], previous[field], `${type}.${field}`);
      }
    }
  }
  const republished = await publisher.publishCanonicalArticle(group.ids[0], { req: requestFor(founder), logger });
  assert.equal(republished.changed, false);
  const second = await snapshot(group);
  for (const type of ['news', 'copies']) {
    for (const previous of after[type]) {
      const current = second[type].find(doc => doc._id === previous._id);
      for (const field of ['_id', 'slug', 'language', 'publishedAt', 'createdAt']) {
        assert.deepEqual(current[field], previous[field], `${type}.${field}`);
      }
    }
  }
});

test('failed canonical publication rolls back real source preparation and partially synchronized public copies', async context => {
  const group = await seedGroup();
  const before = await snapshot(group);
  const previousEffects = await sideEffects();
  const start = commands.length;
  const writes = injectAfterWrite(context, Article, 'findOneAndUpdate', 2);
  await assert.rejects(
    publisher.publishCanonicalArticle(group.ids[0], { req: requestFor(founder), logger }),
    error => error.code === 'PUBLIC_ARTICLE_SYNC_FAILED' && error.cause?.code === 'INJECTED_AFTER_WRITE',
  );
  assert.equal(writes(), 2);
  assert.ok(protectedWritesSince(start).filter(event => event.transactional && event.succeeded).length > 2);
  assert.deepEqual(await snapshot(group), before);
  assert.deepEqual(await sideEffects(), previousEffects);
  assert.ok(commands.slice(start).some(event => event.name === 'abortTransaction' && event.succeeded));
});

test('failed soft deletion rolls back all real language records and public copies', async context => {
  const group = await seedGroup('published');
  const before = await snapshot(group);
  const writes = injectAfterWrite(context, News, 'findOneAndUpdate', 2);
  await assert.rejects(
    lifecycle.changeArticleGroupStatus(group.ids[2], 'deleted', { req: requestFor(founder) }),
    { code: 'INJECTED_AFTER_WRITE' },
  );
  assert.equal(writes(), 2);
  assert.deepEqual(await snapshot(group), before);
});

test('authorized real soft deletion commits the complete group without losing publication dates', async () => {
  const group = await seedGroup('published');
  const before = await snapshot(group);
  const result = await lifecycle.changeArticleGroupStatus(group.ids[2], 'deleted', { req: requestFor(founder) });
  assert.equal(result.changedCount, 3);
  const after = await snapshot(group);
  for (const type of ['news', 'copies']) {
    for (const previous of before[type]) {
      const current = after[type].find(doc => doc._id === previous._id);
      assert.equal(current.status, 'deleted');
      assert.ok(current.deletedAt);
      assert.equal(current.publishedAt, previous.publishedAt);
      assert.equal(current.slug, previous.slug);
    }
  }
});

test('persisted staff without a publishing grant is rejected before every protected database write', async () => {
  const group = await seedGroup();
  const before = await snapshot(group);
  const start = commands.length;
  await assert.rejects(
    publisher.publishCanonicalArticle(group.ids[0], { req: requestFor(staff), logger }),
    error => error.statusCode === 403 && error.code === 'ARTICLE_PUBLISH_FORBIDDEN',
  );
  assert.deepEqual(protectedWritesSince(start), []);
  assert.deepEqual(await snapshot(group), before);
});

test('publication retry rechecks persisted authorization after a real concurrent conflict and session revocation', async context => {
  const group = await seedGroup();
  const before = await snapshot(group);
  const originalSave = News.prototype.save;
  let conflicted = false;
  context.mock.method(News.prototype, 'save', async function (options) {
    if (!conflicted && String(this._id) === String(group.ids[0]) && options?.session) {
      conflicted = true;
      await User.updateOne({ _id: founder._id }, { $inc: { tokenVersion: 1 } });
      await News.updateOne({ _id: group.ids[0] }, { $inc: { syncVersion: 1 } });
    }
    return originalSave.call(this, options);
  });
  const start = commands.length;
  await assert.rejects(
    publisher.publishCanonicalArticle(group.ids[0], { req: requestFor(founder), logger }),
    error => error.statusCode === 403 && error.code === 'ARTICLE_PUBLISH_FORBIDDEN',
  );
  assert.equal(conflicted, true);
  assert.ok(commands.slice(start).some(event => event.errorCode === 112));
  const checks = commands.slice(start).filter(event =>
    event.name === 'find' && event.collection === User.collection.name && event.transactional);
  assert.equal(new Set(checks.map(event => `${event.session}:${event.transaction}`)).size, 2);
  const expected = structuredClone(before);
  const source = expected.news.find(doc => doc._id === String(group.ids[0]));
  source.syncVersion += 1;
  const after = await snapshot(group);
  // The competing update has its own timestamp; only its version change may persist.
  source.updatedAt = after.news.find(doc => doc._id === source._id).updatedAt;
  assert.deepEqual(after, expected);
});
