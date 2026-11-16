require('./helpers/publicNewsIsolation');

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const PublicSiteSettings = require('../models/PublicSiteSettings');
const { installEditorialFixture, seedGroup } = require('./helpers/editorialLifecycleFixture');

const LANGUAGES = ['gu', 'hi', 'en'];
const TEXT = {
  gu: '\u0a95\u0ab2\u0acd\u0aaa\u0abf\u0aa4 \u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0',
  hi: '\u0915\u093e\u0932\u094d\u092a\u0928\u093f\u0915 \u0938\u092e\u093e\u091a\u093e\u0930',
  en: 'Fictional local news',
};
const EDITOR = {
  specialRightsConfigured: true, specialRightsOverride: ['news_edit'],
  moduleAccessStates: { manageNews: 'enabled' },
};
const HISTORY_ID = '507f1f77bcf86cd79943a099';
const HISTORY_COPY_ID = '607f1f77bcf86cd79943a099';
const CONTENT_MODELS = ['News', 'Article', 'TranslationJob', 'PublicConfigVersion', 'YouthPulseSubmission', 'YouthPulseContributor'];
const snapshot = state => Object.fromEntries(CONTENT_MODELS.map(name => [name, structuredClone(state.rows[name])]));
const body = (language, edit) => `<p>${TEXT[language]} content edit ${edit}</p>`;

function install(context, { sourceLanguage = 'en', editionLanguage = sourceLanguage, status = 'published', shared = false, staff = EDITOR } = {}) {
  const state = installEditorialFixture(context, {
    staff, modulePolicies: { manageNews: 'available', addNews: 'available', draftDesk: 'available' },
  });
  seedGroup(state, { status, copies: status === 'published', sharedSlug: shared });
  const source = state.rows.News.find(doc => doc.language === sourceLanguage);
  for (const doc of state.rows.News) {
    const mediaLanguage = shared ? 'shared' : doc.language;
    Object.assign(doc, {
      title: TEXT[doc.language], description: `${TEXT[doc.language]} summary`, content: body(doc.language, 0),
      category: 'business', sourceArticleId: source._id, sourceLanguage,
      coverImage: { url: `/uploads/${mediaLanguage}.jpg`, publicId: `media-${mediaLanguage}`, alt: `Cover ${mediaLanguage}` },
      coverImageUrl: `/uploads/${mediaLanguage}.jpg`,
      gallery: [`/uploads/gallery-${mediaLanguage}.jpg`],
      seo: { metaTitle: `Title ${mediaLanguage}`, metaDescription: `Summary ${mediaLanguage}`, canonicalUrl: `https://example.invalid/news/${doc.slug}` },
    });
    if (doc !== source) {
      doc.machineGenerated = true;
      doc.humanEdited = true;
      doc.translationMeta = { sourceArticleId: source._id, sourceLanguage, targetLanguage: doc.language, humanEdited: true };
    }
  }
  for (const copy of state.rows.Article) {
    const doc = shared ? source : state.rows.News.find(member => member._id === copy.sourceNewsId);
    Object.assign(copy, structuredClone(doc), { _id: copy._id, sourceNewsId: doc._id, summary: doc.description });
  }
  const edition = state.rows.News.find(doc => doc.language === editionLanguage);
  const history = {
    ...structuredClone(edition), _id: HISTORY_ID, slug: `historical-${editionLanguage}`,
    slugs: { [editionLanguage]: `historical-${editionLanguage}` },
    title: 'Deleted historical headline', content: '<p>Deleted historical content</p>',
    status: 'deleted', deletedAt: new Date('2026-10-01T00:00:00.000Z'), deletedFromStatus: status,
    workflowStage: 'REJECTED', machineGenerated: true, humanEdited: false,
    translationMeta: { sourceArticleId: source._id, sourceLanguage, targetLanguage: editionLanguage, humanEdited: false },
  };
  state.rows.News.push(history);
  if (status === 'published') state.rows.Article.push({
    ...structuredClone(history), _id: HISTORY_COPY_ID, sourceNewsId: history._id, summary: history.description,
  });
  const database = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = database; });
  context.mock.method(PublicSiteSettings, 'getOrCreate', async () => ({
    published: { languageTheme: { languages: LANGUAGES } },
  }));
  return { state, source, edition, history };
}

function assertPreserved(state, before, editedId) {
  for (const name of ['News', 'Article']) {
    assert.equal(state.rows[name].length, before[name].length, name);
    for (const doc of state.rows[name]) {
      const previous = before[name].find(row => row._id === doc._id);
      assert.ok(previous);
      if (previous.status === 'deleted') {
        assert.deepEqual(doc, previous, `${name} historical record`);
        continue;
      }
      for (const field of [
        '_id', 'sourceArticleId', 'sourceNewsId', 'sourceLanguage', 'language', 'lang', 'originalLang',
        'translationGroupId', 'translationKey', 'status', 'deletedAt', 'deletedFromStatus',
        'slug', 'slugs', 'publishedAt', 'createdAt', 'coverImage', 'coverImageUrl', 'gallery', 'seo',
      ]) assert.deepEqual(doc[field], previous[field], `${name}.${field}`);
      if (name === 'News' && doc._id !== editedId) {
        for (const field of ['title', 'description', 'content', 'humanEdited', 'translationMeta']) {
          assert.deepEqual(doc[field], previous[field], `untouched sibling ${field}`);
        }
      }
    }
  }
}

for (const method of ['put', 'patch']) for (const role of ['founder', 'editor']) {
  test(`${role} ${method.toUpperCase()} Faith topic synchronization leaves deleted metadata untouched`, async context => {
    const { state, source } = install(context);
    for (const doc of [...state.rows.News, ...state.rows.Article]) {
      doc.category = 'faith-culture';
    }
    for (const doc of state.rows.News) doc.topic = 'living-heritage';
    for (const [index, copy] of state.rows.Article.filter(doc => doc.status !== 'deleted').entries()) {
      copy.slug = `historical-faith-public-${copy.language}`;
      copy.slugs = Object.fromEntries(LANGUAGES.map(lang => [lang, `historical-faith-public-${copy.language}-${lang}`]));
      copy.publishedAt = new Date(`2019-0${index + 1}-01T08:00:00.000Z`);
    }
    const before = snapshot(state);
    const response = await state.request(method, `/api/articles/${source._id}`, { topic: 'faith-spiritual-life' }, role);
    assert.equal(response.status, 200, response.text);
    for (const doc of state.rows.News.filter(doc => doc.status !== 'deleted')) {
      assert.equal(doc.topic, 'faith-spiritual-life');
    }
    assertPreserved(state, before, source._id);
    assert.equal(state.invalidations.length, 1);
    for (const copy of before.Article.filter(doc => doc.status !== 'deleted')) {
      for (const publicPath of [
        `/news/${copy.slug}`, `/news/${copy.slugs.en}`, `/hi/news/${copy.slugs.hi}`, `/gu/news/${copy.slugs.gu}`,
      ]) assert.ok(state.invalidations[0].paths.includes(publicPath), publicPath);
      assert.ok(state.invalidations[0].tags.includes(`article:${copy._id}`));
    }
  });
}
