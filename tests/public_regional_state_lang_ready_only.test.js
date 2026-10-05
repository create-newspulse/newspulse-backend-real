const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
process.env.NODE_ENV = 'test';
const app = require('../server');
const Article = require('../models/Article');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');
const { installFeedModels, publishedNews, bucket, makeQuery } = require('./helpers/publicFeedModels');

test('GET /api/public/regional maps ready translations and preserves public IDs, stored slug and media', async (t) => {
  const source = publishedNews(1, {
    slugs: { gu: 'gu-1', en: 'en-1' },
    translations: { en: bucket('en', { provider: 'google', generatedAt: new Date('2026-03-06') }) },
    translationStatus: { en: 'ready' },
  });
  const copy = {
    _id: '507f1f77bcf86cd799439011', sourceNewsId: source._id, slug: 'gu-1',
    slugs: source.slugs, coverImage: { url: 'https://img.example/1.jpg' },
  };
  const captured = installFeedModels(t, { news: [source], copies: [copy] });
  const res = await request(app).get('/api/public/regional?state=gujarat&lang=en&page=1&limit=20');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.data.stateSlug, 'gujarat');
  assert.equal(res.body.data.lang, 'en');
  assert.equal(res.body.data.total, 1);
  assert.equal(res.body.data.totalPages, 1);
  assert.equal(res.body.data.hasMore, false);
  const [item] = res.body.data.items;
  assert.equal(item._id, copy._id);
  assert.equal(item.slug, 'gu-1');
  assert.equal(item.canonicalSlug, 'en-1');
  assert.equal(item.imageUrl, copy.coverImage.url);
  assert.equal(item.title, 'en title');
  assert.equal(item.summary, 'en summary');
  assert.equal(item.content, 'en body');
  assert.equal(item.provider, 'google');
  assert.equal(item.generatedAt, '2026-03-06T00:00:00.000Z');
  assert.ok(captured.news.every((query) => query.skip === undefined && query.limit === undefined));
});

test('GET /api/public/regional supports independent district/city filters from geo and tags', async (t) => {
  installFeedModels(t, { news: [
    publishedNews(1, { geo: { state: 'gujarat', district: 'ahmedabad', city: 'gandhinagar' } }),
    publishedNews(2, { tags: ['district:ahmedabad', 'city:gandhinagar'] }),
    publishedNews(3, { geo: { state: 'gujarat', district: 'surat', city: 'gandhinagar' } }),
    publishedNews(4, { tags: ['district:ahmedabad', 'city:surat'] }),
  ] });
  const res = await request(app).get('/api/public/regional?state=Gujarat%20&district=Ahmedabad%20&city=Gandhinagar&lang=gu');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 2);
  assert.ok(res.body.data.items.every((item) => item.geo.district === 'ahmedabad' && item.geo.city === 'gandhinagar'));
});

for (const sentinel of ['undefined', 'null', 'all', 'all-districts']) {
  test(`GET /api/public/regional treats ${sentinel} geography as a state-only request`, async (t) => {
    installFeedModels(t, { news: [publishedNews(1)] });
    const city = sentinel === 'all-districts' ? 'all-cities' : sentinel;
    const res = await request(app).get(`/api/public/regional?state=gujarat&district=${sentinel}&city=${city}&lang=gu`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 1);
  });
}

test('GET /api/public/regional accepts state:/district:/city: prefixes and the legacy state path', async (t) => {
  installFeedModels(t, { news: [publishedNews(1, { tags: ['district:ahmedabad', 'city:gandhinagar'] })] });
  for (const url of [
    '/api/public/regional?state=state:gujarat&district=district:ahmedabad&city=city:gandhinagar&lang=gu',
    '/api/public/regional/gujarat?district=ahmedabad&city=gandhinagar&lang=gu',
  ]) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 1);
  }
});

test('Regional selects the complete published language sibling once instead of its cached duplicate', async (t) => {
  const source = publishedNews(1, {
    translationGroupId: 'grp-1', sourceLanguage: 'gu',
    translations: { en: bucket('en') }, translationStatus: { en: 'ready' },
  });
  const english = publishedNews(2, {
    translationGroupId: 'grp-1', sourceArticleId: source._id,
    lang: 'en', language: 'en', originalLang: 'en', title: 'Original English title',
  });
  installFeedModels(t, { news: [source, english] });
  const res = await request(app).get('/api/public/regional?state=gujarat&lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 1);
  assert.equal(res.body.data.items[0]._id, english._id);
  assert.equal(res.body.data.items[0].title, english.title);
});

test('Regional does not merge unlinked News stories merely because slugs.en matches', async (t) => {
  installFeedModels(t, { news: [1, 2].map((number) => publishedNews(number, {
    slugs: { en: 'coincident-slug' }, lang: 'en', language: 'en', originalLang: 'en',
  })) });
  const res = await request(app).get('/api/public/regional?state=gujarat&lang=en');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 2);
});

test('Regional requires complete ready translations equally for GU, HI and EN', async (t) => {
  installFeedModels(t, { news: [
    publishedNews(1, {
      translations: { en: bucket('en'), hi: bucket('hi') }, translationStatus: { en: 'pending', hi: 'ready' },
    }),
    publishedNews(2, { lang: 'en', language: 'en', originalLang: 'en' }),
  ] });
  for (const lang of ['en', 'hi', 'gu']) {
    const res = await request(app).get(`/api/public/regional?state=gujarat&lang=${lang}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 1);
    assert.equal(res.body.data.items[0].resolvedLang, lang);
  }
});

test('GET /api/public/regional/:state rejects invalid state (400)', async () => {
  const res = await request(app).get('/api/public/regional/not-a-real-state?lang=gu');
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('canonical Regional sync still adds Gujarat metadata without losing district/city', async (t) => {
  const sources = [[], ['district:ahmedabad'], ['city:vadodara']].map((tags, index) => publishedNews(index + 1, {
    geo: { state: null, district: null, city: null }, tags,
  }));
  const copies = [];
  t.mock.method(Article, 'findOneAndUpdate', (_filter, update) => {
    const copy = { _id: update.$set.sourceNewsId, ...update.$set };
    copies.push(copy);
    return makeQuery([copy], {}, true);
  });
  for (const source of sources) await syncPublicArticleFromNews(source);
  assert.equal(copies.length, 3);
  assert.ok(copies.every((copy) => copy.geo.state === 'gujarat' && copy.tags.includes('state:gujarat')));
  assert.equal(copies[1].geo.district, 'ahmedabad');
  assert.equal(copies[2].geo.city, 'vadodara');
  installFeedModels(t, { news: sources, copies });
  const res = await request(app).get('/api/public/regional?state=gujarat&lang=gu');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.total, 3);
});
