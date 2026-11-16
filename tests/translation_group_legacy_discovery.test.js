require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const News = require('../models/News');
const PublicArticle = require('../models/Article');
const { runPipeline } = require('./helpers/pulseDialogueAggregate');
const {
  buildSourceReferenceFilter, loadTranslationGroupStatus, assertPublicCopyIdentity, TRANSLATION_SOURCE_IDENTITY_INVALID,
} = require('../services/translationGroupStatus');

const sourceId = '507f1f77bcf86cd79943a001';
const padded = `\ufeff \t${sourceId.toUpperCase()}\n\u2009`;

for (const Model of [News, PublicArticle]) {
  test(`${Model.modelName} reference discovery retains BSON and legacy strings after Mongoose casting`, () => {
    const supported = [new mongoose.Types.ObjectId(sourceId), sourceId, sourceId.toUpperCase(), padded];
    const unsupported = [
      '507f1f77bcf86cd79943a999', `prefix${sourceId}`, `${sourceId}suffix`, `\0${sourceId}\0`,
      'invalid', null, undefined, false, 0, [sourceId], { value: sourceId },
    ];
    for (const field of ['sourceArticleId', 'sourceNewsId', 'translationMeta.sourceArticleId']) {
      const rows = [...supported, ...unsupported].map((reference, index) => ({
        index, ...(field.includes('.') ? { translationMeta: { sourceArticleId: reference } } : { [field]: reference }),
      }));
      const filter = Model.where(buildSourceReferenceFilter([field], [padded, new mongoose.Types.ObjectId(sourceId)])).cast(Model);
      const found = runPipeline(rows, [{ $match: filter }]);
      assert.deepEqual(found.map(row => row.index), [0, 1, 2, 3], field);
    }
  });
}

function groupRows(keyed) {
  return ['en', 'hi', 'gu'].map((language, index) => ({
    _id: new mongoose.Types.ObjectId(`507f1f77bcf86cd79943a00${index + 1}`),
    title: `${language} headline`, slug: `existing-${language}`, language, lang: language, originalLang: language,
    sourceArticleId: index === 1 ? padded : new mongoose.Types.ObjectId(sourceId),
    sourceLanguage: 'en', status: 'published', publishedAt: new Date('2026-09-01T08:00:00.000Z'),
    ...(index === 1 ? { translationMeta: { sourceArticleId: padded, targetLanguage: language, sourceLanguage: 'en', humanEdited: true } } : {}),
    ...(keyed ? { translationGroupId: 'existing-story', translationKey: 'existing-story' } : {}),
  }));
}

function mockReads(context, rows) {
  const result = values => ({ select() { return this; }, lean: async () => values });
  context.mock.method(News, 'find', filter =>
    result(runPipeline(rows, [{ $match: News.where(filter).cast(News) }])));
  context.mock.method(News, 'findById', id => result(rows.find(row => String(row._id) === String(id)) || null));
}

for (const keyed of [true, false]) {
  test(`${keyed ? 'modern' : 'keyless legacy'} status discovery resolves every existing language from source or child`, async context => {
    const rows = groupRows(keyed);
    const before = JSON.stringify(rows);
    mockReads(context, rows);
    for (const requested of rows) {
      const { groupStatus } = await loadTranslationGroupStatus(requested);
      assert.equal(groupStatus.sourceArticleId, sourceId);
      assert.equal(groupStatus.baseLang, 'en');
      assert.deepEqual(groupStatus.presentLanguages, ['en', 'hi', 'gu']);
      assert.deepEqual(groupStatus.missingLanguages, []);
      for (const row of rows) assert.equal(groupStatus.perLang[row.language].articleId, String(row._id));
    }
    assert.equal(JSON.stringify(rows), before, 'Discovery must not rewrite stored legacy links, text, dates or URLs');
  });
}

test('nested legacy references discover conflicting unkeyed CMS records instead of treating them as missing', async context => {
  const rows = groupRows(false);
  rows[1].sourceArticleId = new mongoose.Types.ObjectId('507f1f77bcf86cd79943a999');
  mockReads(context, rows);
  await assert.rejects(loadTranslationGroupStatus(rows[0]), error => error.code === TRANSLATION_SOURCE_IDENTITY_INVALID);
});

test('source-reference discovery rejects invalid requested identities rather than issuing a broad filter', () => {
  for (const ids of [[], [null], [' '], [false], ['not-an-id']]) {
    assert.throws(() => buildSourceReferenceFilter(['sourceArticleId'], ids),
      error => error.code === TRANSLATION_SOURCE_IDENTITY_INVALID);
  }
});

test('canonical-only copy validation is opt-in and requires a persisted canonical owner', () => {
  const copy = { sourceArticleId: padded, language: 'hi', sourceLanguage: 'en' };
  const identity = { sourceId, groupKey: null, baseLang: 'en' };
  const conflict = error => error.code === TRANSLATION_SOURCE_IDENTITY_INVALID;
  assert.throws(() => assertPublicCopyIdentity(copy, identity), conflict);
  assert.doesNotThrow(() => assertPublicCopyIdentity(copy, { ...identity, allowCanonicalOnly: true }));
  assert.doesNotThrow(() => assertPublicCopyIdentity({ sourceArticleId: padded }, { ...identity, allowCanonicalOnly: true }));
  assert.throws(() => assertPublicCopyIdentity({ ...copy, lang: 'gu' }, { ...identity, allowCanonicalOnly: true }), conflict);
  assert.throws(() => assertPublicCopyIdentity({ ...copy, sourceArticleId: null }, {
    ...identity, sourceId: null, allowCanonicalOnly: true,
  }), conflict);
  assert.throws(() => assertPublicCopyIdentity({
    ...copy, sourceArticleId: '507f1f77bcf86cd79943a999',
  }, { ...identity, allowCanonicalOnly: true }), conflict);
});
