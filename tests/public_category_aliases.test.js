const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');
process.env.NODE_ENV = 'test';

const app = require('../server');
const { PUBLIC_CATEGORY_DEFINITIONS } = require('../lib/categories');
const { installFeedModels, publishedNews, publishedArticleForNews, bucket } = require('./helpers/publicFeedModels');

function ready(t) {
  const previous = mongoose.connection.readyState;
  mongoose.connection.readyState = 1;
  t.after(() => { mongoose.connection.readyState = previous; });
}

const endpoints = [
  { path: '/api/public/news', items: (body) => body.items, meta: (body) => body, publicIds: false },
  { path: '/api/public/articles', items: (body) => body.data.items, meta: (body) => body.data, publicIds: false },
  { path: '/api/public/stories', items: (body) => body.data, meta: (body) => body, publicIds: true },
];

test('Science & Technology canonical mapping stays tech with public slug science-technology', () => {
  assert.deepEqual(PUBLIC_CATEGORY_DEFINITIONS.tech, {
    key: 'tech', label: 'Science & Technology', publicSlug: 'science-technology',
    matchValues: ['tech', 'science-technology', 'science-and-technology', 'sci-tech', 'science_and_technology'],
  });
});

for (const endpoint of endpoints) {
  test(`${endpoint.path} includes Science & Technology aliases, excludes other categories and preserves its envelope`, async (t) => {
    ready(t);
    const docs = ['tech', 'science-technology', 'sci-tech', 'science_and_technology', 'tech-gadgets', 'sports']
      .map((category, index) => publishedNews(index + 1, { category, lang: 'en', language: 'en', originalLang: 'en' }));
    installFeedModels(t, { news: docs, copies: docs.map((doc) => publishedArticleForNews(doc)) });
    const res = await request(app).get(`${endpoint.path}?category=science-technology&lang=en&limit=10`);
    assert.equal(res.status, 200);
    const items = endpoint.items(res.body);
    assert.deepEqual(items.map((item) => item.category).sort(), ['sci-tech', 'science-technology', 'science_and_technology', 'tech']);
    assert.equal(endpoint.meta(res.body).total, 4);
    assert.equal(endpoint.meta(res.body).hasMore, false);
    assert.match(res.headers['cache-control'], /no-store/);
  });

  test(`${endpoint.path} resolves verified HI siblings and ready GU caches without changing public IDs or URLs`, async (t) => {
    ready(t);
    const english = publishedNews(1, {
      category: 'tech', lang: 'en', language: 'en', originalLang: 'en', sourceLanguage: 'en',
      slug: 'tech-en', slugs: { en: 'tech-en', hi: 'tech-hi', gu: 'tech-gu' },
      translationKey: 'tech-group', translationGroupId: 'tech-group',
      translations: { gu: bucket('gu') }, translationStatus: { gu: 'ready' },
    });
    const hindi = publishedNews(2, {
      category: '', lang: 'hi', language: 'hi', originalLang: 'hi', sourceLanguage: 'en',
      sourceArticleId: english._id, title: 'Published Hindi title', slug: 'tech-hi', slugs: english.slugs,
      translationKey: 'tech-group', translationGroupId: 'tech-group',
    });
    const copies = [english, hindi].map((doc, index) => publishedArticleForNews(doc, {
      _id: `public-${index}`, sourceNewsId: doc._id, slug: doc.slug, slugs: doc.slugs,
      coverImage: { url: `https://example.test/${index}.jpg` },
    }));
    installFeedModels(t, { news: [english, hindi], copies });
    for (const lang of ['hi', 'gu']) {
      const res = await request(app).get(`${endpoint.path}?category=science-technology&lang=${lang}&limit=10&page=1`);
      assert.equal(res.status, 200);
      const items = endpoint.items(res.body);
      assert.equal(items.length, 1);
      assert.equal(items[0].title, lang === 'hi' ? hindi.title : 'gu title');
      assert.equal(items[0].language, lang);
      const expectedSlug = endpoint.path === '/api/public/news' && lang === 'gu' ? english.slug : `tech-${lang}`;
      assert.equal(items[0].slug, expectedSlug);
      assert.equal(items[0].canonicalSlug, `tech-${lang}`);
      assert.equal(items[0]._id, endpoint.publicIds ? copies[lang === 'hi' ? 1 : 0]._id : (lang === 'hi' ? hindi._id : english._id));
      assert.deepEqual(items[0].availableLocales, ['en', 'hi', 'gu']);
    }
  });

  test(`${endpoint.path} paginates final ordinary groups without accepting explicit cross-language fallback`, async (t) => {
    ready(t);
    const docs = [];
    for (let index = 1; index <= 31; index += 1) {
      docs.push(publishedNews(index, {
        category: 'business', translations: { hi: bucket('hi') }, translationStatus: { hi: 'ready' },
      }));
    }
    docs.push(publishedNews(99, { category: 'business' }));
    installFeedModels(t, { news: docs, copies: docs.map((doc) => publishedArticleForNews(doc)) });
    const first = await request(app).get(`${endpoint.path}?category=business&lang=hi&fallback=true&limit=30`);
    assert.equal(first.status, 200);
    assert.equal(endpoint.items(first.body).length, 30);
    assert.equal(endpoint.meta(first.body).total, 31);
    assert.equal(endpoint.meta(first.body).hasMore, true);
    const second = await request(app).get(`${endpoint.path}?category=business&lang=hi&limit=30&page=2`);
    assert.equal(endpoint.items(second.body).length, 1);
    assert.equal(endpoint.meta(second.body).hasMore, false);
  });
}

test('ordinary category cache keys bypass legacy cached results; Home and protected category keying remains', async (t) => {
  ready(t);
  const cache = require('../lib/cache');
  const routerPath = require.resolve('../routes/publicNews.routes');
  const previous = require.cache[routerPath];
  let configuration;
  t.mock.method(cache, 'createJsonCacheMiddleware', (options) => {
    configuration = options;
    return (_req, _res, next) => next();
  });

  delete require.cache[routerPath];
  try {
    require('../routes/publicNews.routes');
    assert.equal(configuration.buildKey({ query: { category: 'regional', state: 'gujarat', lang: 'hi' } }), null);
    assert.equal(configuration.buildKey({ query: { category: 'science-technology', lang: 'en' } }), null);
    assert.match(configuration.buildKey({ query: { lang: 'gu' } }), /^np:v1:latest:/);
    assert.match(configuration.buildKey({ query: { category: 'pulse-dialogue', lang: 'en' } }), /^np:v1:category:/);
  } finally {
    require.cache[routerPath] = previous;
  }
});

test('National/state retains stateTags, strict localization and final pagination', async (t) => {
  installFeedModels(t, { news: [
    publishedNews(1, {
      category: 'national', stateTags: ['gujarat'],
      translations: { en: bucket('en') }, translationStatus: { en: 'ready' },
    }),
    publishedNews(2, { category: 'national', stateTags: ['maharashtra'] }),
    publishedNews(3, { stateTags: ['gujarat'] }),
  ] });
  const res = await request(app).get('/api/articles/national/state/gujarat?lang=en&limit=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.items.length, 1);
  assert.equal(res.body.data.items[0].category, 'national');
  assert.equal(res.body.data.items[0].title, 'en title');
  assert.equal(res.body.data.total, 1);
  assert.equal(res.body.data.totalPages, 1);
  assert.equal(res.body.data.hasMore, false);
  assert.equal(res.body.data.stateSlug, 'gujarat');
  assert.equal((await request(app).get('/api/articles/national/state/invalid?lang=en')).status, 400);
});
