require('./helpers/publicNewsIsolation');
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { accountAuthFixture } = require('./helpers/accountAuthFixture');
const { matches } = require('./helpers/pulseDialogueAggregate');

process.env.GOOGLE_TRANSLATE_API_KEY = 'synthetic-translation-key';
process.env.TRANSLATION_ENABLED = 'true';

const app = require('../server');
const News = require('../models/News');
const Article = require('../models/Article');
const Contributor = require('../models/Contributor');
const SponsoredFeature = require('../models/SponsoredFeature');
const SiteSettings = require('../models/SiteSettings');
const User = require('../models/User');
const { serializePublicArticle } = require('../services/publicArticleSerializer.service');
const { buildPubliclyVisibleNewsArticleFilter } = require('../services/publicArticleVisibility.service');
const { listArticles, getArticleBySlug } = require('../controllers/publicArticlesController');

const PRIVATE = 'CONFIDENTIAL-SYNTHETIC-EDITORIAL-METADATA';
const ARTICLE_ID = '507f1f77bcf86cd799439011';
const CHILD_ID = '507f1f77bcf86cd799439012';
const GU_CHILD_ID = '507f1f77bcf86cd799439013';
const PREFIXES = ['', '/api', '/api/admin', '/admin-api', '/admin-api/api', '/admin-api/admin', '/admin-api/api/admin'];
const ADMIN_PREFIXES = ['/api/admin', '/admin-api/admin', '/admin-api/api/admin'];
const TRANSLATE_PREFIXES = ['/api/public/news', '/admin-api/public/news', '/admin-api/api/public/news'];
const LANGUAGES = ['en', 'hi', 'gu'];
const SLUGS = { en: 'public-story', hi: 'public-story-hi', gu: 'public-story-gu' };
const TITLES = { en: 'Public story', hi: '\u0938\u093e\u0930\u094d\u0935\u091c\u0928\u093f\u0915 \u0916\u092c\u0930', gu: '\u0a9c\u0abe\u0ab9\u0ac7\u0ab0 \u0ab8\u0aae\u0abe\u0a9a\u0abe\u0ab0' };
const IMAGE = { url: 'https://example.invalid/cover.jpg', publicId: 'public-cover', alt: 'Public image' };
const BYLINE = { name: 'Fixture Author', publicDesignation: 'Writer', photoUrl: '/uploads/fixture-author.jpg', shortBio: 'Public biography' };

function fixture(overrides = {}) {
  const translations = Object.fromEntries(LANGUAGES.map(lang => [lang, {
    title: TITLES[lang], summary: `Summary ${lang}`, content: `<p>${TITLES[lang]}</p>`,
    provider: 'google', generatedAt: new Date('2026-01-01'),
    review: { notes: PRIVATE },
  }]));
  return {
    _id: ARTICLE_ID, id: ARTICLE_ID, title: TITLES.en, description: 'Summary en', summary: 'Summary en',
    content: translations.en.content, body: translations.en.content, slug: 'public-story',
    slugs: { ...SLUGS, internal: PRIVATE },
    category: 'national', lang: 'en', language: 'en', originalLang: 'en',
    translationKey: 'fixture-group', translationGroupId: 'fixture-group',
    sourceArticleId: ARTICLE_ID, sourceLanguage: 'en',
    translations,
    i18n: Object.fromEntries(['title', 'summary', 'content'].map(field => [
      field, { ...Object.fromEntries(LANGUAGES.map(lang => [lang, translations[lang][field]])), internal: PRIVATE },
    ])),
    translationStatus: { en: 'ready', hi: 'ready', gu: 'ready', internal: PRIVATE },
    status: 'published', publishedAt: new Date('2026-01-01'), createdAt: new Date('2025-12-31'),
    updatedAt: new Date('2026-01-02'), views: 5,
    coverImage: { ...IMAGE, internalNotes: PRIVATE },
    image: { url: IMAGE.url, caption: 'Public caption', internalNotes: PRIVATE },
    images: [{ ...IMAGE, internalNotes: PRIVATE }],
    externalUrls: ['https://example.invalid/original-source'],
    embeds: ['https://example.invalid/public-embed'],
    gallery: ['https://example.invalid/gallery.jpg', { ...IMAGE, internalNotes: PRIVATE }],
    tags: ['national', 'source-link'], stateTags: ['gujarat'], stateNames: ['Gujarat'],
    location: { state: 'Gujarat', stateSlug: 'gujarat', city: 'Ahmedabad', internalNotes: PRIVATE },
    geo: { state: 'gujarat', city: 'ahmedabad', internalNotes: PRIVATE },
    seo: { metaTitle: 'Public SEO title', metaDescription: 'Public SEO description', canonicalUrl: 'https://example.invalid/news/public-story', internalNotes: PRIVATE },
    authorByline: { enabled: true, snapshotCapturedAt: new Date(), snapshot: { ...BYLINE, privateContact: PRIVATE } },
    isSponsored: true, isSponsoredArticle: true, sponsorName: 'Fixture Sponsor',
    sponsorLabel: 'Sponsored', sponsorDisclosure: 'Public sponsorship disclosure',
    sponsorCtaText: 'Learn more', sponsorCtaUrl: 'https://example.invalid/sponsor',
    sponsorFeatureEligible: true,
    source: 'editor', sourceName: 'Public source', sourceUrl: 'https://example.invalid/source',
    sourceType: 'editor_fixture', sourceLabel: PRIVATE, submissionSource: PRIVATE, originType: PRIVATE,
    workflow: { stage: 'PUBLISHED', notes: [{ text: PRIVATE }] },
    workflowHistory: [{ action: 'MOVE_STAGE', note: PRIVATE }],
    internalComments: [{ message: PRIVATE }],
    translationMeta: { sourceFields: { evidence: PRIVATE }, reviewedBy: PRIVATE },
    translationReviewStatus: 'review_required', machineGenerated: true, humanEdited: false,
    translationError: { hi: PRIVATE }, translationNextRetryAt: { hi: new Date() },
    translationJobId: CHILD_ID, reviewedBy: CHILD_ID, reviewedAt: new Date(),
    communityReportId: CHILD_ID, youthPulseSubmissionId: CHILD_ID,
    editorialNotes: PRIVATE, verificationNotes: PRIVATE, aiTitle: PRIVATE, aiBody: PRIVATE,
    ...overrides,
  };
}

// Deliberately overcomplete query results test the response boundary independently of projections.
function query(value) {
  return {
    select() { return this; }, sort() { return this; }, collation() { return this; },
    skip() { return this; }, limit() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function setup(context, { news = fixture(), article = null, siblings } = {}) {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  context.after(() => { mongoose.connection.readyState = previous; });
  context.mock.method(News, 'find', () => query(siblings || (news ? [news] : [])));
  context.mock.method(News, 'findOne', () => query(news));
  context.mock.method(News, 'findById', async () => news);
  context.mock.method(News, 'countDocuments', async () => news ? 1 : 0);
  context.mock.method(Article, 'find', () => query(article ? [article] : []));
  context.mock.method(Article, 'findOne', () => query(article));
  context.mock.method(Article, 'findById', async () => article);
  context.mock.method(Article, 'countDocuments', async () => article ? 1 : 0);
  context.mock.method(Contributor, 'find', () => query([]));
  context.mock.method(Contributor, 'findById', () => query(null));
  context.mock.method(SponsoredFeature, 'findById', () => query(null));
}

async function setupNewsManagementAuth(context) {
  const auth = accountAuthFixture();
  auth.install(context);
  const founderToken = auth.token('founder');
  const adminToken = auth.token('admin');
  const admin = await User.findById(jwt.decode(adminToken).sub).lean();
  admin.moduleAccessStates = { manageNews: 'enabled' };
  const previousDb = mongoose.connection.db;
  mongoose.connection.db = {};
  context.after(() => { mongoose.connection.db = previousDb; });
  const policy = { modulePolicies: { manageNews: 'available' }, version: 1 };
  context.mock.method(SiteSettings, 'findOne', async () => ({ adminModulePolicy: policy }));
  return { auth, founderToken, adminToken, admin, policy };
}

function contentReadCounts() {
  return [
    News.find, News.findOne, News.findById, News.countDocuments,
    Article.find, Article.findOne, Article.findById, Article.countDocuments,
  ].map(method => method.mock.callCount());
}

function assertPrivateExcluded(body) {
  assert.equal(JSON.stringify(body).includes(PRIVATE), false, 'Confidential synthetic metadata must not be public');
  const forbidden = new Set([
    'workflow', 'workflowHistory', 'internalComments', 'editorialNotes', 'verificationNotes',
    'translationMeta', 'translationReviewStatus', 'translationJobId', 'reviewedBy', 'reviewedAt',
    'machineGenerated', 'humanEdited', 'translationError', 'translationNextRetryAt',
    'communityReportId', 'youthPulseSubmissionId', 'snapshotCapturedAt', 'aiTitle', 'aiBody',
    'sourceType', 'sourceLabel', 'submissionSource', 'sourceTrack', 'originType',
  ]);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.has(key), false, `Unexpected public field: ${key}`);
      visit(child);
    }
  };
  visit(body);
}

function articleFrom(body) {
  if (Array.isArray(body)) return body[0];
  return body.article || body.data?.article || body.data?.items?.[0]
    || body.items?.[0] || (Array.isArray(body.data) ? body.data[0] : body.data) || body;
}

function assertRendering(article, slugs = SLUGS) {
  assert.equal(String(article._id), ARTICLE_ID);
  assert.deepEqual(article.authorByline, { enabled: true, snapshot: BYLINE });
  assert.deepEqual(article.externalUrls, ['https://example.invalid/original-source']);
  assert.deepEqual(article.embeds, ['https://example.invalid/public-embed']);
  assert.equal(article.seo.metaTitle, 'Public SEO title');
  assert.equal(article.seo.canonicalUrl, 'https://example.invalid/news/public-story');
  assert.equal(article.coverImage.url, IMAGE.url);
  assert.equal(article.sponsorDisclosure, 'Public sponsorship disclosure');
  assert.equal(article.sponsorCtaUrl, 'https://example.invalid/sponsor');
  assert.equal(article.translationKey, 'fixture-group');
  assert.equal(article.sourceArticleId, ARTICLE_ID);
  assert.equal(article.sourceUrl, 'https://example.invalid/source');
  for (const lang of LANGUAGES) {
    assert.equal(article.slugs[lang], slugs[lang]);
    assert.equal(article.i18n.title[lang], TITLES[lang]);
  }
}

test('public serializer preserves rendering fields and nested language shapes without mutating CMS data', () => {
  const source = fixture();
  const before = structuredClone(source);
  const out = serializePublicArticle(source);
  assertPrivateExcluded(out);
  assertRendering(out);
  assert.deepEqual(source, before);
  for (const lang of LANGUAGES) {
    assert.deepEqual(Object.keys(out.translations[lang]).sort(), ['content', 'generatedAt', 'provider', 'summary', 'title']);
    assert.equal(out.translations[lang].title, TITLES[lang]);
  }
  assert.deepEqual(out.coverImage, IMAGE);
  assert.deepEqual(out.images, [IMAGE]);
  const availability = serializePublicArticle({
    translations: { en: true, hi: false, gu: true, private: { notes: PRIVATE } },
    translationAvailability: { translations: { en: true, hi: false, gu: true }, availableLocales: LANGUAGES, internalNotes: PRIVATE },
  });
  assert.deepEqual(availability.translations, { en: true, hi: false, gu: true });
  assert.deepEqual(availability.translationAvailability.availableLocales, LANGUAGES);
  assertPrivateExcluded(availability);
  assert.equal(serializePublicArticle({ _id: new mongoose.Types.ObjectId(ARTICLE_ID) })._id, ARTICLE_ID);
  assertPrivateExcluded(serializePublicArticle({ title: { internalNotes: PRIVATE }, tags: [{ evidence: PRIVATE }] }));
});

test('public serializer retains intentional Pulse Dialogue editor notes and excludes nested contributor evidence', () => {
  const result = serializePublicArticle(fixture({
    category: 'pulse-dialogue',
    pulseDialogue: {
      contributorId: CHILD_ID, dialogueFormat: 'essay', editorNote: 'Intentional public editor note',
      contributorDisclosure: 'Public disclosure', contributorDisclaimer: 'Public disclaimer',
      internalNotes: PRIVATE, rightsConsent: { notes: PRIVATE },
      bylineSnapshot: { name: 'Fixture Contributor', photo: { ...IMAGE, internalNotes: PRIVATE }, internalNotes: PRIVATE },
      contributor: {
        id: CHILD_ID, name: TITLES.gu, canonicalName: 'Fixture Contributor', publicDesignation: 'Columnist',
        photo: { ...IMAGE, internalNotes: PRIVATE }, internalNotes: PRIVATE,
        internalEmail: PRIVATE, rightsConsent: { notes: PRIVATE },
        socialLinks: { website: 'https://example.invalid/contributor' },
      },
    },
    linkedSponsoredFeature: { id: CHILD_ID, sponsorName: 'Fixture Sponsor', destinationUrl: 'https://example.invalid/sponsor', paymentDetails: { notes: PRIVATE } },
  }));
  assertPrivateExcluded(result);
  assert.equal(result.authorByline, undefined);
  assert.equal(result.pulseDialogue.editorNote, 'Intentional public editor note');
  assert.equal(result.pulseDialogue.contributorDisclosure, 'Public disclosure');
  assert.deepEqual(result.pulseDialogue.bylineSnapshot.photo, IMAGE);
  assert.deepEqual(result.pulseDialogue.contributor.photo, IMAGE);
  assert.equal(result.pulseDialogue.contributor.name, TITLES.gu);
  assert.equal(result.linkedSponsoredFeature.destinationUrl, 'https://example.invalid/sponsor');
});

for (const lang of [null, ...LANGUAGES]) {
  test(`anonymous article aliases exclude CMS metadata and preserve rendering (${lang || 'no locale'})`, async context => {
    setup(context);
    for (const prefix of PREFIXES) {
      const paths = ['/public/articles', '/public/articles?category=national', `/articles/${ARTICLE_ID}`,
        '/articles/slug/public-story', '/articles/by-slug/public-story'];
      for (const path of paths) {
        const url = prefix + path + (lang ? `${path.includes('?') ? '&' : '?'}lang=${lang}` : '');
        const response = await request(app).get(url);
        assert.equal(response.status, 200, url);
        assertPrivateExcluded(response.body);
        assertRendering(articleFrom(response.body));
        assert.equal(articleFrom(response.body).title, TITLES[lang || 'en'], url);
        assert.equal(response.body.translationGroupStatus, undefined, url);
        if (path === `/articles/${ARTICLE_ID}`) {
          assert.deepEqual(response.body.article, response.body.data.article);
          assert.equal(response.body.ok, true);
        } else if (path.startsWith('/public/articles')) {
          assert.equal(response.body.data.total, 1);
          assert.equal(response.body.success, true);
        }
      }
    }
  });
}

test('legacy news, canonical public news, and public stories use response-only filtering', async context => {
  setup(context, { article: fixture() });
  for (const path of [
    '/api/news', '/api/news/news', '/api/news/slug/public-story',
    '/api/public/news?lang=en', '/api/public/news/public-story?lang=en',
    `/api/public/news/${ARTICLE_ID}`, '/api/public/news/slug/public-story?lang=en',
    '/api/public/news/translation?translationKey=fixture-group&lang=en',
    '/api/public/news/translations/fixture-group',
    '/api/public/stories?lang=en', '/api/public/stories/public-story?lang=en',
    '/api/articles/national/state/gujarat?lang=en',
  ]) {
    const response = await request(app).get(path);
    assert.equal(response.status, 200, path);
    assertPrivateExcluded(response.body);
    assertRendering(articleFrom(response.body));
  }
});

test('anonymous public-copy fallbacks also remove historical extra metadata', async context => {
  const article = fixture({ sourceArticleId: null, sourceNewsId: null });
  setup(context, { news: null, article });
  for (const prefix of PREFIXES) {
    for (const suffix of [`/articles/${ARTICLE_ID}`, '/articles/slug/public-story', '/articles/by-slug/public-story']) {
      const response = await request(app).get(prefix + suffix + '?lang=gu');
      assert.equal(response.status, 200);
      assertPrivateExcluded(response.body);
      assert.equal(articleFrom(response.body).title, TITLES.gu);
      assert.deepEqual(articleFrom(response.body).externalUrls, article.externalUrls);
    }
  }
});

test('i18n-only and base-content compatibility branches remain public-safe', async context => {
  const article = fixture({ translations: undefined, sourceArticleId: null, sourceNewsId: null });
  setup(context, { news: null, article });
  for (const lang of ['gu', 'en']) {
    for (const suffix of ['/articles/slug/public-story', '/articles/by-slug/public-story', '/public/stories/public-story']) {
      const response = await request(app).get('/api' + suffix + `?lang=${lang}`);
      if (suffix.startsWith('/public/stories') && lang === 'gu') {
        // Stories require the existing translation-bucket eligibility, not just i18n content.
        assert.equal(response.status, 404);
        assertPrivateExcluded(response.body);
        continue;
      }
      assert.equal(response.status, 200, suffix);
      assertPrivateExcluded(response.body);
      assert.equal(articleFrom(response.body).title, TITLES[lang]);
    }
    article.i18n = undefined;
  }
});

test('regional cards exclude extra nested slug metadata across aliases', async context => {
  setup(context, { article: fixture({ category: 'regional' }) });
  for (const prefix of PREFIXES) {
    const response = await request(app).get(`${prefix}/public/regional?state=gujarat&lang=hi`);
    assert.equal(response.status, 200);
    assertPrivateExcluded(response.body);
    const article = articleFrom(response.body);
    assert.equal(article.title, TITLES.hi);
    assert.deepEqual(article.slugs, SLUGS);
    assert.deepEqual(article.authorByline, { enabled: true, snapshot: BYLINE });
    assert.equal(article.imageUrl, IMAGE.url);
  }
});

test('shared public Article list and slug controllers apply the same response boundary', async context => {
  setup(context, { article: fixture() });
  const publicApp = express();
  publicApp.get('/public-articles', listArticles);
  publicApp.get('/public-articles/:slug', getArticleBySlug);
  for (const lang of [null, ...LANGUAGES]) {
    for (const suffix of ['', '/public-story']) {
      const response = await request(publicApp).get('/public-articles' + suffix + (lang ? `?lang=${lang}` : ''));
      assert.equal(response.status, 200);
      assertPrivateExcluded(response.body);
      assertRendering(articleFrom(response.body));
      assert.equal(articleFrom(response.body).title, TITLES[lang || 'en']);
    }
  }
});

function translationDocument(overrides = {}) {
  return {
    ...fixture(overrides),
    async save() { return this; },
    toObject() {
      const { save, toObject, $where, ...data } = this;
      return data;
    },
  };
}

for (const cached of [true, false]) {
  test(`visible translation POST preserves public fields on every alias (${cached ? 'cached' : 'generated'})`, async context => {
    setup(context);
    context.mock.method(global, 'fetch', async (_url, options) => ({
      ok: true, status: 200,
      json: async () => ({ data: { translations: JSON.parse(options.body).q.map(text => ({ translatedText: `Translated ${text}` })) } }),
    }));
    for (const prefix of TRANSLATE_PREFIXES) {
      for (const lang of LANGUAGES) {
        const doc = translationDocument();
        if (!cached) delete doc.translations[lang];
        let saves = 0;
        doc.save = async () => {
          saves++;
          assert.equal(matches(doc.toObject(), doc.$where), true);
          return doc;
        };
        News.findById = async () => doc;
        const response = await request(app).post(`${prefix}/${ARTICLE_ID}/translate`).send({ lang });
        assert.equal(response.status, 200);
        assert.equal(response.body.success, true);
        assert.equal(response.body.data.activeLang, lang);
        assertPrivateExcluded(response.body);
        assertRendering(response.body.data, doc.slugs);
        assert.ok(response.body.data.translations[lang].content);
        assert.equal(saves, cached ? 0 : 1);
        assert.equal(doc.workflow.notes[0].text, PRIVATE);
        assert.equal(doc.status, 'published');
      }
    }
  });
}

const HIDDEN = [
  { status: 'draft' }, { status: 'scheduled' }, { status: 'archived' }, { status: 'deleted' },
  { deletedAt: new Date() }, { locked: true }, { workflow: { locked: true } },
  { embargoUntil: new Date('2999-01-01') }, { workflow: { embargoUntil: new Date('2999-01-01') } },
  { publishedAt: new Date('2999-01-01') }, { publishAt: new Date('2999-01-01') },
  { scheduledAt: new Date('2999-01-01') }, { visibility: 'private' }, { isPrivate: true },
];

test('every public visibility gate blocks both cached and generated translation paths without writes', async context => {
  setup(context);
  let fetches = 0;
  let saves = 0;
  context.mock.method(global, 'fetch', async () => { fetches++; throw new Error('Unexpected provider call'); });
  for (const prefix of TRANSLATE_PREFIXES) {
    for (const hidden of HIDDEN) {
      for (const cached of [true, false]) {
        const doc = translationDocument(hidden);
        if (!cached) doc.translations = {};
        doc.save = async () => { saves++; return doc; };
        News.findById = async () => doc;
        const response = await request(app).post(`${prefix}/${ARTICLE_ID}/translate`).send({ lang: 'hi' });
        assert.equal(response.status, 404, `${prefix} ${Object.keys(hidden).join()} cached=${cached}`);
        assert.deepEqual(response.body, { success: false });
      }
    }
  }
  assert.equal(fetches, 0);
  assert.equal(saves, 0);
});

test('cached translation remains gated when generation is disabled', async context => {
  setup(context, { news: translationDocument({ locked: true }) });
  const previous = process.env.TRANSLATION_ENABLED;
  process.env.TRANSLATION_ENABLED = 'false';
  context.after(() => { process.env.TRANSLATION_ENABLED = previous; });
  const response = await request(app).post(`/api/public/news/${ARTICLE_ID}/translate`).send({ lang: 'hi' });
  assert.equal(response.status, 404);
});

for (const hideDuringTranslation of [false, true]) {
  test(`Mongoose conditional translation save ${hideDuringTranslation ? 'rejects a concurrent hide' : 'preserves successful writes'}`, async context => {
    const stored = fixture({
      translations: {}, gallery: ['https://example.invalid/gallery.jpg'],
      translationMeta: { reviewedBy: CHILD_ID, sourceFields: { evidence: PRIVATE } },
    });
    const doc = News.hydrate(stored);
    setup(context, { news: doc });
    let writes = 0;
    context.mock.method(global, 'fetch', async (_url, options) => {
      if (hideDuringTranslation) stored.locked = true;
      return { ok: true, status: 200, json: async () => ({
        data: { translations: JSON.parse(options.body).q.map(text => ({ translatedText: `Translated ${text}` })) },
      }) };
    });
    context.mock.method(News.collection, 'updateOne', async (filter, update) => {
      writes++;
      assert.equal(filter.$and.length, buildPubliclyVisibleNewsArticleFilter().$and.length);
      assert.equal(matches(stored, filter), !hideDuringTranslation);
      assert.equal(update.$set?.status, undefined);
      return { acknowledged: true, matchedCount: hideDuringTranslation ? 0 : 1, modifiedCount: hideDuringTranslation ? 0 : 1 };
    });
    const response = await request(app).post(`/api/public/news/${ARTICLE_ID}/translate`).send({ lang: 'hi' });
    assert.equal(response.status, hideDuringTranslation ? 404 : 200);
    if (hideDuringTranslation) {
      assert.deepEqual(response.body, { success: false });
    } else {
      assertPrivateExcluded(response.body);
      assert.ok(response.body.data.translations.hi.content);
      assert.equal(response.body.data.status, 'published');
    }
    assert.equal(writes, 1);
    assert.deepEqual(stored.translations, {});
  });
}

test('anonymous and invalid-token admin aliases never query or expose hidden sibling summaries', async context => {
  const source = fixture();
  setup(context, { news: source });
  const find = context.mock.method(News, 'find', () => { throw new Error('Anonymous sibling lookup is forbidden'); });
  for (const prefix of ADMIN_PREFIXES) {
    for (const invalidToken of [null, 'invalid-synthetic-token']) {
      const req = request(app).get(`${prefix}/articles/${ARTICLE_ID}`);
      if (invalidToken) req.set('Authorization', `Bearer ${invalidToken}`);
      const response = await req;
      assert.equal(response.status, 200);
      assert.equal(response.body.translationGroupStatus, undefined);
      assertPrivateExcluded(response.body);
    }
  }
  assert.equal(find.mock.callCount(), 0);
});

test('disabled accounts and revoked signed tokens cannot obtain administrative extras', async context => {
  setup(context);
  const auth = accountAuthFixture();
  auth.install(context);
  const disabledToken = auth.token('admin');
  const disabled = await User.findById(jwt.decode(disabledToken).sub).lean();
  disabled.accountStatus = 'disabled';
  disabled.status = 'disabled';
  const revokedToken = auth.token('reporter', { tokenVersion: 1 });
  const find = context.mock.method(News, 'find', () => { throw new Error('Unauthenticated sibling lookup is forbidden'); });
  for (const token of [disabledToken, revokedToken]) {
    for (const prefix of ADMIN_PREFIXES) {
      const response = await request(app).get(`${prefix}/articles/${ARTICLE_ID}`).set('Authorization', `Bearer ${token}`);
      assert.equal(response.status, 200);
      assertPrivateExcluded(response.body);
      assert.equal(response.body.translationGroupStatus, undefined);
    }
  }
  assert.equal(find.mock.callCount(), 0);
});

test('all detail aliases enforce module permissions and preserve authorized CMS detail', async context => {
  const source = fixture({ status: 'draft' });
  const child = fixture({ _id: CHILD_ID, title: 'Hidden sibling', status: 'draft', lang: 'hi', slug: 'hidden-sibling' });
  setup(context, { news: source, siblings: [source, child] });
  const { auth, founderToken, adminToken, admin, policy } = await setupNewsManagementAuth(context);
  const detailPaths = [`/articles/${ARTICLE_ID}`, '/articles/slug/public-story', '/articles/by-slug/public-story'];
  for (const token of [founderToken, adminToken]) {
    for (const prefix of PREFIXES) {
      for (const path of detailPaths) {
        for (const lang of [null, ...LANGUAGES]) {
          const url = prefix + path + (lang ? `?lang=${lang}` : '');
          const response = await request(app).get(url).set('Authorization', `Bearer ${token}`);
          assert.equal(response.status, 200, url);
          const article = articleFrom(response.body);
          assert.equal(article.workflow.notes[0].text, PRIVATE);
          assert.equal(article.translationMeta.sourceFields.evidence, PRIVATE);
          assert.equal(article.status, 'draft');
          assert.equal(article.title, TITLES[lang || 'en']);
          if (path === detailPaths[0]) assert.deepEqual(response.body.article, response.body.data.article);
          if (path === detailPaths[0] && ADMIN_PREFIXES.includes(prefix)) {
            assert.equal(response.body.translationGroupStatus.siblingArticles[0].id, CHILD_ID);
            assert.equal(response.body.translationGroupStatus.siblingArticles[0].slug, 'hidden-sibling');
          } else {
            assert.equal(response.body.translationGroupStatus, undefined);
          }
        }
      }
    }
  }
  const beforeDenials = contentReadCounts();
  async function assertDeniedAliases(token) {
    for (const prefix of PREFIXES) {
      for (const path of detailPaths) {
        const response = await request(app).get(prefix + path).set('Authorization', `Bearer ${token}`);
        assert.equal(response.status, 403, prefix + path);
        assertPrivateExcluded(response.body);
        assert.equal(response.body.translationGroupStatus, undefined);
      }
    }
  }
  for (const status of ['draft', 'published']) {
    source.status = status;
    admin.moduleAccessStates.manageNews = 'disabled';
    policy.modulePolicies.manageNews = 'available';
    await assertDeniedAliases(adminToken);
    admin.moduleAccessStates.manageNews = 'enabled';
    policy.modulePolicies.manageNews = 'founder_only';
    await assertDeniedAliases(adminToken);
  }
  const spoofedFounder = auth.token('admin', { role: 'founder', isFounder: true });
  await assertDeniedAliases(spoofedFounder);
  assert.deepEqual(contentReadCounts(), beforeDenials, 'Denied requests must not read CMS or public-copy records');
});

for (const endpoint of [
  {
    name: 'article list',
    path: '/articles?page=0&limit=10&sort=-updatedAt',
    assertResponse(body, source, siblings) {
      assert.deepEqual(Object.keys(body).sort(), ['ok', 'success', 'status', 'data', 'items', 'articles', 'total', 'page', 'limit', 'sort'].sort());
      assert.equal(body.ok, true);
      assert.equal(body.success, true);
      assert.equal(body.status, 200);
      assert.equal(body.page, 1);
      assert.equal(body.limit, 10);
      assert.equal(body.total, siblings.length);
      assert.deepEqual(body.sort, { updatedAt: -1 });
      assert.deepEqual(body.data, { items: body.items, page: 1, limit: 10, total: siblings.length });
      assert.deepEqual(body.articles, body.items);
      assert.deepEqual(body.items.map(item => item._id), siblings.map(item => item._id));
      const article = body.items[0];
      assert.equal(article.status, 'draft');
      assert.equal(article.workflow.notes[0].text, PRIVATE);
      assert.equal(article.workflowHistory[0].note, PRIVATE);
      assert.equal(article.internalComments[0].message, PRIVATE);
      assert.equal(article.translationMeta.sourceFields.evidence, PRIVATE);
      assert.equal(article.authorByline.snapshot.name, BYLINE.name);
      assert.equal(article.sourceUrl, source.sourceUrl);
      assert.equal(article.seo.canonicalUrl, source.seo.canonicalUrl);
      assert.equal(article.sponsorDisclosure, source.sponsorDisclosure);
      for (const lang of LANGUAGES) {
        assert.equal(article.slugs[lang], SLUGS[lang]);
        assert.equal(article.translations[lang].title, TITLES[lang]);
      }
    },
  },
  {
    name: 'translation status',
    path: `/articles/${ARTICLE_ID}/translation-status`,
    assertResponse(body, source, siblings) {
      assert.deepEqual(Object.keys(body).sort(), ['ok', 'success', 'data'].sort());
      assert.equal(body.ok, true);
      assert.equal(body.success, true);
      assert.deepEqual(Object.keys(body.data).sort(), ['id', 'slug', 'title', 'baseLang', 'translationGroupKey', 'languageStates', 'perLang'].sort());
      assert.equal(body.data.id, ARTICLE_ID);
      assert.equal(body.data.slug, source.slug);
      assert.equal(body.data.title, source.title);
      assert.equal(body.data.baseLang, 'en');
      assert.equal(body.data.translationGroupKey, source.translationKey);
      const states = body.data.languageStates;
      assert.deepEqual(states.presentLanguages, LANGUAGES);
      assert.deepEqual(states.missingLanguages, []);
      assert.equal(states.sourceArticle.id, ARTICLE_ID);
      assert.deepEqual(states.siblingArticles.map(item => item.id), [CHILD_ID, GU_CHILD_ID]);
      assert.deepEqual(states.siblingArticles.map(item => item.slug), siblings.slice(1).map(item => item.slug));
      assert.deepEqual(states.siblingArticles.map(item => item.status), ['draft', 'draft']);
      assert.deepEqual(Object.keys(body.data.perLang), LANGUAGES);
      for (const lang of LANGUAGES) {
        const isSource = lang === 'en';
        const article = siblings.find(item => item.lang === lang);
        assert.deepEqual(body.data.perLang[lang], {
          status: source.translationStatus[lang],
          error: source.translationError[lang] || null,
          updatedAt: source.translationUpdatedAt[lang].toISOString(),
          nextRetryAt: source.translationNextRetryAt[lang]?.toISOString() || null,
          present: true,
          presence: isSource ? 'source' : 'translated',
          isSource,
          isTranslatedChild: !isSource,
          sourceArticleId: isSource ? ARTICLE_ID : null,
          childArticleId: isSource ? null : article._id,
          articleId: article._id,
        });
      }
    },
  },
]) {
  test(`private CMS ${endpoint.name} aliases enforce authentication and manageNews permissions`, async context => {
    const source = fixture({
      status: 'draft',
      translationUpdatedAt: Object.fromEntries(LANGUAGES.map(lang => [lang, new Date('2026-01-02')])),
    });
    const siblings = [source, ...[['hi', CHILD_ID], ['gu', GU_CHILD_ID]].map(([lang, id]) => fixture({
      _id: id, id, lang, language: lang, status: 'draft',
      title: `Hidden ${lang} sibling`, slug: `hidden-${lang}-sibling`,
    }))];
    setup(context, { news: source, siblings });
    context.mock.method(News, 'findById', () => query(source));
    context.mock.method(News, 'countDocuments', async () => siblings.length);
    const { auth, founderToken, adminToken, admin, policy } = await setupNewsManagementAuth(context);

    for (const token of [adminToken, founderToken]) {
      policy.modulePolicies.manageNews = token === founderToken ? 'founder_only' : 'available';
      for (const prefix of PREFIXES) {
        const url = prefix + endpoint.path;
        const response = await request(app).get(url).set('Authorization', `Bearer ${token}`);
        assert.equal(response.status, 200, url);
        endpoint.assertResponse(response.body, source, siblings);
      }
    }

    const beforeDenials = contentReadCounts();
    async function assertDeniedAliases(token, expectedStatus) {
      for (const prefix of PREFIXES) {
        const url = prefix + endpoint.path;
        const req = request(app).get(url);
        if (token) req.set('Authorization', `Bearer ${token}`);
        const response = await req;
        assert.equal(response.status, expectedStatus, url);
        assertPrivateExcluded(response.body);
        assert.equal(response.body.data?.items, undefined);
        assert.equal(response.body.data?.languageStates, undefined);
        for (const id of [ARTICLE_ID, CHILD_ID, GU_CHILD_ID]) {
          assert.equal(JSON.stringify(response.body).includes(id), false, 'Denied responses must not expose article identities');
        }
        assert.deepEqual(contentReadCounts(), beforeDenials, 'Denied requests must not read or count article records');
      }
    }

    const revokedToken = auth.token('reporter', { tokenVersion: 1 });
    for (const token of [null, 'invalid-synthetic-token', revokedToken]) {
      await assertDeniedAliases(token, 401);
    }
    for (const status of ['draft', 'published']) {
      source.status = status;
      admin.moduleAccessStates.manageNews = 'disabled';
      policy.modulePolicies.manageNews = 'available';
      await assertDeniedAliases(adminToken, 403);
      admin.moduleAccessStates.manageNews = 'enabled';
      policy.modulePolicies.manageNews = 'founder_only';
      await assertDeniedAliases(adminToken, 403);
    }
    const spoofedFounder = auth.token('editor', { role: 'founder', isFounder: true });
    await assertDeniedAliases(spoofedFounder, 403);
  });
}
