const test = require('node:test');
const assert = require('node:assert/strict');

const PublicArticle = require('../models/Article');
const { syncPublicArticleFromNews } = require('../services/syncPublicArticleFromNews.service');

function regionalSource(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439101',
    title: 'Regional transport update',
    description: 'Transport summary',
    content: '<p>Transport details</p>',
    slug: 'regional-transport-update',
    category: 'regional',
    status: 'published',
    language: 'en',
    originalLang: 'en',
    publishedAt: new Date('2026-01-02T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    geo: { state: null, district: null, city: null },
    location: { state: 'Gujarat', district: 'Ahmedabad', city: 'Ahmedabad' },
    tags: ['desk:transport'],
    translationGroupId: 'regional-sync-group',
    translationKey: 'regional-sync-group',
    views: 87,
    ...overrides,
  };
}

function installPublicCopyStore(t, initialCopies = []) {
  const copies = initialCopies.map((copy) => ({ ...copy }));
  const writes = [];
  t.mock.method(PublicArticle, 'findOneAndUpdate', (filter, update, options) => ({
    lean: async () => {
      writes.push({ filter, update, options });
      let copy = copies.find((item) => filter.$or.some((clause) =>
        Object.entries(clause).every(([key, value]) => String(item[key]) === String(value))
      ));
      if (!copy) {
        assert.equal(options.upsert, true);
        copy = {
          _id: `507f1f77bcf86cd7994392${String(copies.length).padStart(2, '0')}`,
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
          ...update.$setOnInsert,
        };
        copies.push(copy);
      }
      Object.assign(copy, update.$set);
      for (const key of Object.keys(update.$unset || {})) delete copy[key];
      return { ...copy };
    },
  }));
  return { copies, writes };
}

test('Regional synchronization creates a missing copy and reuses its source identity on subsequent edits', async (t) => {
  const store = installPublicCopyStore(t);
  const source = regionalSource();
  const snapshot = JSON.stringify(source);
  const created = await syncPublicArticleFromNews(source);
  const updated = await syncPublicArticleFromNews({ ...source, title: 'Edited transport update', slug: 'explicitly-edited-slug' });

  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(store.copies.length, 1);
  assert.equal(updated._id, created._id);
  assert.equal(updated.sourceNewsId, source._id);
  assert.equal(updated.title, 'Edited transport update');
  assert.equal(updated.slug, 'explicitly-edited-slug');
  assert.deepEqual(updated.publishedAt, source.publishedAt);
  assert.deepEqual(updated.createdAt, created.createdAt);
  assert.deepEqual(store.writes[0].filter, { $or: [{ sourceNewsId: source._id }, { slug: source.slug }] });
  assert.equal(store.writes[0].options.runValidators, true);
});

test('Regional edits preserve an existing copy ID, publication date, creation date and analytics', async (t) => {
  const source = regionalSource();
  const existing = {
    _id: '507f1f77bcf86cd799439211',
    sourceNewsId: source._id,
    slug: source.slug,
    publishedAt: source.publishedAt,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    views: 42,
    analyticsId: 'unchanged-public-identity',
  };
  const store = installPublicCopyStore(t, [existing]);
  const result = await syncPublicArticleFromNews({
    ...source,
    title: 'Updated headline',
    content: '<p>Updated body</p>',
    coverImage: { url: 'https://images.example/updated.jpg', publicId: 'updated-cover', alt: 'Updated' },
    seo: { metaTitle: 'Updated SEO title' },
  });

  assert.equal(store.copies.length, 1);
  for (const key of ['_id', 'slug', 'createdAt', 'publishedAt', 'views', 'analyticsId']) {
    assert.deepEqual(result[key], existing[key], key);
  }
  assert.equal(result.status, 'published');
  assert.equal(result.title, 'Updated headline');
  assert.equal(result.content, '<p>Updated body</p>');
  assert.equal(result.coverImage.publicId, 'updated-cover');
  assert.equal(result.seo.metaTitle, 'Updated SEO title');
  for (const key of ['_id', 'createdAt', 'views', 'analyticsId']) {
    assert.equal(Object.hasOwn(store.writes[0].update.$set, key), false, key);
  }
});

test('a legacy slug-matched copy is linked in place rather than duplicated', async (t) => {
  const source = regionalSource();
  const store = installPublicCopyStore(t, [{ _id: '507f1f77bcf86cd799439212', slug: source.slug }]);
  const result = await syncPublicArticleFromNews(source);
  assert.equal(store.copies.length, 1);
  assert.equal(result._id, '507f1f77bcf86cd799439212');
  assert.equal(result.sourceNewsId, source._id);
});

for (const [label, metadata] of [
  ['display location with null geo', { location: { state: 'Gujarat', district: 'Ahmedabad', city: 'Gandhinagar' } }],
  ['location slug with null geo', { location: { state: null, stateSlug: 'gujarat', districtSlug: 'ahmedabad', citySlug: 'gandhinagar' } }],
  ['legacy state', { location: null, state: 'Gujarat', district: 'Ahmedabad', city: 'Gandhinagar' }],
  ['existing state tag with null geo', { location: null, tags: ['desk:transport', 'state:GJ', 'district:Ahmedabad', 'city:Gandhinagar'] }],
]) {
  test(`Regional sync canonicalizes ${label} without discarding existing tags`, async (t) => {
    installPublicCopyStore(t);
    const source = regionalSource(metadata);
    const result = await syncPublicArticleFromNews(source);
    assert.equal(result.geo.state, 'gujarat');
    assert.equal(result.geo.district, 'ahmedabad');
    assert.equal(result.geo.city, 'gandhinagar');
    assert.equal(result.state, 'Gujarat');
    assert.ok(result.tags.includes('state:gujarat'));
    assert.ok(source.tags.every((tag) => result.tags.includes(tag)));
  });
}

test('Regional synchronization does not infer Gujarat from article text or national stateTags', async (t) => {
  installPublicCopyStore(t);
  const result = await syncPublicArticleFromNews(regionalSource({
    title: 'Ahmedabad Gujarat transport update',
    location: null,
    stateTags: ['gujarat'],
    stateNames: ['Gujarat'],
  }));
  assert.equal(result.geo.state, null);
  assert.equal(result.state, null);
  assert.equal(result.tags.some((tag) => tag.startsWith('state:')), false);
});

test('missing source publishedAt does not reset an existing public publication date', async (t) => {
  const source = regionalSource({ publishedAt: null });
  const publishedAt = new Date('2026-01-02T00:00:00.000Z');
  const store = installPublicCopyStore(t, [{ _id: '507f1f77bcf86cd799439213', sourceNewsId: source._id, publishedAt }]);
  const result = await syncPublicArticleFromNews(source);
  assert.deepEqual(result.publishedAt, publishedAt);
  assert.equal(Object.hasOwn(store.writes[0].update.$set, 'publishedAt'), false);
  assert.ok(store.writes[0].update.$setOnInsert.publishedAt instanceof Date);
});

test('EN HI GU copies retain separate source links, manual translations and child-specific media', async (t) => {
  const store = installPublicCopyStore(t);
  const fetchMock = t.mock.method(global, 'fetch', async () => {
    assert.fail('Synchronization must not regenerate translations');
  });
  for (const [index, language] of ['en', 'hi', 'gu'].entries()) {
    const source = regionalSource({
      _id: `507f1f77bcf86cd7994393${String(index).padStart(2, '0')}`,
      slug: `regional-${language}`,
      language,
      lang: language,
      originalLang: language,
      sourceLanguage: 'gu',
      sourceArticleId: '507f1f77bcf86cd799439302',
      humanEdited: true,
      coverImage: { url: `https://images.example/${language}.jpg`, publicId: language, alt: language },
      translations: { en: { title: 'Manual title', summary: 'Manual summary', content: 'Manual content', provider: 'manual', generatedAt: new Date('2026-01-01T00:00:00.000Z') } },
      translationStatus: { en: 'ready', hi: 'pending', gu: 'ready' },
    });
    const before = JSON.stringify(source);
    const result = await syncPublicArticleFromNews(source);
    assert.equal(JSON.stringify(source), before);
    for (const key of ['language', 'originalLang', 'sourceLanguage', 'sourceArticleId', 'translationKey', 'translationGroupId', 'coverImage', 'translationStatus']) {
      assert.deepEqual(result[key], source[key], key);
    }
    assert.equal(result.sourceNewsId, source._id);
    assert.deepEqual(result.translations.en, source.translations.en);
  }
  assert.equal(store.copies.length, 3);
  assert.equal(new Set(store.copies.map((copy) => copy._id)).size, 3);
  assert.equal(fetchMock.mock.callCount(), 0);
});

for (const mode of ['throw', 'null', 'missing-slug']) {
  test(`public synchronization reports ${mode} safely and never returns a false copy`, async (t) => {
    const warnings = [];
    t.mock.method(PublicArticle, 'findOneAndUpdate', () => ({
      lean: async () => {
        if (mode === 'throw') throw new Error('sensitive-driver-detail-must-not-leak');
        return null;
      },
    }));
    const source = regionalSource(mode === 'missing-slug' ? { slug: '' } : {});
    const result = await syncPublicArticleFromNews(source, { logger: { warn: (...args) => warnings.push(args) } });
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][1].code, 'PUBLIC_ARTICLE_SYNC_FAILED');
    assert.equal(warnings[0][1].sourceNewsId, source._id);
    assert.equal(JSON.stringify(warnings).includes('sensitive-driver-detail'), false);
  });
}

test('syncPublicArticleFromNews clears stale deletedAt when source news is published', async () => {
  const originalFindOneAndUpdate = PublicArticle.findOneAndUpdate;

  try {
    let lastUpdate = null;

    PublicArticle.findOneAndUpdate = (_query, update) => {
      lastUpdate = update;
      return {
        lean: async () => ({ _id: 'public-1' }),
      };
    };

    await syncPublicArticleFromNews({
      _id: '69c8273fa5f8e74cf2bf7819',
      title: 'Published story',
      description: 'Summary',
      content: '<p>Body</p>',
      slug: 'published-story',
      slugs: {
        en: 'published-story-en',
        hi: 'published-story-hi',
        gu: 'published-story-gu',
      },
      category: 'national',
      track: 'student-voices',
      tags: ['desk:youth-pulse'],
      status: 'published',
      lang: 'gu',
      language: 'gu',
      originalLang: 'gu',
      sourceLanguage: 'gu',
      translationStatus: { en: 'ready', hi: 'ready', gu: 'ready' },
      translations: {
        en: { title: 'Published story', summary: 'Summary', content: '<p>Body</p>' },
        hi: { title: 'प्रकाशित कहानी', summary: 'सारांश', content: '<p>लेख</p>' },
        gu: { title: 'પ્રકાશિત વાર્તા', summary: 'સારાંશ', content: '<p>લેખ</p>' },
      },
      publishedAt: new Date('2026-03-31T19:04:23.859Z'),
      deletedAt: new Date('2026-03-31T17:40:39.175Z'),
    });

    assert.ok(lastUpdate);
    assert.equal(lastUpdate.$set.status, 'published');
    assert.equal(lastUpdate.$set.deletedAt, null);
    assert.equal(lastUpdate.$set.track, 'student-voices');
    assert.deepEqual(lastUpdate.$set.tags, ['desk:youth-pulse', 'track:student-voices']);
    assert.equal(lastUpdate.$set.spotlightEnabled, false);
    assert.equal(lastUpdate.$set.spotlightPinned, false);
    assert.equal(lastUpdate.$set.spotlightPriority, 'normal');
    assert.equal(lastUpdate.$set.spotlightExpiresAt, null);
  } finally {
    PublicArticle.findOneAndUpdate = originalFindOneAndUpdate;
  }
});

test('syncPublicArticleFromNews copies Spotlight fields to the public article', async () => {
  const originalFindOneAndUpdate = PublicArticle.findOneAndUpdate;

  try {
    let lastUpdate = null;

    PublicArticle.findOneAndUpdate = (_query, update) => {
      lastUpdate = update;
      return {
        lean: async () => ({ _id: 'public-spotlight-1' }),
      };
    };

    const expiresAt = new Date('2026-05-01T12:00:00.000Z');

    await syncPublicArticleFromNews({
      _id: '69c8273fa5f8e74cf2bf7820',
      title: 'Spotlight story',
      description: 'Summary',
      content: '<p>Body</p>',
      slug: 'spotlight-story',
      category: 'national',
      status: 'published',
      lang: 'en',
      language: 'en',
      originalLang: 'en',
      spotlightEnabled: true,
      spotlightPinned: true,
      spotlightPriority: 'important',
      spotlightExpiresAt: expiresAt,
      publishedAt: new Date('2026-03-31T19:04:23.859Z'),
    });

    assert.ok(lastUpdate);
    assert.equal(lastUpdate.$set.spotlightEnabled, true);
    assert.equal(lastUpdate.$set.spotlightPinned, true);
    assert.equal(lastUpdate.$set.spotlightPriority, 'important');
    assert.equal(lastUpdate.$set.spotlightExpiresAt, expiresAt);
  } finally {
    PublicArticle.findOneAndUpdate = originalFindOneAndUpdate;
  }
});