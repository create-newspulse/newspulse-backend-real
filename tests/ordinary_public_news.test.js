const test = require('node:test');
const assert = require('node:assert/strict');
process.env.NODE_ENV = 'test';

const { ORDINARY_CATEGORIES, isOrdinaryNewsCategory, listPublicStories } = require('../services/ordinaryPublicNews.service');
const { installFeedModels, publishedNews: news, bucket } = require('./helpers/publicFeedModels');

const now = new Date('2026-10-06T00:00:00.000Z');
const list = (options = {}) => listPublicStories({ category: 'regional', lang: 'gu', now, ...options });

test('ordinary scope is explicit; Science & Technology aliases do not include protected categories', () => {
  assert.deepEqual(ORDINARY_CATEGORIES, [
    'regional', 'national', 'international', 'business', 'sports',
    'tech', 'tech-gadgets', 'faith-culture', 'glamour', 'lifestyle',
  ]);
  assert.equal(isOrdinaryNewsCategory('science-technology'), true);
  for (const category of ['pulse-dialogue', 'youth-pulse', 'inspiration-hub', 'editorial', 'breaking', 'web-stories', '']) {
    assert.equal(isOrdinaryNewsCategory(category), false, category);
  }
});

test('Regional 11 PM is first, 10:30 PM second; editing March does not promote it', async (t) => {
  const older = news(1, { publishedAt: new Date('2026-03-06'), updatedAt: now, spotlightPinned: true });
  const earlier = news(2, { publishedAt: new Date('2026-10-04T22:30:00+05:30') });
  const latest = news(3, { publishedAt: new Date('2026-10-04T23:00:00+05:30') });
  installFeedModels(t, { news: [older, earlier, latest] });
  const result = await list();
  assert.deepEqual(result.items.map((item) => item._id), [latest._id, earlier._id, older._id]);
  assert.equal(result.items[0].publishedAt.getTime(), latest.publishedAt.getTime());
});

test('category membership precedes chronology for every ordinary category', async (t) => {
  const docs = ORDINARY_CATEGORIES.flatMap((category, index) => [
    news(index * 2 + 1, { category }),
    news(index * 2 + 2, { category, publishedAt: new Date('2026-10-04') }),
  ]);
  docs.push(news(100, { category: 'breaking', publishedAt: now, tags: ['state:gujarat'] }));
  installFeedModels(t, { news: docs });
  for (const category of ORDINARY_CATEGORIES) {
    const result = await list({ category });
    assert.equal(result.total, 2, category);
    assert.ok(result.items.every((item) => item.category === category));
    assert.equal(result.items[0].publishedAt.getTime(), new Date('2026-10-04').getTime());
  }
});

test('Science & Technology includes its aliases but never Tech & Gadgets', async (t) => {
  installFeedModels(t, { news: [
    news(1, { category: 'tech' }), news(2, { category: 'sci-tech' }),
    news(3, { category: 'tech-gadgets', publishedAt: now }),
  ] });
  const result = await list({ category: 'science-technology' });
  assert.deepEqual(result.items.map((item) => item.category).sort(), ['sci-tech', 'tech']);
  assert.equal((await list({ category: 'tech-gadgets' })).total, 1);
});

for (const lang of ['en', 'hi', 'gu']) {
  test(`${lang}: complete ready cache is eligible; pending/failed/rejected/missing status is not`, async (t) => {
    const source = lang === 'gu' ? 'en' : 'gu';
    const statuses = ['ready', ' READY ', 'pending', 'failed', 'rejected', undefined, null, ' '];
    installFeedModels(t, { news: statuses.map((status, index) => news(index + 1, {
      lang: source, language: source, originalLang: source,
      translations: { [lang]: bucket(lang) }, translationStatus: { [lang]: status },
    })) });
    const result = await list({ lang });
    assert.equal(result.total, 2);
    assert.ok(result.items.every((item) => item.title === `${lang} title` && !item.isFallback));
  });

  test(`${lang}: null, whitespace and incomplete translation fields are excluded`, async (t) => {
    const source = lang === 'gu' ? 'en' : 'gu';
    const buckets = [null, {}, ...['title', 'summary', 'content'].flatMap((field) =>
      [null, '', ' \t\n '].map((value) => bucket(lang, { [field]: value })))];
    installFeedModels(t, { news: buckets.map((value, index) => news(index + 1, {
      lang: source, language: source, originalLang: source,
      translations: { [lang]: value }, translationStatus: { [lang]: 'ready' },
    })) });
    assert.equal((await list({ lang })).total, 0);
  });
}

test('native content is independent of its embedded translation-cache status', async (t) => {
  const original = news(1, { translationStatus: { gu: 'pending' } });
  installFeedModels(t, { news: [original] });
  const result = await list();
  assert.equal(result.total, 1);
  assert.equal(result.items[0].title, original.title);
  assert.equal((await list({ lang: 'en' })).total, 0);
});

test('verified independently published variants use stored language and master chronology', async (t) => {
  const master = news(1, { sourceLanguage: 'gu', publishedAt: new Date('2026-03-06') });
  const english = news(2, {
    sourceArticleId: master._id, sourceLanguage: 'gu', language: 'en', lang: 'en', originalLang: 'gu',
    publishedAt: new Date('2026-10-05'), createdAt: new Date('2026-10-05'),
    translationStatus: { en: 'pending' }, humanEdited: true,
  });
  const hindi = news(3, {
    sourceArticleId: master._id, sourceLanguage: 'gu', language: 'hi', lang: 'hi', originalLang: 'hi',
    publishedAt: new Date('2026-10-05'),
  });
  const latest = news(4, {
    language: 'en', lang: 'en', originalLang: 'en', publishedAt: new Date('2026-10-04'),
  });
  installFeedModels(t, { news: [english, hindi, latest, master] });
  const result = await list({ lang: 'en' });
  assert.equal(result.total, 2);
  assert.equal(result.items[0]._id, latest._id);
  assert.equal(result.items[1]._id, english._id);
  assert.equal(result.items[1].sourceLanguage, 'gu');
  assert.equal(result.items[1].displayLanguage, 'en');
  assert.equal(result.items[1].publishedAt.getTime(), master.publishedAt.getTime());
  assert.deepEqual(result.items[1].availableLocales, ['en', 'hi', 'gu']);
  assert.equal((await list({ lang: 'hi' })).total, 1);
});

test('a rejected published variant is not selected', async (t) => {
  const master = news(1);
  const rejected = news(2, {
    sourceArticleId: master._id, lang: 'en', language: 'en', originalLang: 'en', translationReviewStatus: 'rejected',
  });
  installFeedModels(t, { news: [master, rejected] });
  assert.equal((await list({ lang: 'en' })).total, 0);
});

test('current master denials cannot be bypassed by a published sibling or stale public copy', async (t) => {
  const future = new Date('2999-01-01');
  const denials = [
    ...['draft', 'scheduled', 'rejected', 'archived', 'deleted'].map((status) => ({ status })),
    { deletedAt: new Date('2026-01-01') }, { isPrivate: true }, { visibility: 'private' },
    { locked: true }, { embargoUntil: future }, { workflow: { locked: true } },
    { workflow: { embargoUntil: future } }, { publishedAt: future }, { publishAt: future }, { scheduledAt: future },
  ];
  const docs = [];
  for (const [index, denial] of denials.entries()) {
    const master = news(10 * index + 1, denial);
    docs.push(master, news(10 * index + 2, {
      sourceArticleId: master._id, lang: 'en', language: 'en', originalLang: 'en',
    }));
  }
  const copy = { ...docs[0], _id: 'public-copy', sourceNewsId: docs[0]._id, status: 'published', summary: 'Summary' };
  installFeedModels(t, { news: docs, copies: [copy] });
  assert.equal((await list({ lang: 'en' })).total, 0);
});

test('a reclassified master cannot leak into the old category through a stale sibling', async (t) => {
  const master = news(1, { category: 'national' });
  installFeedModels(t, { news: [master, news(2, {
    sourceArticleId: master._id, lang: 'en', language: 'en', originalLang: 'en',
  })] });
  assert.equal((await list({ lang: 'en' })).total, 0);
});

test('legacy consistent group keys can link a category-less published language sibling', async (t) => {
  installFeedModels(t, { news: [
    news(1, { translationKey: 'verified-legacy-group', translationGroupId: 'verified-legacy-group' }),
    news(2, {
      category: '', translationKey: 'verified-legacy-group', translationGroupId: 'verified-legacy-group',
      lang: 'en', language: 'en', originalLang: 'en',
    }),
  ] });
  const result = await list({ lang: 'en' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].category, 'regional');
});

test('explicit conflicting roots stay separate even when group keys and slugs collide', async (t) => {
  const roots = [news(1), news(4)];
  const docs = roots.flatMap((master, index) => [
    { ...master, translationKey: 'collision', slug: 'same-slug' },
    news(index * 3 + 2, {
      sourceArticleId: master._id, translationKey: 'collision', slug: 'same-slug',
      lang: 'en', language: 'en', originalLang: 'en',
    }),
  ]);
  installFeedModels(t, { news: docs });
  const result = await list({ lang: 'en' });
  assert.equal(result.total, 2);
  assert.equal(new Set(result.items.map((item) => item.storyGroupId)).size, 2);
});

test('invalid/conflicting keys and coincident slugs never merge unrelated stories', async (t) => {
  installFeedModels(t, { news: [
    news(1, { translationKey: 'null', slug: 'same' }), news(2, { translationKey: '', slug: 'same' }),
    news(3, { translationKey: 'a', translationGroupId: 'b' }),
    news(4, { translationKey: 'a', translationGroupId: 'c' }),
  ] });
  assert.equal((await list()).total, 4);
});

test('missing or cyclic source linkage fails closed', async (t) => {
  const first = news(1, { sourceArticleId: news(2)._id });
  installFeedModels(t, { news: [
    first, news(2, { sourceArticleId: first._id }), news(3, { sourceArticleId: news(999)._id }),
  ] });
  assert.equal((await list()).total, 0);
});

test('weak group-key collisions with multiple original-language records stay separate', async (t) => {
  installFeedModels(t, { news: [1, 2].map((number) => news(number, {
    translationKey: 'ambiguous-originals', sourceLanguage: 'gu',
    translations: { en: bucket('en') }, translationStatus: { en: 'ready' },
  })) });
  assert.equal((await list({ lang: 'en' })).total, 2);
});

test('a public descendant cannot bypass a private intermediate source', async (t) => {
  const root = news(1);
  const privateParent = news(2, { sourceArticleId: root._id, isPrivate: true });
  const descendant = news(3, {
    sourceArticleId: privateParent._id, lang: 'en', language: 'en', originalLang: 'en',
  });
  installFeedModels(t, { news: [root, privateParent, descendant] });
  assert.equal((await list({ lang: 'en' })).total, 0);
  assert.equal((await list()).total, 1);
});

test('pagination returns 30 final stories despite 105 raw variants', async (t) => {
  const docs = [];
  for (let index = 0; index < 35; index += 1) {
    const master = news(index * 3 + 1, {
      publishedAt: new Date(Date.UTC(2026, 8, index + 1)), sourceLanguage: 'gu',
      translations: { en: bucket('en') }, translationStatus: { en: 'ready' },
    });
    docs.push(master, ...['en', 'hi'].map((lang, offset) => news(index * 3 + offset + 2, {
      lang, language: lang, originalLang: lang, sourceArticleId: master._id, sourceLanguage: 'gu',
      publishedAt: new Date('2026-10-05'),
    })));
  }
  const captured = installFeedModels(t, { news: docs });
  const first = await list({ lang: 'en', limit: 30 });
  const second = await list({ lang: 'en', limit: 30, page: 2 });
  assert.equal(first.items.length, 30);
  assert.equal(first.total, 35);
  assert.equal(first.totalPages, 2);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 5);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.storyGroupId)).size, 35);
  assert.ok(captured.news.every((query) => query.limit === undefined && query.skip === undefined));
});

test('absent original dates use earliest verified sibling publication, then News creation; ties are stable', async (t) => {
  const master = news(1, { publishedAt: null, createdAt: new Date('2025-01-01') });
  const docs = [
    master,
    news(2, { sourceArticleId: master._id, publishedAt: new Date('2026-03-06') }),
    news(3, { sourceArticleId: master._id, publishedAt: new Date('2026-02-06') }),
    news(4, { publishedAt: null, createdAt: new Date('2026-01-01'), updatedAt: now }),
    news(5, { publishedAt: null, createdAt: new Date('2026-01-01'), updatedAt: now }),
    news(6, { publishedAt: null, createdAt: null, updatedAt: now }),
  ];
  installFeedModels(t, { news: docs.reverse() });
  const result = await list();
  assert.deepEqual(result.items.map((item) => item._id), [master._id, news(4)._id, news(5)._id, news(6)._id]);
  assert.equal(result.items[0].publishedAt.getTime(), new Date('2026-02-06').getTime());
  assert.equal(result.items[1].publishedAt, null);
  assert.equal(result.items[1].publicationTimeSource, 'createdAt');
  assert.equal(result.items[3].publicationTimeSource, 'missing');
});

test('missing/stale projection never hides News; compatibility IDs, slugs, media and dates are retained', async (t) => {
  const source = news(1, {
    slugs: { gu: 'news-gu', en: 'news-en' }, imageUrl: 'https://example.test/base.jpg',
    translations: { en: bucket('en') }, translationStatus: { en: 'ready' },
  });
  const copy = {
    _id: 'legacy-public-id', sourceNewsId: source._id, status: 'draft', category: 'national',
    slug: 'legacy-public-slug', slugs: { en: null, gu: 'legacy-gu' },
    coverImage: { url: 'https://example.test/locale.jpg', alt: 'Locale image' },
    createdAt: new Date('2026-10-05'), publishedAt: new Date('2026-10-05'), views: 12,
  };
  const before = JSON.stringify(copy);
  installFeedModels(t, { news: [source, news(2)], copies: [copy] });
  const result = await list({ lang: 'en' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0]._id, source._id);
  assert.equal(result.items[0].publicArticleId, copy._id);
  assert.equal(result.items[0].slugs.en, 'news-en');
  assert.equal(result.items[0].storedSlug, 'legacy-public-slug');
  assert.equal(result.items[0].imageUrl, copy.coverImage.url);
  assert.equal(result.items[0].publishedAt.getTime(), source.publishedAt.getTime());
  assert.equal((await list()).total, 2);
  assert.equal(JSON.stringify(copy), before);
});

test('public-only ready translations can fill absent caches but never override a current pending state', async (t) => {
  const sources = [news(1), news(2, { translationStatus: { en: 'pending' } }), news(3)];
  const copies = sources.map((source, index) => ({
    _id: `copy-${index}`, sourceNewsId: source._id, status: index === 2 ? 'draft' : 'published',
    translations: { en: bucket('en', { provider: 'manual' }) }, translationStatus: { en: 'ready' },
  }));
  installFeedModels(t, { news: sources, copies });
  const result = await list({ lang: 'en' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0]._id, sources[0]._id);
});

test('Regional canonically means Gujarat and keeps district/city from canonical and legacy fields', async (t) => {
  installFeedModels(t, { news: [
    news(1, { geo: { state: 'gujarat', district: 'ahmedabad', city: 'ahmedabad' } }),
    news(2, { tags: ['district:ahmedabad', 'city:vadodara'] }),
    news(3, { geo: { district: ' \t ', city: null }, location: { state: 'Gujarat', district: 'Surat', citySlug: 'surat' } }),
    news(4, { category: 'national', tags: ['state:gujarat', 'district:ahmedabad'], stateTags: ['gujarat'] }),
  ] });
  assert.equal((await list({ state: 'state:gujarat' })).total, 3);
  assert.equal((await list({ state: 'gujarat', district: 'district:ahmedabad' })).total, 2);
  const city = await list({ state: 'GJ', city: 'vadodara' });
  assert.equal(city.total, 1);
  assert.deepEqual(city.items[0].geo, { state: 'gujarat', district: 'ahmedabad', city: 'vadodara' });
  assert.equal((await list({ state: 'maharashtra' })).total, 0);
  assert.equal((await list({ district: 'surat' })).total, 1);
  assert.equal((await list({ district: 'all-districts', city: 'null' })).total, 3);
  assert.equal((await list({ category: 'national', nationalState: 'gujarat' })).total, 1);
});

test('invalid resolver requests are explicit errors, not successful empty feeds', async () => {
  for (const invalid of [{ category: 'pulse-dialogue' }, { lang: 'fr' }, { page: 0 }, { limit: 101 }]) {
    await assert.rejects(list(invalid), (error) => error.statusCode === 400);
  }
});

test('public serialization retains legacy aliases and media without exposing internal byline metadata', async (t) => {
  const source = news(1, {
    track: 'local', date: new Date('2025-12-01'), views: 42,
    authorByline: { enabled: true, snapshot: { name: 'Test Writer', internalNotes: 'not public' } },
    workflowHistory: [{ note: 'not public' }],
  });
  const copy = {
    _id: 'public-id', sourceNewsId: source._id, imageURL: 'https://example.test/legacy-language.jpg',
  };
  installFeedModels(t, { news: [source], copies: [copy] });
  const { items: [item] } = await list();
  assert.equal(item.track, source.track);
  assert.equal(item.date, source.date);
  assert.equal(item.views, 42);
  assert.equal(item.imageUrl, copy.imageURL);
  assert.equal(item.coverImage.url, copy.imageURL);
  assert.deepEqual(item.authorByline, { enabled: true, snapshot: { name: 'Test Writer' } });
  assert.equal(item.workflowHistory, undefined);
});
