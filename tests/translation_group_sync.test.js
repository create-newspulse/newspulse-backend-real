const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeContentFingerprint,
  prepareSourceSyncMetadata,
  buildChildNewsSyncPatch,
} = require('../services/translationGroupSync.service');

test('prepareSourceSyncMetadata stamps auto sync metadata and fingerprint', () => {
  const now = new Date('2026-03-29T10:00:00.000Z');
  const meta = prepareSourceSyncMetadata({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    translationGroupId: 'group-1',
    syncVersion: 4,
  }, { now });

  assert.equal(meta.syncMode, 'auto');
  assert.equal(String(meta.sourceArticleId), '69c832dfa5f8e74cf2bf87b7');
  assert.equal(meta.sourceLanguage, 'en');
  assert.equal(meta.lastSyncedAt.toISOString(), now.toISOString());
  assert.equal(meta.syncVersion, 5);
  assert.equal(typeof meta.contentFingerprint, 'string');
  assert.equal(meta.contentFingerprint.length, 64);
  assert.equal(meta.contentFingerprint, computeContentFingerprint({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    sourceLanguage: 'en',
  }));
});

test('buildChildNewsSyncPatch clears stale child content when translated locale is not ready', () => {
  const now = new Date('2026-03-29T11:00:00.000Z');
  const metadata = prepareSourceSyncMetadata({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body cleaned</p>',
    lang: 'en',
    status: 'published',
    category: 'tech',
    tags: ['science', 'water'],
    slugs: { en: 'master-en', hi: 'master-hi' },
    location: { state: 'Gujarat', stateSlug: 'gujarat' },
    translationGroupId: 'group-1',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body cleaned</p>' },
      hi: { title: '', summary: '', content: '' },
    },
    translationStatus: { en: 'ready', hi: 'pending' },
  }, { now });

  const patch = buildChildNewsSyncPatch({
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body cleaned</p>',
    lang: 'en',
    originalLang: 'en',
    status: 'published',
    category: 'tech',
    tags: ['science', 'water'],
    slugs: { en: 'master-en', hi: 'master-hi' },
    location: { state: 'Gujarat', stateSlug: 'gujarat' },
    translationGroupId: 'group-1',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body cleaned</p>' },
      hi: { title: '', summary: '', content: '' },
    },
    translationStatus: { en: 'ready', hi: 'pending' },
  }, {
    _id: '69c832dfa5f8e74cf2bf87b8',
    lang: 'hi',
    language: 'hi',
    originalLang: 'hi',
    status: 'published',
  }, { now, metadata });

  assert.equal(patch.status, 'draft');
  assert.equal(patch.title, '');
  assert.equal(patch.description, '');
  assert.equal(patch.content, '');
  assert.equal(patch.slug, 'master-hi');
  assert.equal(patch.category, 'tech');
  assert.deepEqual(patch.tags, ['science', 'water']);
  assert.equal(String(patch.sourceArticleId), '69c832dfa5f8e74cf2bf87b7');
  assert.equal(patch.sourceLanguage, 'en');
  assert.equal(patch.syncMode, 'auto');
  assert.equal(patch.syncVersion, metadata.syncVersion);
  assert.equal(patch.publishedAt, null);
});

test('buildChildNewsSyncPatch publishes localized child when translated bucket is ready and syncs shared fields', () => {
  const now = new Date('2026-03-29T12:00:00.000Z');
  const master = {
    _id: '69c832dfa5f8e74cf2bf87b7',
    title: 'Master title',
    description: 'Master summary',
    content: '<p>Master body</p>',
    lang: 'en',
    originalLang: 'en',
    status: 'published',
    publishedAt: new Date('2026-03-29T09:00:00.000Z'),
    category: 'tech',
    tags: ['science', 'water'],
    stateTags: ['state:gujarat'],
    stateNames: ['Gujarat'],
    slugs: { en: 'master-en', gu: 'master-gu' },
    coverImage: { url: 'https://example.com/cover.jpg', publicId: 'cover-1', alt: 'Cover' },
    coverImageUrl: 'https://example.com/cover.jpg',
    imageURL: 'https://example.com/cover.jpg',
    externalUrls: ['https://example.com/source'],
    embeds: ['https://youtube.com/embed/demo'],
    gallery: ['https://example.com/gallery-1.jpg'],
    seo: { metaTitle: 'SEO Title', metaDescription: 'SEO Description', canonicalUrl: 'https://newspulse.com/story' },
    location: { state: 'Gujarat', stateSlug: 'gujarat', city: 'Ahmedabad', citySlug: 'ahmedabad' },
    geo: { state: 'gujarat', city: 'ahmedabad' },
    translationGroupId: 'group-1',
    translations: {
      en: { title: 'Master title', summary: 'Master summary', content: '<p>Master body</p>' },
      gu: { title: 'ગુજરાતી શીર્ષક', summary: 'ગુજરાતી સાર', content: '<p>ગુજરાતી લેખ</p>', generatedAt: now, provider: 'google' },
    },
    translationStatus: { en: 'ready', gu: 'ready' },
  };
  const metadata = prepareSourceSyncMetadata(master, { now });
  const patch = buildChildNewsSyncPatch(master, {
    _id: '69c832dfa5f8e74cf2bf87b9',
    lang: 'gu',
    language: 'gu',
    originalLang: 'gu',
  }, { now, metadata });

  assert.equal(patch.status, 'published');
  assert.equal(patch.title, 'ગુજરાતી શીર્ષક');
  assert.equal(patch.description, 'ગુજરાતી સાર');
  assert.equal(patch.content, '<p>ગુજરાતી લેખ</p>');
  assert.equal(patch.slug, 'master-gu');
  assert.deepEqual(patch.seo, {
    metaTitle: 'SEO Title',
    metaDescription: 'SEO Description',
    canonicalUrl: 'https://newspulse.com/story',
  });
  assert.deepEqual(patch.externalUrls, ['https://example.com/source']);
  assert.deepEqual(patch.embeds, ['https://youtube.com/embed/demo']);
  assert.deepEqual(patch.gallery, ['https://example.com/gallery-1.jpg']);
  assert.deepEqual(patch.coverImage, { url: 'https://example.com/cover.jpg', publicId: 'cover-1', alt: 'Cover' });
  assert.equal(patch.publishedAt.toISOString(), '2026-03-29T09:00:00.000Z');
  assert.equal(patch.sourceLanguage, 'en');
});